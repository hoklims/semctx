"""Read-only Windows RAW transport. No subprocess replay or qualification decision.

The externally pinned inventory describes an already extracted complete archive:
{schema_version:1, kind:WINDOWS_R0_RAW_EXPORT_INVENTORY, complete:true,
 source_head, protocol_sha256, sdk_sha256, caller_head, native_raw_root,
 counts:{original:1,supplement:1,as_expression:2},
 files:[{path:raw/... or control/... or ARCHIVE-LINKS.json,sha256,bytes}, ...]}.
Every exported regular file must occur exactly once. The inventory itself belongs
outside the export. Caller code is resolved from the explicit admitted Git epoch;
this transport does not execute Windows validate_frozen_document on another OS.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import stat
import subprocess
import unicodedata

SOURCE = '3309e011184893b41b97491622fd31880982cab6'
PROTOCOL = 'c4e8cc4c2431c0250cefd4ee61e846c4c0eebcd188198e6bab7d11d5beb18303'
SDK = 'f57257876a383d13839a94adefb42b3d40bad2e93489a0f1a5ab29f045f139e5'
COUNTS = {'original': 1, 'supplement': 1, 'as_expression': 2}
CALLER = 'tools/rust-ts-r0/qualification/run_windows_milestone.py'
REPORTS = {'original-evidence/report.json', 'original-evidence/obligation-closure.json',
           'supplement-evidence/source-results.json', 'supplement-evidence/addenda-results.json',
           'supplement-evidence/public/public-report.json', 'supplement-evidence/supplement-report.json',
           'supplement-evidence/token-results.json', 'supplement-evidence/token-guards/process-outcome.json',
           'supplement-evidence/token-guards/token-report.json'}


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def json_value(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'duplicate JSON key: ' + key)
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=unique,
                       parse_constant=lambda value: fail('non-finite JSON constant: ' + value))
    return value


def document(raw):
    value = json_value(raw)
    require(isinstance(value, dict), 'JSON object required')
    return value


def fail(message):
    raise ValueError(message)


def safe_path(path):
    path = Path(path).absolute()
    require('..' not in path.parts, 'parent traversal refused')
    for part in [path, *path.parents]:
        if part.exists() or part.is_symlink():
            info = part.lstat()
            require(not stat.S_ISLNK(info.st_mode) and not getattr(info, 'st_file_attributes', 0) & 0x400,
                    'link/reparse path refused')
            require(not stat.S_ISREG(info.st_mode) or info.st_nlink == 1, 'hardlink path refused')
    return path


def regular(path):
    path = safe_path(path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'regular file without hardlinks required')
    return path


def member(name):
    require(isinstance(name, str) and name and '\\' not in name and ':' not in name,
            'unsafe export member')
    parts = name.split('/')
    require(all(part not in ('', '.', '..') and not part.endswith(('.', ' '))
                and not any(ord(c) < 32 or c in '<>"|?*' for c in part)
                and not re.fullmatch(r'(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?', part, re.I)
                for part in parts), 'unsafe export member')
    return PurePosixPath(name)


def namespace(names):
    """Conservative portable Windows components; lexical names, no resolution."""
    root = {}
    for name in names:
        parts = member(name).parts
        node = root
        for index, part in enumerate(parts):
            require(None not in node, 'Windows namespace file/directory collision')
            folded = part.casefold()
            if folded in node:
                spelling, child = node[folded]
                require(spelling == part, 'Windows namespace component collision')
            else:
                child = {}
                node[folded] = (part, child)
            node = child
            if index == len(parts) - 1:
                require(not node, 'Windows namespace duplicate or file/directory collision')
                node[None] = True


def local_write_component(component):
    """Conservative alias key for local writes only; captured native paths stay exact."""
    key = unicodedata.normalize('NFD', component).casefold().rstrip(' .')
    require(bool(key), 'unsafe local write component')
    return key


def local_write_locations(path):
    """Existing nofollow identities plus prospective tails, without resolving links."""
    locations = []
    for ancestor in (path, *path.parents):
        try:
            info = ancestor.lstat()
        except (FileNotFoundError, NotADirectoryError):
            continue
        require(not stat.S_ISLNK(info.st_mode) and not getattr(info, 'st_file_attributes', 0) & 0x400,
                'link/reparse path refused')
        require(not stat.S_ISREG(info.st_mode) or info.st_nlink == 1, 'hardlink path refused')
        tail = tuple(local_write_component(part) for part in path.relative_to(ancestor).parts)
        locations.append(((info.st_dev, info.st_ino), tail))
    require(bool(locations), 'local write path has no identifiable ancestor')
    return locations


def local_write_overlap(left, right):
    return any(left_id == right_id and
               (left_tail[:len(right_tail)] == right_tail or right_tail[:len(left_tail)] == left_tail)
               for left_id, left_tail in left for right_id, right_tail in right)


def disjoint_writes(writes, inputs):
    writes = [safe_path(path) for path in writes]
    inputs = [safe_path(path) for path in inputs]
    locations = {path: local_write_locations(path) for path in writes + inputs}
    for index, path in enumerate(writes):
        for other in inputs + writes[:index]:
            require(not local_write_overlap(locations[path], locations[other]),
                    'cache/output overlaps protected input or each other')
    return writes


def tree(root):
    root = safe_path(root)
    require(root.is_dir(), 'export root missing')
    result = {}
    for path in sorted(root.rglob('*')):
        safe_path(path)
        if path.is_dir():
            continue
        raw = regular(path).read_bytes()
        name = path.relative_to(root).as_posix()
        member(name)
        result[name] = {'sha256': digest(raw), 'bytes': len(raw)}
    namespace(result)
    return result


def exact_int(value, expected):
    return type(value) is int and value == expected


def exact_counts(value):
    return isinstance(value, dict) and value.keys() == COUNTS.keys() and all(
        exact_int(value[k], expected) for k, expected in COUNTS.items())


def successful(receipt):
    require('exitCode' not in receipt and 'timedOut' not in receipt, 'coexisting/foreign build aliases refused')
    require(exact_int(receipt.get('exit_code'), 0) and receipt.get('timed_out') is False
            and exact_int(receipt.get('attempt'), 1), 'raw command failed/incomplete/retried')
    require(isinstance(receipt.get('argv'), list) and all(isinstance(v, str) for v in receipt['argv']),
            'raw command argv missing')


def renamed(value, aliases):
    value = dict(value)
    for old, new in aliases.items():
        require(old in value and new not in value, 'missing or coexisting alias: ' + old)
        value[new] = value.pop(old)
    return value


def git_bytes(repo, head, path):
    require(re.fullmatch('[0-9a-f]{40}', head or '') is not None, 'explicit caller Git epoch required')
    repo = safe_path(repo)
    require(not subprocess.check_output(['git', '-C', str(repo), 'replace', '-l']).strip(), 'Git replace refs refused')
    graft = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', '--git-path', 'info/grafts']).decode().strip()
    require(not (repo / graft).exists(), 'Git grafts refused')
    return subprocess.check_output(['git', '-C', str(repo), 'show', head + ':' + path])


def trusted_source_tree(repo):
    """Resolve the complete fixed producer tree from Git objects, never raw maps."""
    git_bytes(repo, SOURCE, 'rust-toolchain.toml')  # Also rejects replacements/grafts.
    entries = subprocess.check_output(['git', '-C', str(repo), 'ls-tree', '-rz', SOURCE])
    names = {}
    for entry in entries.split(b'\0'):
        if not entry:
            continue
        metadata, raw_name = entry.split(b'\t', 1)
        mode, kind, blob = metadata.decode('ascii').split()
        name = str(member(raw_name.decode('utf-8')))
        require(mode in ('100644', '100755') and kind == 'blob' and name not in names,
                'trusted Git tree contains unsupported entry')
        names[name] = blob
    require(names, 'trusted Git tree is empty')
    objects = sorted(set(names.values()))
    batch = subprocess.check_output(['git', '-C', str(repo), 'cat-file', '--batch'],
                                    input=('\n'.join(objects) + '\n').encode('ascii'))
    hashes, offset = {}, 0
    for blob in objects:
        end = batch.index(b'\n', offset)
        identity, kind, size = batch[offset:end].decode('ascii').split()
        require(identity == blob and kind == 'blob', 'trusted Git tree blob identity differs')
        count = int(size)
        content = batch[end + 1:end + 1 + count]
        require(len(content) == count and batch[end + 1 + count:end + 2 + count] == b'\n',
                'trusted Git tree blob is incomplete')
        require(hashlib.sha1(b'blob ' + str(count).encode() + b'\0' + content).hexdigest() == blob,
                'trusted Git tree blob hash differs')
        hashes[blob] = digest(content)
        offset = end + 2 + count
    require(offset == len(batch), 'trusted Git tree batch has trailing data')
    return {name: hashes[blob] for name, blob in names.items()}


def adapt(*, export_root, inventory, inventory_sha256, source_repo, caller_repo, caller_head, output, _expected=False):
    """Validate first; write only a fresh independent transport output."""
    export_root, inventory = safe_path(export_root), regular(inventory)
    source_repo, caller_repo, output = map(safe_path, (source_repo, caller_repo, output))
    require(_expected or not output.exists(), 'output collision')
    disjoint_writes((output,), (export_root, inventory, source_repo, caller_repo))
    disjoint_writes((inventory,), (export_root,))
    raw_inventory = inventory.read_bytes()
    require(digest(raw_inventory) == inventory_sha256, 'inventory pin differs')
    spec = document(raw_inventory)
    require(set(spec) == {'schema_version', 'kind', 'complete', 'source_head', 'protocol_sha256',
                         'sdk_sha256', 'caller_head', 'native_raw_root', 'counts', 'files'}, 'inventory fields differ')
    require(exact_int(spec['schema_version'], 1) and spec['kind'] == 'WINDOWS_R0_RAW_EXPORT_INVENTORY'
            and spec['complete'] is True, 'complete export inventory required')
    require((spec['source_head'], spec['protocol_sha256'], spec['sdk_sha256'], spec['caller_head']) ==
            (SOURCE, PROTOCOL, SDK, caller_head), 'source/protocol/SDK/caller epoch differs')
    require(exact_counts(spec['counts']),
            'unknown collection counts')
    expected = {}
    require(isinstance(spec['files'], list) and spec['files'], 'empty export inventory')
    folded = set()
    for row in spec['files']:
        require(set(row) == {'path', 'sha256', 'bytes'}, 'inventory file fields differ')
        name = str(member(row['path']))
        require((name.split('/')[0] in ('raw', 'control') or name == 'ARCHIVE-LINKS.json')
                and name.casefold() not in folded, 'duplicate/foreign export member')
        require(type(row['bytes']) is int and row['bytes'] >= 0 and re.fullmatch('[0-9a-f]{64}', row['sha256']) is not None,
                'invalid file hash/size')
        folded.add(name.casefold())
        expected[name] = {k: row[k] for k in ('sha256', 'bytes')}
    namespace(expected)
    before = tree(export_root)
    require(before == expected, 'export inventory hash/size/file set differs')
    for name in before:
        if name.endswith('.json'):
            json_value(regular(export_root / name).read_bytes())
    lexical_names = []
    if 'ARCHIVE-LINKS.json' in before:
        links = document((export_root / 'ARCHIVE-LINKS.json').read_bytes())
        require(exact_int(links.get('schema_version'), 1) and links.get('representation') == 'lexical_links'
                and links.get('targets_read') is False and links.get('native_links_in_zip') is False
                and isinstance(links.get('links'), list), 'lexical archive link metadata differs')
        seen_links = set()
        for link in links['links']:
            require(set(link) == {'archive_path', 'native_path', 'target', 'link_type', 'capture_stable', 'stat'},
                    'lexical link fields differ')
            require(set(link['stat']) == {'mode', 'device', 'inode', 'size', 'mtime_ns', 'ctime_ns',
                                         'file_attributes', 'reparse_tag'}, 'lexical stat fields differ')
            name = str(member(link['archive_path']))
            require(name.split('/')[0] in ('raw', 'control') and name.casefold() not in folded
                    and name.casefold() not in seen_links and link.get('capture_stable') is True
                    and link.get('link_type') in ('symlink', 'junction')
                    and isinstance(link.get('native_path'), str) and isinstance(link.get('target'), str)
                    and isinstance(link.get('stat'), dict), 'foreign/duplicate lexical link metadata')
            seen_links.add(name.casefold())
        lexical_names = [link['archive_path'] for link in links['links']]
        namespace(list(before) + lexical_names)
    native_root = PureWindowsPath(spec['native_raw_root'])
    require(native_root.is_absolute() and '..' not in native_root.parts, 'absolute captured Windows raw root required')
    raw = export_root / 'raw'

    def read(name):
        return document(regular(raw / member(name)).read_bytes())

    def native_member(path):
        require(isinstance(path, str), 'captured Windows path required')
        captured = PureWindowsPath(path)
        require(captured.is_absolute() and '..' not in captured.parts, 'foreign captured path')
        try:
            name = captured.relative_to(native_root).as_posix()
        except ValueError as error:
            raise ValueError('captured path outside raw export') from error
        member(name)
        require('raw/' + name in before, 'captured raw member missing: ' + name)
        return name

    def bound(path, sha):
        name = native_member(path)
        require(before['raw/' + name]['sha256'] == sha, 'captured raw hash differs: ' + name)
        return name

    control = document(regular(export_root / 'control/acquisition-state.json').read_bytes())
    require(control.get('state') == 'RAW_ACQUIRED_UNADAPTED_REVIEW_PENDING'
            and control.get('source_head') == SOURCE and control.get('protocol_sha256') == PROTOCOL
            and control.get('tooling_head') == caller_head, 'raw acquisition identity/state differs')
    require('R0_decision' in control and control.get('qualified') is False and exact_int(control.get('qualification_credit'), 0)
            and control.get('R0_decision') is None and exact_int(control.get('attempt'), 1)
            and exact_int(control.get('retries'), 0) and exact_int(control.get('collector_invocations'), 1)
            and exact_int(control.get('collector_invocation_attempts'), 1), 'raw acquisition credit/attempt differs')
    require(exact_counts(control.get('allowed_collection_counts')) and exact_counts(control.get('raw_shape', {}).get('counts')),
            'raw acquisition counts missing')
    summary = read('acquisition-summary.json')
    require('R0_decision' in summary and summary.get('source_head') == SOURCE and summary.get('qualified') is False
            and exact_int(summary.get('qualification_credit'), 0) and summary.get('R0_decision') is None
            and exact_int(summary.get('attempts'), 1), 'collector summary identity/credit/attempt differs')
    require(set(summary.get('reports', {})) == REPORTS, 'required reports missing')
    for name, sha in summary['reports'].items():
        require(before.get('raw/' + name, {}).get('sha256') == sha, 'required report hash differs')
    for label in ('original', 'supplement'):
        require(exact_int(summary.get(label + '_exit_code'), 0), 'native phase failed')
        successful(read(label + '-native.receipt.json'))
    snapshots = [read(name) for name in ('source-before.json', 'source-after.json', 'source-after-finally.json')]
    require(all(value == snapshots[0] for value in snapshots), 'full source snapshots changed')
    snapshot = snapshots[0]
    require(snapshot.get('source_head') == SOURCE and snapshot.get('status') == '' and 'head' not in snapshot,
            'source epoch/aliases differ')
    require(isinstance(snapshot.get('all_tracked_files'), dict) and snapshot['all_tracked_files']
            and isinstance(snapshot.get('files'), dict) and snapshot['files'], 'full source snapshot absent')
    trusted_files = trusted_source_tree(caller_repo)
    require(snapshot['all_tracked_files'] == trusted_files, 'raw full source snapshot differs from trusted Git tree')
    selected_files = {name: sha for name, sha in trusted_files.items()
                      if name.startswith(('tools/gates/', 'tools/rust-ts-r0/')) or name == 'rust-toolchain.toml'}
    require(snapshot['files'] == selected_files, 'raw selected source snapshot differs from trusted Git tree')
    for name, sha in snapshot['all_tracked_files'].items():
        require(digest(regular(source_repo / member(name)).read_bytes()) == sha, 'local source snapshot bytes differ: ' + name)
    require(all(snapshot['all_tracked_files'].get(name) == sha for name, sha in snapshot['files'].items()),
            'partial source snapshot differs from full snapshot')
    fixture = read('fixture.enabled.json')
    require(fixture.get('source_head') == SOURCE and fixture.get('platform') == 'windows'
            and fixture.get('optimized_frozen') is True, 'actual Windows freeze missing')
    require(fixture.get('sdk_sha256') == SDK, 'SDK identity differs')
    artifact_names = {key: bound(fixture[key + '_path'], fixture[key + '_sha256'])
                      for key in ('artifact', 'helper', 'sdk', 'qualification_observer', 'transport_fixture')}
    require(artifact_names['sdk'] == 'sdk-input.json', 'SDK transport fallback requires raw sdk-input.json')
    legacy = bound(fixture['legacy_identity_inputs_path'], fixture['legacy_identity_inputs_sha256'])
    token = bound(fixture['token_family_path'], fixture['token_family_sha256'])
    recipes = bound(fixture['recipes_path'], fixture['recipes_sha256'])
    environment_name = bound(fixture['build_environment_path'], fixture['build_environment_sha256'])
    environment = read(environment_name)
    require(environment.get('source_head') == SOURCE and environment.get('state') == 'frozen'
            and exact_int(environment.get('build_commands'), 3), 'raw build environment incomplete')
    caller = environment['caller']
    caller_bytes = git_bytes(caller_repo, caller_head, CALLER)
    require(PureWindowsPath(caller['path']).as_posix().endswith('/' + CALLER)
            and digest(caller_bytes) == caller['sha256'], 'raw caller differs from admitted Git epoch')
    receipt_names = []
    require(len(environment['builds']) == 4 and {build.get('artifact_kind') for build in environment['builds']}
            == {'artifact', 'helper', 'qualification_observer', 'transport_fixture'},
            'owning artifact build records incomplete')
    for build in environment['builds']:
        name = bound(build['receipt']['path'], build['receipt']['sha256'])
        require('/' not in name, 'build receipt must remain at raw root basename')
        receipt = read(name)
        successful(receipt)
        require(receipt['argv'] == build['argv'], 'build argv differs')
        for stream in ('stdout', 'stderr'):
            ref = build[stream]
            stream_name = bound(ref['path'], ref['sha256'])
            require('/' not in stream_name and before['raw/' + stream_name]['bytes'] == ref['bytes'], 'build stream binding differs')
        if name not in receipt_names:
            receipt_names.append(name)
    require(set(receipt_names) == {'helper-build.receipt.json', 'observer-build.receipt.json', 'standalone-restore.receipt.json'},
            'owning build command set differs')
    additional = summary['additional_as_expression_witness']
    witness = read(bound(additional['path'], additional['sha256']))
    require(witness.get('source_head') == SOURCE and witness.get('platform') == 'windows'
            and witness.get('postflight_ok') is True and exact_int(witness.get('attempts'), 1), 'additional witness incomplete')
    for name in ('expected_candidate_phases', 'candidate_phases_completed', 'candidate_outcomes_recorded'):
        require(exact_int(witness.get(name), 2), 'additional query counts unknown')
    require(witness.get('caller_invocations_attempted') == ['legacy', 'retained']
            and [c.get('context') for c in witness.get('contexts', [])] == ['legacy', 'retained'], 'additional contexts incomplete')
    original_freeze = read('original-evidence/freeze-manifest.json')
    require(original_freeze == fixture, 'actual original freeze differs from supplement fixture')
    report = read('original-evidence/report.json')
    require(all(report.get(key + '_sha256') == fixture[key + '_sha256'] for key in ('artifact', 'helper')),
            'original report artifact binding differs')
    require([len(report[k]) for k in ('units', 'supports', 'obligations')] == [354, 51, 240], 'original denominators differ')
    supplement = read('supplement-evidence/supplement-report.json')
    require([len(supplement[k]) for k in ('rows', 'digest_pairs', 'addenda')] == [67, 5, 8]
            and len(supplement['public']['rows']) == 25, 'supplement denominators differ')
    for name in ('supplement-evidence/source-results.json', 'supplement-evidence/public/public-report.json',
                 'supplement-evidence/token-guards/request.json', 'supplement-evidence/token-guards/process-invocation.json',
                 'supplement-evidence/token-guards/actual-token-observations.json'):
        read(name)
    for name in ('registry.enabled.json', 'addenda.enabled.json', 'public-plan.json',
                 'native-compiler-source-identity.json', 'upstream-compiler-core.rs'):
        require('raw/' + name in before, 'required manifest member missing: ' + name)
    require(tree(export_root) == before, 'raw export changed during validation')
    view = output / 'view'
    ledger, origins = [], []
    emitted = {}

    def emit(destination, data):
        name = destination.relative_to(output).as_posix()
        require(name not in emitted, 'duplicate projected transport path')
        emitted[name] = data

    def copy_file(name, destination):
        raw_bytes = regular(export_root / name).read_bytes()
        require(digest(raw_bytes) == before[name]['sha256'], 'raw export changed during copy')
        emit(destination, raw_bytes)
        origins.append({'origin': str(export_root / name), 'member': name, 'path': str(destination), **before[name]})

    for name in sorted(before):
        copy_file(name, view / name.removeprefix('raw/') if name.startswith('raw/') else output / name)
        if name.startswith('raw/supplement-evidence/'):
            copy_file(name, view / 'evidence' / name.removeprefix('raw/supplement-evidence/'))

    def pin(name):
        return {'path': str(view / name), 'sha256': before['raw/' + name]['sha256']}

    def sidecar(name, aliases):
        value = read(name)
        derived = renamed(value, aliases)
        raw_bytes = (json.dumps(derived, sort_keys=True, indent=2) + '\n').encode()
        destination = output / 'derived' / name
        emit(destination, raw_bytes)
        ledger.append({'raw_path': str(raw / name), 'raw_sha256': before['raw/' + name]['sha256'],
                       'operation': {'rename': aliases}, 'derived_path': str(destination),
                       'derived_sha256': digest(raw_bytes), 'raw_keyset': sorted(value), 'derived_keyset': sorted(derived)})
        return {'path': str(destination), 'sha256': digest(raw_bytes)}

    host = {'raw_root': str(view), 'original': {'report': pin('original-evidence/report.json'),
            'freeze': pin('original-evidence/freeze-manifest.json'), 'recipes': pin(recipes)},
            'supplement': {'report': pin('supplement-evidence/supplement-report.json'), 'fixture': pin('fixture.enabled.json'),
            'registry': pin('registry.enabled.json'), 'addenda': pin('addenda.enabled.json'),
            'plan': pin('public-plan.json'), 'evidence_root': str(view / 'evidence')},
            'source': {'before': sidecar('source-before.json', {'source_head': 'head'}),
                       'after': sidecar('source-after.json', {'source_head': 'head'})},
            'build_receipts': [sidecar(name, {'exit_code': 'exitCode', 'timed_out': 'timedOut'}) for name in receipt_names],
            'artifact_files': {key: pin(name) for key, name in artifact_names.items()},
            'token_family': pin(token), 'legacy_identity_inputs': pin(legacy),
            'native_compiler_identity': {'receipt': pin('native-compiler-source-identity.json'),
                                         'core': pin('upstream-compiler-core.rs'), 'build_environment': pin(environment_name)}}
    # Pin() may only name real inventoried files; validate all manifest pins before publication.
    def check_pins(value):
        if isinstance(value, dict):
            if set(value) == {'path', 'sha256'}:
                require(digest(emitted[Path(value['path']).relative_to(output).as_posix()]) == value['sha256'], 'manifest file pin differs')
            else:
                for item in value.values():
                    check_pins(item)
        elif isinstance(value, list):
            for item in value:
                check_pins(item)
    check_pins(host)
    require(tree(export_root) == before, 'raw export changed during transport')
    for name, sha in snapshot['all_tracked_files'].items():
        require(digest(regular(source_repo / member(name)).read_bytes()) == sha, 'local source changed during transport')
    manifest = {'kind': 'WINDOWS_RAW_TRANSPORT_ONLY', 'platform': 'windows', 'expected_source_head': SOURCE,
                'evaluation_protocol_sha256': PROTOCOL, 'qualified': False, 'qualification_credit': 0,
                'R0_decision': None, 'hosts': {'windows': host}}
    metadata = {'inventory_sha256': inventory_sha256, 'caller_head': caller_head, 'caller_sha256': digest(caller_bytes),
                'native_replays': 0, 'native_validation_executed_by_adapter': False, 'origins': origins, 'derivations': ledger,
                'raw_before': before, 'raw_after': tree(export_root),
                'lexical_link_targets_captured_or_restored': False}
    for name, value in [('transport-ledger.json', metadata), ('manifest.json', manifest)]:
        emit(output / name, (json.dumps(value, sort_keys=True, indent=2) + '\n').encode())
    projected_links = []
    for name in lexical_names:
        projected_links.append('view/' + name.removeprefix('raw/') if name.startswith('raw/') else name)
        if name.startswith('raw/supplement-evidence/'):
            projected_links.append('view/evidence/' + name.removeprefix('raw/supplement-evidence/'))
    namespace(list(emitted) + projected_links)
    if not _expected:
        output.mkdir(parents=True, exist_ok=False)
        for name, data in emitted.items():
            destination = output / member(name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open('xb') as stream:
                stream.write(data)
    return {'manifest': manifest, 'ledger': metadata, 'files': emitted} if _expected else manifest


READBACK_FILES = {'adapter_sha256': 'tools/rust-ts-r0/qualification/adapt_windows_raw.py',
                  'verifier_sha256': 'tools/rust-ts-r0/qualification/windows_token_fields.py'}


def pinned_file(reference):
    require(isinstance(reference, dict) and set(reference) == {'path', 'sha256'}, 'explicit file pin required')
    require(isinstance(reference['sha256'], str) and re.fullmatch('[0-9a-f]{64}', reference['sha256']), 'invalid file pin')
    path = regular(reference['path'])
    raw = path.read_bytes()
    require(digest(raw) == reference['sha256'], 'pinned input differs: ' + str(path))
    return document(raw)


def verify_transport(*, manifest, ledger, inventory, registration, export_root,
                     source_repo, caller_repo, readback_repo, cache=None, output=None):
    """Recompute custody from fixed transport rules; no cache or output writes.

    The journal is compared with independently reconstructed paths and bytes,
    never used to decide which files are authoritative.
    """
    documents = {name: pinned_file(ref) for name, ref in (
        ('manifest', manifest), ('ledger', ledger), ('inventory', inventory), ('registration', registration))}
    reg, spec = documents['registration'], documents['inventory']
    core = {'readback_head', 'adapter_sha256', 'verifier_sha256', 'caller_head', 'source_head',
            'protocol_sha256', 'sdk_sha256', 'coordinates', 'expected_request_relative', 'output_relative'}
    require(core <= set(reg) <= core | {'public_bindings'}, 'registration fields differ')
    require(all(isinstance(reg[key], str) and reg[key] for key in core - {'coordinates'}), 'registration string fields required')
    require(isinstance(reg.get('public_bindings', {}), dict) and all(isinstance(k, str) and isinstance(v, str)
            for k, v in reg.get('public_bindings', {}).items()), 'registration public bindings differ')
    require((reg['source_head'], reg['protocol_sha256'], reg['sdk_sha256']) == (SOURCE, PROTOCOL, SDK),
            'registration fixed source/protocol/SDK differs')
    require(reg['coordinates'] == [[232, 1], [234, 1], [238, 1]]
            and all(type(v) is int for row in reg['coordinates'] for v in row), 'registered token scope differs')
    require(reg['expected_request_relative'] == 'supplement-evidence/token-guards/request.json', 'registered request differs')
    parts = member(reg['output_relative']).parts
    require(len(parts) == 2 and parts[0] == 'windows-raw', 'registered campaign output differs')
    native_root = PureWindowsPath(spec['native_raw_root'])
    require(native_root.is_absolute() and '..' not in native_root.parts and tuple(native_root.parts[-2:]) == parts,
            'captured campaign native root differs')
    transport = safe_path(manifest['path']).parent
    require(safe_path(ledger['path']) == transport / 'transport-ledger.json'
            and safe_path(manifest['path']) == transport / 'manifest.json', 'transport manifest/ledger location differs')
    roots = [safe_path(path) for path in (export_root, source_repo, caller_repo, readback_repo, transport)]
    roots += [safe_path(ref['path']) for ref in (manifest, ledger, inventory, registration)]
    writes = [path for path in (cache, output) if path is not None]
    disjoint_writes(writes, roots)
    for field, relative in READBACK_FILES.items():
        actual = regular(safe_path(readback_repo) / relative).read_bytes()
        require(digest(actual) == reg[field] and actual == git_bytes(readback_repo, reg['readback_head'], relative),
                'registered W readback code differs: ' + relative)
    require(spec['caller_head'] == reg['caller_head'], 'registered T caller differs')
    # Existing full Git33/source/caller/artifact/stream validation is reused verbatim.
    expected = adapt(export_root=export_root, inventory=inventory['path'], inventory_sha256=inventory['sha256'],
                     source_repo=source_repo, caller_repo=caller_repo, caller_head=reg['caller_head'],
                     output=transport, _expected=True)
    require(documents['manifest'] == expected['manifest'], 'transport manifest differs from fixed reconstruction')
    require(documents['ledger'] == expected['ledger'], 'transport ledger differs from fixed reconstruction')
    wanted = {name: {'sha256': digest(raw), 'bytes': len(raw)} for name, raw in expected['files'].items()}
    require(tree(transport) == wanted, 'consumed transport file set/bytes differ from export inventory')
    for name, raw in expected['files'].items():
        require(regular(transport / member(name)).read_bytes() == raw, 'consumed transport bytes differ: ' + name)
    # Publish only validated context, with every referenced pin covered by the projection.
    return {'documents': documents, 'manifest': expected['manifest'], 'native_raw_root': str(native_root),
            'protected_roots': roots, 'verified_files': wanted, 'origins': expected['ledger']['origins'],
            'source_head': SOURCE, 'caller_head': reg['caller_head'], 'readback_head': reg['readback_head']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('export-root', 'inventory', 'source-repo', 'caller-repo', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    for name in ('inventory-sha256', 'caller-head'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args(argv)
    try:
        adapt(**vars(args))
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        parser.exit(1, 'WINDOWS_RAW_TRANSPORT_REFUSED: ' + str(error) + '\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
