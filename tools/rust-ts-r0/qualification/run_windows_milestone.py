"""Explicitly authorized Windows evidence acquisition; never qualifies T00 or R0.

The caller's root-review flag/reference is orchestration authority, not a proof
that prior native evidence is correct. No artifact/receipt can approve itself.
"""
import argparse
import base64
import hashlib
import io
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

from additional_digest_dispositions import IDS as DIGEST_IDS, additional_digest_dispositions
from configuration_6046_disposition import configuration_6046_disposition
from prepare_token_family import prepare as prepare_token_family
from native_compiler_identity import record_native_compiler_source

AUTHORITY = 'owner-reviewed-macos-linux-authorizes-windows-observation'
SDK_SHA = 'f57257876a383d13839a94adefb42b3d40bad2e93489a0f1a5ab29f045f139e5'
RREL = Path('tools/rust-ts-r0/qualification/supplement')
ORIGINAL = 'qualification_replay_requires_explicit_optimized_freeze'
SUPPLEMENT = 'supplement_replay_requires_bound_root_authority'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False)+'\n', encoding='utf-8', newline='\n')


def hex_id(value, length):
    return len(value) == length and all(c in '0123456789abcdef' for c in value)


def authorize(args):
    require(args.execute_native_campaigns, 'native campaign execution is disabled')
    require(args.root_authority == AUTHORITY, 'root has not authorized this milestone')
    require(hex_id(args.expected_head, 40), 'exact event HEAD required')
    require(hex_id(args.prerequisite_proof_sha256, 64), 'root prior-native review reference required')
    require(args.prerequisite_proof_sha256 != '0'*64, 'placeholder review reference refused')
    require(platform.system() == 'Windows', 'this milestone belongs to native Windows')


def git(repo, *args):
    return subprocess.check_output(['git', *args], cwd=repo, text=True, encoding='utf-8').strip()


def snapshot(repo, expected):
    require(git(repo, 'rev-parse', 'HEAD') == expected, 'source HEAD differs from event')
    require(not git(repo, 'status', '--porcelain=v1', '--untracked-files=all'), 'source is dirty')
    names = git(repo, 'ls-files', 'tools/gates', 'tools/rust-ts-r0', 'rust-toolchain.toml').splitlines()
    return {'source_head': expected, 'status': '', 'files': {p: sha(repo/p) for p in names}}


