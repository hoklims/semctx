"""Acquire unadapted Windows raw evidence under an externally enrolled envelope.

The enrolled input-manifest digest is the orchestration trust anchor. The native
review is an owner's attestation, not independent proof of prior correctness.
The producer stays unchanged. The separately enrolled tooling supplies the collector.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

SOURCE = '3309e011184893b41b97491622fd31880982cab6'
PROTOCOL = 'c4e8cc4c2431c0250cefd4ee61e846c4c0eebcd188198e6bab7d11d5beb18303'
SDK = 'f57257876a383d13839a94adefb42b3d40bad2e93489a0f1a5ab29f045f139e5'
AUTHORITY = 'owner-reviewed-macos-linux-authorizes-windows-observation'
REPOSITORY = 'hoklims/semctx'
REPOSITORY_ID = '1289209764'
BUNDLE = 'docs/research/rust-ts-r0/evidence/windows-acquisition-20261128'
FILES = {'manifest.json', 'protocol.json.gz', 'native-review.json', 'windows-envelope.json'}
COUNTS = {'original': 1, 'supplement': 1, 'as_expression': 2}
RAW_REPORTS = {'original-evidence/report.json', 'original-evidence/obligation-closure.json',
    'supplement-evidence/source-results.json', 'supplement-evidence/addenda-results.json',
    'supplement-evidence/public/public-report.json', 'supplement-evidence/supplement-report.json',
    'supplement-evidence/token-results.json', 'supplement-evidence/token-guards/process-outcome.json',
    'supplement-evidence/token-guards/token-report.json'}
QUALIFICATION = 'tools/rust-ts-r0/qualification'
MAX_JSON = 2 * 1024 * 1024
MAX_PROTOCOL = 16 * 1024 * 1024
MAX_ARCHIVE = 256 * 1024 * 1024
BOOTSTRAP = '''import pathlib,runpy,sys
directory=pathlib.Path(sys.argv[1]);script=pathlib.Path(sys.argv[2])
assert script.is_file()
sys.path.insert(0,str(directory));sys.argv=sys.argv[2:]
runpy.run_path(str(script),run_name="__main__")'''


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def sha(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def identity(value, length):
    return isinstance(value, str) and len(value) == length and value != '0' * length and re.fullmatch('[0-9a-f]+', value) is not None


def no_links(path):
    path = Path(path).absolute()
    for item in [path, *path.parents]:
        if item.exists() or item.is_symlink():
            value = item.lstat()
            require(not item.is_symlink() and not (getattr(value, 'st_file_attributes', 0) & 0x400), 'link/reparse path refused')
    return path


def regular(path):
    path = no_links(path)
    value = path.lstat()
    require(stat.S_ISREG(value.st_mode) and value.st_nlink == 1, 'regular unlinked file required')
    return path


def regular_tree(root):
    files, errors, pending = [], [], [Path(root)]
    while pending:
        directory = pending.pop()
        try:
            no_links(directory)
            children = sorted(directory.iterdir())
        except (OSError, ValueError) as error:
            errors.append({'path': str(directory), 'error': str(error)})
            continue
        for path in children:
            try:
                no_links(path)
                if path.is_dir():
                    pending.append(path)
                else:
                    files.append(regular(path))
            except (OSError, ValueError) as error:
                errors.append({'path': str(path), 'error': str(error)})
    return files, errors


def load_object(path):
    raw = regular(path).read_bytes()
    require(len(raw) <= MAX_JSON, 'JSON byte limit exceeded')

    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'duplicate JSON field: ' + key)
            value[key] = item
        return value

    value = json.loads(raw, object_pairs_hook=unique)
    require(isinstance(value, dict), 'JSON object required')
    return value


def keys(value, expected, label):
    require(isinstance(value, dict) and set(value) == set(expected), label + ' fields differ')


def version(value, kind):
    require(type(value.get('schema_version')) is int and value['schema_version'] == 1 and value.get('kind') == kind, 'unsupported schema/kind')


def git(repo, *args):
    return subprocess.check_output(['git', *args], cwd=repo, timeout=60)


def snapshot(repo, expected, only=None):
    repo = no_links(repo).resolve(strict=True)
    require(identity(expected, 40), 'exact checkout identity required')
    require(git(repo, 'rev-parse', 'HEAD').decode().strip() == expected, 'checkout HEAD differs')
    require(not git(repo, 'replace', '-l').strip(), 'Git replace refs refused')
    grafts = git(repo, 'rev-parse', '--git-path', 'info/grafts').decode().strip()
    require(not (repo / grafts).exists(), 'Git grafts refused')
    require(not git(repo, 'status', '--porcelain=v1', '--untracked-files=all').strip(), 'checkout is dirty')
    entries = [v for v in git(repo, 'ls-files', '-v', '-z').split(b'\0') if v]
    require(all(v.startswith(b'H ') for v in entries), 'hidden index flags refused')
    selected = set(only) if only is not None else None
    files = {}
    for record in git(repo, 'ls-tree', '-rz', 'HEAD').split(b'\0'):
        if not record:
            continue
        meta, raw_name = record.split(b'\t', 1)
        mode, kind, blob = meta.decode('ascii').split()
        name = raw_name.decode('utf-8')
        if selected is not None and name not in selected:
            continue
        relative = PurePosixPath(name)
        require(not relative.is_absolute() and '..' not in relative.parts and kind == 'blob' and mode in {'100644', '100755'}, 'foreign tracked path/type')
        raw = regular(repo / name).read_bytes()
        require(hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == blob, 'tracked Git blob differs: ' + name)
        files[name] = digest(raw)
    require(selected is None or set(files) == selected, 'required tracked inputs absent')
    return {'head': expected, 'files': files}


def run_context(environment, campaign):
    require(environment.get('GITHUB_EVENT_NAME') == 'workflow_dispatch', 'manual event required')
    require(environment.get('GITHUB_REPOSITORY') == REPOSITORY and environment.get('GITHUB_REPOSITORY_ID') == REPOSITORY_ID, 'repository identity differs')
    require(environment.get('WINDOWS_R0_REPOSITORY_PRIVATE') == 'false', 'standard public-repository route required')
    require(environment.get('GITHUB_RUN_ATTEMPT') == '1', 'workflow rerun refused')
    require(re.fullmatch('[a-z][a-z0-9-]{0,63}', campaign or '') is not None, 'campaign ID differs from data grammar')
    tooling = environment.get('WINDOWS_R0_TOOLING_SHA', '')
    manifest = environment.get('WINDOWS_R0_INPUT_MANIFEST_SHA256', '')
    require(identity(tooling, 40) and identity(manifest, 64), 'externally enrolled tooling/manifest required')
    require(environment.get('WINDOWS_R0_WORKFLOW_SHA') == tooling, 'workflow/tooling enrollment differs')
    run_id = environment.get('GITHUB_RUN_ID', '')
    require(run_id.isdecimal() and int(run_id) > 0, 'workflow run identity required')
    return {'tooling': tooling, 'manifest': manifest, 'campaign': campaign, 'run_id': run_id}


def validate_bundle(folder, context):
    folder = no_links(folder).resolve(strict=True)
    require({p.name for p in folder.iterdir()} == FILES, 'input bundle file set differs')
    for name in FILES:
        regular(folder / name)
    require(sha(folder / 'manifest.json') == context['manifest'], 'enrolled input manifest differs')
    manifest = load_object(folder / 'manifest.json')
    keys(manifest, ['schema_version', 'kind', 'source_head', 'tooling_head', 'campaign_id', 'files'], 'manifest')
    version(manifest, 'WINDOWS_R0_PUBLIC_INPUT_BUNDLE')
    require(manifest['source_head'] == SOURCE and manifest['tooling_head'] == context['tooling'] and manifest['campaign_id'] == context['campaign'], 'bundle source/tooling/campaign differs')
    keys(manifest['files'], FILES - {'manifest.json'}, 'file pins')
    for name, value in manifest['files'].items():
        require(identity(value, 64) and sha(folder / name) == value, 'bundled file pin differs: ' + name)
    compressed = folder / 'protocol.json.gz'
    require(compressed.stat().st_size <= 8 * 1024 * 1024, 'compressed protocol byte limit exceeded')
    with gzip.open(compressed, 'rb') as stream:
        protocol = stream.read(MAX_PROTOCOL + 1)
    require(len(protocol) <= MAX_PROTOCOL and digest(protocol) == PROTOCOL, 'exact protocol bytes differ')
    review = load_object(folder / 'native-review.json')
    keys(review, ['schema_version', 'kind', 'source_head', 'protocol_sha256', 'authority', 'decision', 'hosts', 'qualified', 'qualification_credit'], 'review')
    version(review, 'OWNER_REVIEWED_NATIVE_PREREQUISITES')
    require(review['source_head'] == SOURCE and review['protocol_sha256'] == PROTOCOL, 'review source/protocol differs')
    require(review['authority'] == 'owner-root' and review['decision'] == 'AUTHORIZE_WINDOWS_RAW_ACQUISITION', 'native review authority absent')
    require(review['qualified'] is False and type(review['qualification_credit']) is int and review['qualification_credit'] == 0, 'review cannot qualify R0')
    keys(review['hosts'], ['macos', 'linux'], 'review hosts')
    for host in review['hosts'].values():
        keys(host, ['source_head', 'protocol_sha256', 'evidence_sha256', 'reviewed'], 'host review')
        require(host['source_head'] == SOURCE and host['protocol_sha256'] == PROTOCOL and host['reviewed'] is True and identity(host['evidence_sha256'], 64), 'native host review incomplete')
    envelope = load_object(folder / 'windows-envelope.json')
    keys(envelope, ['schema_version', 'kind', 'source_head', 'protocol_sha256', 'sdk_sha256', 'tooling_head', 'campaign_id', 'platform', 'output_relative', 'run_attempt', 'root_authority', 'prior_native_review_sha256', 'counts', 'retries', 'execution_authorized', 'reserved_cases_authorized', 'new_spend_authorized', 'timeout_seconds'], 'envelope')
    version(envelope, 'WINDOWS_R0_EXECUTION_ENVELOPE')
    require(envelope['source_head'] == SOURCE and envelope['protocol_sha256'] == PROTOCOL and envelope['sdk_sha256'] == SDK and envelope['tooling_head'] == context['tooling'], 'envelope source/protocol/SDK/tooling differs')
    require(envelope['campaign_id'] == context['campaign'] and envelope['platform'] == 'windows' and envelope['output_relative'] == 'windows-raw/' + context['campaign'], 'envelope campaign/platform/output differs')
    require(type(envelope['run_attempt']) is int and envelope['run_attempt'] == 1 and type(envelope['retries']) is int and envelope['retries'] == 0, 'envelope retries refused')
    require(envelope['root_authority'] == AUTHORITY and envelope['prior_native_review_sha256'] == sha(folder / 'native-review.json'), 'envelope review/grant differs')
    require(envelope['execution_authorized'] is True and envelope['reserved_cases_authorized'] is False and envelope['new_spend_authorized'] is False, 'execution grant incomplete')
    require(set(envelope['counts']) == set(COUNTS) and all(type(envelope['counts'][k]) is int and envelope['counts'][k] == v for k, v in COUNTS.items()), 'exact four collection counts required')
    require(type(envelope['timeout_seconds']) is int and 60 <= envelope['timeout_seconds'] <= 3600, 'bounded collector timeout required')
    return {'protocol': protocol, 'envelope': envelope, 'review_sha256': sha(folder / 'native-review.json'), 'bundle_pins': {p: sha(folder / p) for p in sorted(FILES)}}


def validate_all(args, context):
    require(identity(args.input_commit, 40), 'exact public-input commit required')
    workspace = no_links(args.workspace).resolve(strict=True)
    roots = [no_links(p).resolve(strict=True) for p in [args.tooling, args.producer, args.inputs]]
    require(len(set(roots)) == 3 and all(not a.is_relative_to(b) for i, a in enumerate(roots) for j, b in enumerate(roots) if i != j), 'separate checkout roots required')
    require(all(p.is_relative_to(workspace) and p != workspace for p in roots), 'checkout outside workspace')
    require((roots[0] / QUALIFICATION / 'acquire_windows_raw.py').resolve() == Path(__file__).resolve(), 'wrapper must execute from enrolled tooling checkout')
    folder = roots[2] / BUNDLE
    data = validate_bundle(folder, context)
    before = {'tooling': snapshot(roots[0], context['tooling']), 'producer': snapshot(roots[1], SOURCE),
              'inputs': snapshot(roots[2], args.input_commit, [BUNDLE + '/' + n for n in FILES])}
    require(not (workspace / data['envelope']['output_relative']).exists() and not (workspace / 'windows-control' / context['campaign']).exists(), 'existing output/attempt refused')
    return {'workspace': workspace, 'tooling': roots[0], 'producer': roots[1], 'inputs': roots[2], 'folder': folder, 'before': before, **data}


def check_dispatch_history(context, fetch_page=None):
    def fetch(page):
        token = os.environ.get('GITHUB_TOKEN', '')
        require(bool(token), 'read-only Actions history token unavailable')
        url = f'https://api.github.com/repos/{REPOSITORY}/actions/workflows/windows-r0-acquisition.yml/runs?event=workflow_dispatch&per_page=100&page={page}'
        request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                require(response.status == 200, 'Actions history unavailable')
                return json.load(response)
        except (OSError, urllib.error.HTTPError) as error:
            raise ValueError('Actions history unavailable') from error

    seen = set()
    for page in range(1, 101):
        value = (fetch_page or fetch)(page)
        require(isinstance(value, dict) and isinstance(value.get('workflow_runs'), list), 'unknown Actions history response')
        runs = value['workflow_runs']
        for run in runs:
            require(isinstance(run, dict) and type(run.get('id')) is int and run['id'] > 0, 'unknown Actions run identity')
            require(run['id'] not in seen, 'unstable Actions history pagination')
            seen.add(run['id'])
            if str(run['id']) != context['run_id']:
                require(not (run.get('display_title') == 'Windows RAW ' + context['campaign'] and run.get('head_sha') == context['tooling']), 'campaign was already dispatched')
        if len(runs) < 100:
            require(int(context['run_id']) in seen, 'current dispatch absent from Actions history')
            return {'pages': page, 'runs_inspected': len(seen), 'current_run_id': context['run_id']}
    raise ValueError('Actions history pagination incomplete')


def collector_environment(parent):
    forbidden = ['GIT_CONFIG_GLOBAL', 'GOPORT_BUILD_VERSION', 'CARGO_TARGET_DIR', 'RUSTC_WRAPPER', 'NODE_OPTIONS', 'NODE_PATH']
    require(all(name not in parent for name in forbidden), 'unsafe native environment override')
    allowed = {'PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'CARGO_HOME', 'RUSTUP_HOME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL', 'TZ', 'INCLUDE', 'LIB', 'LIBPATH', 'VSINSTALLDIR', 'VCINSTALLDIR', 'VCToolsInstallDir', 'WindowsSdkDir', 'WindowsSDKVersion', 'UniversalCRTSdkDir', 'UCRTVersion', 'VSCMD_ARG_TGT_ARCH', 'VSCMD_ARG_HOST_ARCH'}
    result = {k: v for k, v in parent.items() if k in allowed}
    result.update(RUSTUP_TOOLCHAIN='1.95.0', CARGO_NET_OFFLINE='true', CARGO_BUILD_JOBS='2', RUST_TEST_THREADS='1', GOPORT_LIB_PARSE_SNAPSHOT='0', GOPORT_LIB_SNAPSHOT='0', PYTHONDONTWRITEBYTECODE='1')
    return result


def runtime_metadata(node):
    require(platform.system() == 'Windows' and platform.machine().lower() in {'amd64', 'x86_64'}, 'native standard Windows x64 required')
    require(sys.version_info[:3] == (3, 13, 16), 'Python3.13.16 required')
    node = regular(node).resolve(strict=True)
    raw = node.read_bytes()
    require(raw[:2] == b'MZ' and len(raw) >= 64, 'native Node PE executable required')
    offset = int.from_bytes(raw[60:64], 'little')
    require(raw[offset:offset + 4] == b'PE\0\0' and int.from_bytes(raw[offset + 4:offset + 6], 'little') == 0x8664, 'native Node x64 executable required')
    observed = subprocess.check_output([str(node), '--version'], env=collector_environment(os.environ), timeout=30).decode().strip()
    require(observed == 'v24.22.0', 'Node24.22.0 required')
    return {'node_path': str(node), 'node_sha256': digest(raw), 'node_version': observed,
            'python_path': sys.executable, 'python_sha256': sha(sys.executable), 'python_version': platform.python_version(), 'platform': platform.platform()}


def save(path, value):
    Path(path).write_text(json.dumps(value, sort_keys=True, indent=2) + '\n', encoding='utf-8', newline='\n')


def run_process(argv, cwd, env, directory, label, timeout):
    directory = Path(directory)
    stdout, stderr = directory / (label + '.stdout'), directory / (label + '.stderr')
    require(not stdout.exists() and not stderr.exists(), 'process retry refused')
    timed_out = False
    start = time.monotonic()
    process, code, error = None, 1, None
    with stdout.open('xb') as out, stderr.open('xb') as err:
        try:
            process = subprocess.Popen(argv, cwd=cwd, env=env, stdout=out, stderr=err,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0,
                start_new_session=os.name != 'nt')
            try:
                code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                code = 124
                if os.name == 'nt':
                    cleanup = subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
                    (directory / (label + '.taskkill.stdout')).write_bytes(cleanup.stdout)
                    (directory / (label + '.taskkill.stderr')).write_bytes(cleanup.stderr)
                else:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                process.wait(timeout=30)
        except (OSError, subprocess.SubprocessError) as failure:
            error = str(failure)
            if process is not None and process.poll() is None:
                try:
                    process.kill()
                    process.wait(timeout=30)
                except (OSError, subprocess.SubprocessError) as cleanup_failure:
                    error += '; final cleanup: ' + str(cleanup_failure)
    record = {'argv': argv, 'exit_code': code, 'timed_out': timed_out, 'attempt': 1,
              'elapsed_seconds': time.monotonic() - start, 'pid': process.pid if process else None,
              'process_started': process is not None, 'error': error,
              'stdout_sha256': sha(stdout), 'stderr_sha256': sha(stderr),
              'cleanup_scope': 'owned PID tree on timeout; no universal quiescence assertion'}
    save(directory / (label + '.receipt.json'), record)
    return record


def isolated(producer, filename, arguments, script=None):
    directory = producer / QUALIFICATION
    tracked = {p.decode() for p in git(producer, 'ls-files', '-z', '--', QUALIFICATION).split(b'\0') if p}
    files, errors = regular_tree(directory)
    require(not errors, 'unsafe Python import tree')
    for path in files:
        if path.suffix.lower() in {'.py', '.pyc', '.pyd', '.so', '.zip'}:
            require(path.relative_to(producer).as_posix() in tracked, 'untracked Python import surface refused')
    script = regular(script or directory / filename).resolve(strict=True)
    return [sys.executable, '-I', '-S', '-B', '-c', BOOTSTRAP, str(directory), str(script), *arguments]


def protocol_check(plan, protocol_path, control, env, label):
    isolated(plan['producer'], 'run_windows_milestone.py', [])
    # This verifier has its own sibling import directory, separately verified by snapshot.
    directory = plan['producer'] / QUALIFICATION / 'property_assessor'
    argv = [sys.executable, '-I', '-S', '-B', '-c', BOOTSTRAP, str(directory), str(directory / 'check_protocol.py'),
            '--repo', str(plan['producer']), '--source-head', SOURCE, '--scope-map', str(protocol_path), '--protocol-sha256', PROTOCOL]
    result = run_process(argv, plan['producer'], env, control, label, 120)
    require(result['exit_code'] == 0 and not result['timed_out'], 'source/corpus protocol preflight failed')
    return result


def postflight(plan, args, context):
    after = {'tooling': snapshot(plan['tooling'], context['tooling']), 'producer': snapshot(plan['producer'], SOURCE),
             'inputs': snapshot(plan['inputs'], args.input_commit, [BUNDLE + '/' + n for n in FILES])}
    require(after == plan['before'], 'checkout drift after collector')
    require(validate_bundle(plan['folder'], context)['bundle_pins'] == plan['bundle_pins'], 'public bundle drift')
    return after


def complete_raw(output, review_sha):
    summary = load_object(output / 'acquisition-summary.json')
    require(summary.get('source_head') == SOURCE and summary.get('qualified') is False and type(summary.get('qualification_credit')) is int and summary['qualification_credit'] == 0, 'collector summary identity/credit differs')
    require(type(summary.get('attempts')) is int and summary['attempts'] == 1 and summary.get('root_prior_review_reference_sha256') == review_sha, 'collector attempts/review differ')
    for name in ['original', 'supplement']:
        require(type(summary.get(name + '_exit_code')) is int and summary[name + '_exit_code'] == 0, 'collector phase failed')
        receipt = load_object(output / (name + '-native.receipt.json'))
        require(type(receipt.get('exit_code')) is int and receipt['exit_code'] == 0 and receipt.get('timed_out') is False and type(receipt.get('attempt')) is int and receipt['attempt'] == 1, 'raw phase outcome incomplete')
    require(isinstance(summary.get('reports'), dict) and set(summary['reports']) == RAW_REPORTS, 'raw reports incomplete')
    for name, pin in summary['reports'].items():
        relative = PurePosixPath(name)
        require(not relative.is_absolute() and '..' not in relative.parts and identity(pin, 64), 'foreign raw report path')
        require(sha(regular(output / name)) == pin, 'raw report bytes differ')
    additional = summary.get('additional_as_expression_witness', {})
    path = regular(additional.get('path', '')).resolve(strict=True)
    require(path.is_relative_to(output) and sha(path) == additional.get('sha256'), 'as-expression report binding differs')
    report = load_object(path)
    require(report.get('source_head') == SOURCE and report.get('platform') == 'windows' and report.get('postflight_ok') is True, 'as-expression postflight incomplete')
    for name in ['expected_candidate_phases', 'candidate_phases_completed', 'candidate_outcomes_recorded']:
        require(type(report.get(name)) is int and report[name] == 2, 'exact two as-expression queries required')
    require(report.get('caller_invocations_attempted') == ['legacy', 'retained'], 'exact two as-expression queries required')
    contexts = report.get('contexts', [])
    require(type(report.get('attempts')) is int and report['attempts'] == 1 and isinstance(contexts, list) and len(contexts) == 2
            and [item.get('context') for item in contexts if isinstance(item, dict)] == ['legacy', 'retained'], 'as-expression attempts/contexts differ')
    return {'counts': COUNTS, 'counts_scope': 'top-level original/supplement collections and two frozen additional queries; not total internal native subprocess count', 'collector_summary_sha256': sha(output / 'acquisition-summary.json')}


class CappedFile(io.FileIO):
    def __init__(self, path, limit):
        super().__init__(path, 'w+b')
        self.limit = limit

    def write(self, value):
        require(self.tell() + len(value) <= self.limit, 'compressed archive byte limit exceeded')
        return super().write(value)


def archive_raw(control, output, archive, limit=MAX_ARCHIVE):
    no_links(archive.parent)
    archive.parent.mkdir(parents=True, exist_ok=True)
    require(not archive.exists(), 'archive retry refused')
    files, input_errors = [], []
    for root, prefix in [(control, 'control'), (output, 'raw')]:
        if not root.exists():
            continue
        discovered, errors = regular_tree(root)
        input_errors.extend(errors)
        for path in discovered:
            if path.name != 'result.json':
                files.append((path, prefix + '/' + path.relative_to(root).as_posix()))
    try:
        with CappedFile(archive, limit) as bounded, zipfile.ZipFile(bounded, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
            for path, name in files:
                bundle.write(path, name)
            if input_errors:
                bundle.writestr('ARCHIVE-INPUT-ERRORS.json', json.dumps({'complete': False, 'errors': input_errors}))
        return {'complete': not input_errors, 'input_errors': input_errors, 'path': str(archive), 'sha256': sha(archive), 'bytes': archive.stat().st_size, 'files': len(files)}
    except (OSError, ValueError, zipfile.BadZipFile):
        archive.unlink(missing_ok=True)
        # Preserve complete small logs/metadata, never silently truncate a file.
        included = 0
        with CappedFile(archive, limit) as bounded, zipfile.ZipFile(bounded, 'w', zipfile.ZIP_STORED) as bundle:
            for path, name in sorted(files, key=lambda pair: (not pair[1].startswith('control/'), pair[1]))[:1000]:
                if path.stat().st_size + bounded.tell() + 2 * len(name.encode()) + 1024 < limit - 1024 and path.stat().st_size <= 8 * 1024 * 1024:
                    bundle.write(path, name)
                    included += 1
            bundle.writestr('ARCHIVE-INCOMPLETE.json', json.dumps({'complete': False, 'omitted_files': len(files) - included, 'rejected_paths': len(input_errors), 'reason': 'Compressed cap or file read failed; full raw remains on runner; no complete acquisition claim'}))
        return {'complete': False, 'path': str(archive), 'sha256': sha(archive), 'bytes': archive.stat().st_size, 'included_files': included, 'omitted_files': len(files) - included}


def acquire(args, context, plan, *, process_runner=run_process):
    workspace = plan['workspace']
    control = no_links(workspace / 'windows-control' / context['campaign'])
    output = no_links(workspace / plan['envelope']['output_relative'])
    require(not output.exists() and not control.exists(), 'existing output/attempt refused')
    control.mkdir(parents=True)
    save(control / 'wrapper-source-before.json', plan['before'])
    protocol_path = control / 'protocol.json'
    protocol_path.write_bytes(plan['protocol'])
    result = {'schema_version': 1, 'source_head': SOURCE, 'protocol_sha256': PROTOCOL, 'tooling_head': context['tooling'],
              'input_commit': args.input_commit, 'campaign_id': context['campaign'], 'run_id': context['run_id'],
              'state': 'ACQUISITION_FAILED', 'qualified': False, 'qualification_credit': 0, 'R0_decision': None,
              'prior_review_is_orchestration_authority_only': True, 'prior_native_correctness_independently_verified': False,
              'allowed_collection_counts': COUNTS, 'collector_invocations': 0, 'collector_invocation_attempts': 0, 'attempt': 1, 'retries': 0}
    code = 1
    try:
        result['history'] = check_dispatch_history(context)
        result['runtime'] = runtime_metadata(args.node)
        env = collector_environment(os.environ)
        result['preflight'] = protocol_check(plan, protocol_path, control, env, 'protocol-preflight')
        save(control / 'collection-intent.json', {'source_head': SOURCE, 'counts': COUNTS, 'attempt': 1, 'retries': 0, 'root_review_sha256': plan['review_sha256']})
        argv = isolated(plan['producer'], 'run_windows_milestone.py', ['--repo', str(plan['producer']), '--output', str(output), '--expected-head', SOURCE,
            '--node', str(args.node.resolve()), '--root-authority', AUTHORITY, '--prerequisite-proof-sha256', plan['review_sha256'], '--execute-native-campaigns'],
            script=plan['tooling'] / QUALIFICATION / 'run_windows_milestone.py')
        result['collector_invocation_attempts'] = 1
        record = process_runner(argv, plan['producer'], env, control, 'collector', plan['envelope']['timeout_seconds'])
        result['collector_invocations'] = int(record.get('process_started') is True)
        result['collector'] = record
        code = (record['exit_code'] if record['exit_code'] >= 0 else 128 - record['exit_code']) if type(record['exit_code']) is int and record['exit_code'] != 0 else 1
        require(type(record['exit_code']) is int and record['exit_code'] == 0 and record['timed_out'] is False, 'collector failed or timed out; raw retained')
        result['raw_shape'] = complete_raw(output, plan['review_sha256'])
        result['state'] = 'RAW_ACQUIRED_UNADAPTED_REVIEW_PENDING'
        code = 0
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        result['error'] = str(error)
    finally:
        try:
            save(control / 'wrapper-source-after.json', postflight(plan, args, context))
            result['postflight'] = protocol_check(plan, protocol_path, control, collector_environment(os.environ), 'protocol-postflight')
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            result['state'] = 'ACQUISITION_FAILED_POSTFLIGHT'
            result['postflight_error'] = str(error)
            if code == 0:
                code = 1
        save(control / 'acquisition-state.json', result)
        try:
            result['archive'] = archive_raw(control, output, workspace / 'windows-artifacts' / (context['campaign'] + '.zip'))
            if not result['archive']['complete']:
                result['state'] = 'ACQUISITION_FAILED_ARCHIVE_INCOMPLETE'
                if code == 0:
                    code = 1
        except (OSError, ValueError, zipfile.BadZipFile) as error:
            result['archive_error'] = str(error)
            result['state'] = 'ACQUISITION_FAILED_ARCHIVE'
            if code == 0:
                code = 1
        result['exit_code'] = code
        save(control / 'result.json', result)
    return code, result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['tooling', 'producer', 'inputs', 'workspace', 'node']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--input-commit', required=True)
    parser.add_argument('--campaign-id', required=True)
    parser.add_argument('--preflight-only', action='store_true')
    args = parser.parse_args(argv)
    acquisition_entered = False
    try:
        context = run_context(os.environ, args.campaign_id)
        plan = validate_all(args, context)
        if args.preflight_only:
            check_dispatch_history(context)
            runtime_metadata(args.node)
            with tempfile.TemporaryDirectory(prefix='windows-r0-preflight-') as temporary:
                directory = Path(temporary)
                protocol = directory / 'protocol.json'
                protocol.write_bytes(plan['protocol'])
                protocol_check(plan, protocol, directory, collector_environment(os.environ), 'protocol-preflight')
            postflight(plan, args, context)
            print(json.dumps({'state': 'PREFLIGHT_ONLY_NO_COLLECTOR', 'collector_invocations': 0, 'qualified': False, 'qualification_credit': 0}))
            return 0
        acquisition_entered = True
        code, result = acquire(args, context, plan)
        print(json.dumps(result))
        return code
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        result = {'state': 'ACQUISITION_INTERRUPTED_NO_FINAL_RECEIPT' if acquisition_entered else 'PRECONDITION_REFUSED',
                  'error': str(error), 'collector_invocations': None if acquisition_entered else 0, 'qualified': False, 'qualification_credit': 0}
        try:
            workspace = no_links(args.workspace).resolve(strict=True)
            target = workspace / 'windows-acquisition-error.json'
            if not target.exists():
                save(target, result)
        except OSError:
            pass
        print(json.dumps(result), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