def run(repo, out, label, argv, env, timeout=900, required=True):
    require(not (out/(label+'.receipt.json')).exists(), 'command retry refused: '+label)
    started = time.monotonic()
    timed_out = False
    with (out/(label+'.stdout')).open('wb') as stdout, (out/(label+'.stderr')).open('wb') as stderr:
        process = subprocess.Popen(argv, cwd=repo, env=env, stdout=stdout, stderr=stderr,
                                   creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            # Only this invocation's owned process tree may be terminated.
            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            process.wait(timeout=30)
            code = 124
    result = {'argv': argv, 'exit_code': code, 'timed_out': timed_out,
              'elapsed_seconds': round(time.monotonic()-started, 3), 'attempt': 1}
    save(out/(label+'.receipt.json'), result)
    require(not required or code == 0, 'command failed: '+label)
    return result


def observer_name(listing, suffix):
    names = [line.removesuffix(': test') for line in listing.splitlines() if line.endswith(': test')
             and line.removesuffix(': test').split('::')[-1] == suffix]
    require(len(names) == 1, 'missing or duplicate observer test: '+suffix)
    return names[0]


def restore_public_inputs(repo, out):
    base = repo/'docs/research/rust-ts-r0/resumption'
    metadata = load(base/'gap-legacy-identity-evidence.json')
    archive = base64.b64decode((base/'gap-legacy-identity-evidence.tar.gz.b64').read_bytes())
    require(hashlib.sha256(archive).hexdigest() == metadata['archive']['decodedSha256'], 'legacy archive bytes differ')
    member_info = metadata['inputs']
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as bundle:
        member = bundle.getmember(member_info['path'])
        require(member.isfile() and member.size == member_info['bytes'], 'legacy member differs')
        stream = bundle.extractfile(member)
        require(stream is not None, 'legacy member absent')
        data = stream.read()
    require(hashlib.sha256(data).hexdigest() == member_info['sha256'], 'legacy input bytes differ')
    (out/'legacy-identity-inputs.json').write_bytes(data)
    legacy = json.loads(data)
    files = {'/sdk/lib/'+Path(path).name: value['text'] for path, value in legacy['compiler_files'].items()
             if path.startswith('lib/lib') and path.endswith('.d.ts')}
    require(len(files) == 100, 'SDK library denominator differs')
    # Historical SDK serialization uses default json.dumps and no final newline.
    sdk = {'version': '5.9.3', 'archive_sha256': member_info['sdkArchiveSha256'], 'files': files}
    (out/'sdk-input.json').write_bytes(json.dumps(sdk).encode('utf-8'))
    require(sha(out/'sdk-input.json') == SDK_SHA, 'canonical public SDK identity differs')
    return {'archive_sha256': metadata['archive']['decodedSha256'], 'legacy_input_sha256': member_info['sha256'],
            'sdk_sha256': SDK_SHA, 'sdk_files': len(files)}


def enable(document):
    require(document['execution_enabled'] is False and document['candidate_execution_authorized'] is False,
            'preparation is not disabled')
    value = json.loads(json.dumps(document))
    value['execution_enabled'] = True
    value['candidate_execution_authorized'] = True
    for row in value['rows']:
        require(row['execution_enabled'] is False, 'prepared row already enabled')
        row['execution_enabled'] = True
    return value


def supplement_counts(report, additional_sources=(), diagnostic_assessment=None):
    sources, pairs, addenda, public = report['rows'], report['digest_pairs'], report['addenda'], report['public']['rows']
    require([len(sources), len(pairs), len(addenda), len(public)] == [67, 5, 8, 25], 'supplement result denominator differs')
    for rows in [sources, pairs, addenda, public]:
        require(len({row['id'] for row in rows}) == len(rows), 'duplicated supplemental result identity')
    disposed_sources = {row['id'] for row in additional_sources}
    require(not disposed_sources or disposed_sources == {'source::'+name for name in DIGEST_IDS},
            'additional source scope differs from the exact ten digest representations')
    require(all(row['disposition'] == 'additional_noncontract' and row['raw_state_preserved'] == 'RAW_NONPASS_PRESERVED'
                for row in additional_sources), 'additional source assessment is not a preserved raw mismatch')
    source_raw = [row for row in sources if row.get('state') != 'MAPPED_OBSERVATIONS_MATCH_NO_QUALIFICATION_CREDIT']
    public_raw = [row for row in public if row.get('state') != 'CONSUMER_OUTPUTS_MATCH']
    disposed_public = set()
    if diagnostic_assessment is not None:
        require(diagnostic_assessment['state'] == 'SCOPED_CODE_AND_PRECEDENCE_OBSERVATIONS_RECORDED'
                and diagnostic_assessment['message_disposition'] == 'additional_message_version_difference',
                'configuration diagnostic property remains unknown')
        scope = diagnostic_assessment['disposition_scope']
        require(scope == {'id': 'workspace-boundaries-01', 'sequence': 1,
                          'only_difference': 'module option choices within diagnostic message',
                          'whole_public_match_claimed': False, 'qualification_credit': 0},
                'configuration message disposition has a foreign scope')
        row = next((row for row in public_raw if row['id'] == scope['id']), None)
        require(row is not None and row['state'] == 'CONSUMER_OUTPUT_MISMATCH', 'configuration raw mismatch absent')
        nonmatching = [item for item in row['observations'] if item['required_consumer_output'] and item['status'] != 'MATCH']
        require(len(nonmatching) == 1 and nonmatching[0]['sequence'] == 1 and nonmatching[0]['status'] == 'MISMATCH'
                and nonmatching[0]['parent'] is None, 'another required public observation is not covered by the message disposition')
        disposed_public.add(row['id'])
    return {'source_nonpass': sum(row['id'] not in disposed_sources for row in source_raw),
            'digest_nonpass': sum(row.get('pass') is not True for row in pairs),
            'addenda_nonpass': sum(row.get('result', {}).get('pass') is not True for row in addenda),
            'public_nonpass': sum(row['id'] not in disposed_public for row in public_raw),
            'source_raw_nonpass': len(source_raw), 'public_raw_nonpass': len(public_raw),
            'additional_digest_representations': len(disposed_sources), 'additional_message_representations': len(disposed_public)}


def token_nonpass(report):
    if not isinstance(report, dict) or report.get('state') != 'TOKEN_GUARD_OBSERVATIONS_MATCH' or report.get('pass') is not True:
        return 1
    actual = report.get('actual', {})
    require(report.get('counts') == {'issuance': 13, 'revalidation': 7, 'map_identity': 1}, 'token report denominator differs')
    require(actual.get('counts') == {'issuance': 13, 'revalidation': 7, 'mapIdentity': 1}, 'actual token consumer denominator differs')
    require(len(actual.get('issuance', [])) == 13 and len(actual.get('revalidation', [])) == 7,
            'actual token observations are incomplete')
    require(len({row['name'] for row in actual['issuance']}) == 13
            and len({row['name'] for row in actual['revalidation']}) == 7, 'token result identities duplicated')
    require(report.get('native_queries') == 1 and report.get('baseline_actual_program_records') == 21,
            'native query count confused with historical baseline Programs')
    require(actual.get('mapIdentity', {}).get('identical_map_content') is True
            and actual['mapIdentity'].get('same_map_identity') is False, 'Map identity contrast absent')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--expected-head', required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--root-authority', required=True)
    parser.add_argument('--prerequisite-proof-sha256', required=True)
    parser.add_argument('--execute-native-campaigns', action='store_true')
    args = parser.parse_args()
    authorize(args)
    repo, out = args.repo.resolve(), args.output.resolve()
    require(not out.exists() and not out.is_relative_to(repo), 'evidence output must be fresh outside source')
    require(args.node.resolve().is_file(), 'native Node executable absent')
    before = snapshot(repo, args.expected_head)
    out.mkdir(parents=True)
    save(out/'source-before.json', before)
    env = os.environ.copy()
    env.pop('GIT_CONFIG_GLOBAL', None)
    env.pop('GOPORT_BUILD_VERSION', None)
    env.update(RUSTUP_TOOLCHAIN='1.95.0', RUST_TEST_THREADS='1', GOPORT_LIB_PARSE_SNAPSHOT='0',
               GOPORT_LIB_SNAPSHOT='0', CARGO_NET_OFFLINE='true', PYTHONDONTWRITEBYTECODE='1')
    require(not env.get('CARGO_TARGET_DIR'), 'unexpected Cargo target override')
    record_native_compiler_source(out, env)
    runtime, cases = repo/RREL, repo/'docs/research/rust-ts-r0/cases'
    frozen = cases/'supplement-v2'
    runtime_manifest = load(runtime/'runtime-manifest.json')
    require(runtime_manifest['frozen_manifest_sha256'] == sha(frozen/'manifest-sha256.json'), 'frozen manifest differs')
    for row in runtime_manifest['files']:
        require(sha(runtime/row['path']) == row['sha256'], 'runtime pin differs: '+row['path'])
    inputs = restore_public_inputs(repo, out)
    save(out/'public-input-custody.json', inputs)
    node = str(args.node.resolve())
    run(repo, out, 'node-version', [node, '--version'], env, timeout=30)
    require((out/'node-version.stdout').read_text().strip() == 'v24.22.0', 'pinned Node version differs')
    run(repo, out, 'rustc-version', ['rustc', '--version', '--verbose'], env, timeout=30)
    run(repo, out, 'cargo-version', ['cargo', '--version'], env, timeout=30)
    run(repo, out, 'python-version', [sys.executable, '--version'], env, timeout=30)
    run(repo, out, 'helper-build', ['cargo', 'build', '--locked', '--offline', '--release', '--bins', '--manifest-path', 'tools/gates/Cargo.toml'], env)
    run(repo, out, 'observer-build', ['cargo', 'test', '--locked', '--offline', '--release', '--features', 'qualification-observer', '--test', 'qualification_replay', '--no-run', '--message-format=json', '--manifest-path', 'tools/rust-ts-r0/Cargo.toml'], env)
    messages = [json.loads(line) for line in (out/'observer-build.stdout').read_text().splitlines()]
    observers = [m['executable'] for m in messages if m.get('reason') == 'compiler-artifact'
                 and m.get('target', {}).get('name') == 'qualification_replay' and m.get('executable')]
    require(len(observers) == 1, 'one actual observer Cargo artifact required')
    run(repo, out, 'standalone-restore', ['cargo', 'build', '--locked', '--offline', '--release', '--bin', 'semctx-r0-probe', '--manifest-path', 'tools/rust-ts-r0/Cargo.toml'], env)
    run(repo, out, 'recipes', [sys.executable, str(repo/'tools/rust-ts-r0/qualification/prepare_recipes.py'), '--output', str(out/'recipes')], env)
    run(repo, out, 'registry', [sys.executable, str(runtime/'prepare_registry.py'), '--frozen', str(frozen), '--public-registry', str(runtime/'public-registry.draft.json'), '--output', str(out/'registry-draft')], env)
    registry = load(out/'registry-draft/registry.json')
    require(registry['counts']['sources'] == 67 and registry['counts']['public_vectors'] == 25 and len(registry['rows']) == 92, 'supplement denominator differs')
    probe = out/'case-probe'
    probe.write_bytes(b'case\n')
    case_sensitive = not (out/'CASE-PROBE').exists()
    probe.unlink()
    save(out/'case-probe.json', {'case_sensitive': case_sensitive})
    supplement_out = out/'supplement-evidence'
    run(repo, out, 'public-plan', [sys.executable, str(runtime/'public_bridge.py'), 'plan', '--frozen', str(frozen), '--module-dir', str(runtime), '--ownership-module-dir', str(runtime), '--lifecycle-module-dir', str(runtime), '--output', str(out/'public-plan.json'), '--execution-root', str(supplement_out/'public'), '--sdk-directory', '/sdk/lib', '--case-sensitive', str(case_sensitive).lower()], env)
    sys.path.insert(0, str(runtime))
    from source_scope_addenda import prepare_addenda
    addenda = prepare_addenda(cases)
    require(addenda['counts']['addenda'] == 8 and len(addenda['rows']) == 8, 'addenda denominator differs')
    save(out/'addenda.disabled.json', addenda)
    token_family = prepare_token_family(cases/'supplement-token-guards-20261021')
    save(out/'token-family.disabled.json', token_family)
    binaries = out/'frozen-binaries'
    binaries.mkdir()
    fixture = {'optimized_frozen': True, 'source_head': args.expected_head, 'source_clean': True, 'cases_path': str(cases), 'platform': 'windows'}
    artifacts = {'artifact': repo/'tools/rust-ts-r0/target/release/semctx-r0-probe.exe', 'helper': repo/'tools/gates/target/release/semctx-gates.exe', 'transport_fixture': repo/'tools/gates/target/release/semctx-gates-fixture.exe', 'qualification_observer': Path(observers[0])}
    for name, path in artifacts.items():
        copied = binaries/path.name
        shutil.copy2(path, copied)
        require(sha(copied) == sha(path), 'frozen binary differs')
        fixture[name+'_path'], fixture[name+'_sha256'] = str(copied), sha(copied)
    for name, path in {'sdk': out/'sdk-input.json', 'recipes': out/'recipes/replay-recipes.json', 'legacy_identity_inputs': out/'legacy-identity-inputs.json'}.items():
        fixture[name+'_path'], fixture[name+'_sha256'] = str(path), sha(path)
    run(repo, out, 'fixture-fragment', [sys.executable, str(runtime/'write_verifier_fixture_fields.py'), '--runtime', str(runtime), '--python', str(Path(sys.executable).resolve()), '--node', node, '--plan', str(out/'public-plan.json'), '--output', str(out/'fragment.disabled.json')], env)
    fixture.update(load(out/'fragment.disabled.json'))
    fixture['public_consumer_artifact_sha256'] = fixture['qualification_observer_sha256']
    fixture.update(token_execution_enabled=False, token_family_path=str(out/'token-family.disabled.json'),
                   token_family_sha256=sha(out/'token-family.disabled.json'))
    save(out/'fixture.disabled.json', fixture)
    save(out/'registry.enabled.json', enable(registry))
    save(out/'addenda.enabled.json', enable(addenda))
    token_family.update(execution_enabled=True, candidate_execution_authorized=True)
    save(out/'token-family.enabled.json', token_family)
    fixture.update(candidate_execution_authorized=True, public_lifecycle_execution_enabled=True,
                   supplement_addenda_path=str(out/'addenda.enabled.json'), supplement_addenda_sha256=sha(out/'addenda.enabled.json'),
                   token_execution_enabled=True, token_family_path=str(out/'token-family.enabled.json'),
                   token_family_sha256=sha(out/'token-family.enabled.json'))
    save(out/'fixture.enabled.json', fixture)
    permit = {'source_head': args.expected_head, 'platform': 'windows', 'candidate_execution_authorized': True,
              'fixture_sha256': sha(out/'fixture.enabled.json'), 'registry_sha256': sha(out/'registry.enabled.json'),
              'addenda_sha256': fixture['supplement_addenda_sha256'], 'root_authority': args.root_authority,
              'token_execution_authorized': True, 'token_family_sha256': fixture['token_family_sha256'],
              'prior_native_review_reference_sha256': args.prerequisite_proof_sha256,
              'scope': 'Authorized observation acquisition only; no automatic qualification or R0.'}
    save(out/'root-execution-permit.json', permit)
    require(snapshot(repo, args.expected_head) == before, 'source drift before query')
    run(repo, out, 'observer-list', [fixture['qualification_observer_path'], '--list'], env, timeout=30)
    listing = (out/'observer-list.stdout').read_text()
    original_name, supplement_name = observer_name(listing, ORIGINAL), observer_name(listing, SUPPLEMENT)
    env.update(SEMCTX_PROCESS_HELPER=fixture['helper_path'], SEMCTX_QUALIFICATION_FREEZE_MANIFEST=str(out/'fixture.enabled.json'),
               SEMCTX_QUALIFICATION_RUN_SIGNAL='stage5-optimized-frozen-stage6-authorized', SEMCTX_QUALIFICATION_EVIDENCE=str(out/'original-evidence'))
    original = run(repo, out, 'original-native', [fixture['qualification_observer_path'], original_name, '--exact', '--nocapture'], env, required=False)
    env.update(SEMCTX_SUPPLEMENT_REGISTRY=str(out/'registry.enabled.json'), SEMCTX_SUPPLEMENT_FIXTURE=str(out/'fixture.enabled.json'),
               SEMCTX_SUPPLEMENT_PERMIT=str(out/'root-execution-permit.json'), SEMCTX_SUPPLEMENT_EVIDENCE=str(supplement_out))
    supplement = run(repo, out, 'supplement-native', [fixture['qualification_observer_path'], supplement_name, '--ignored', '--exact', '--nocapture'], env, required=False, timeout=1800)
    after = snapshot(repo, args.expected_head)
    save(out/'source-after.json', after)
    require(after == before, 'source drift during native campaigns')
    for name in artifacts:
        require(sha(fixture[name+'_path']) == fixture[name+'_sha256'], 'frozen artifact drift')
    reports = ['original-evidence/report.json', 'original-evidence/obligation-closure.json', 'supplement-evidence/source-results.json', 'supplement-evidence/addenda-results.json', 'supplement-evidence/public/public-report.json', 'supplement-evidence/supplement-report.json', 'supplement-evidence/token-results.json', 'supplement-evidence/token-guards/process-outcome.json', 'supplement-evidence/token-guards/token-report.json']
    original_report = out/'original-evidence/report.json'
    supplement_report = out/'supplement-evidence/supplement-report.json'
    observed = None
    if supplement_report.is_file():
        raw_supplement = load(supplement_report)
        digest_dispositions = additional_digest_dispositions(repo, supplement_out, raw_supplement, fixture)
        diagnostic = configuration_6046_disposition(repo, supplement_out, raw_supplement, fixture, load(out/'public-plan.json'))
        save(out/'additional-digest-representations.json', digest_dispositions)
        save(out/'configuration-message-representation.json', diagnostic)
        observed = supplement_counts(raw_supplement, digest_dispositions, diagnostic)
        observed['token_nonpass'] = token_nonpass(raw_supplement.get('token_guards'))
    original_counts = None
    if original_report.is_file():
        raw = load(original_report)
        require(len(raw['units']) == 354 and len(raw['supports']) == 51 and len(raw['obligations']) == 240, 'original result denominator differs')
        original_counts = {'unit_raw_nonpass': sum(row.get('pass') is not True for row in raw['units']),
                           'support_raw_nonpass': sum(row.get('pass') is not True for row in raw['supports'])}
    save(out/'acquisition-summary.json', {'source_head': args.expected_head, 'original_exit_code': original['exit_code'],
        'supplement_exit_code': supplement['exit_code'], 'reports': {p: sha(out/p) for p in reports if (out/p).is_file()},
        'original_raw_counts': original_counts, 'supplement_observation_nonpass': observed,
        'attempts': 1, 'qualified': False, 'qualification_credit': 0, 'R0_decision': None,
        'root_prior_review_reference_sha256': args.prerequisite_proof_sha256, 'prior_native_review_independently_verified_by_this_runner': False})
    require(original['exit_code'] == 0 and supplement['exit_code'] == 0, 'native acquisition failed; raw evidence retained')
    required_counts = ('source_nonpass', 'digest_nonpass', 'addenda_nonpass', 'public_nonpass', 'token_nonpass')
    require(original_counts is not None and observed is not None and not any(observed[key] for key in required_counts),
            'supplement contains unknown/nonmatching required observations; inspect raw evidence and scoped dispositions')


if __name__ == '__main__':
    main()
