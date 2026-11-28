"""Supplementary exact Windows token fields only. Never modifies or promotes C4.

Only the invocation request comparison changes: separator substitution and an exact
acquisition-owned request path replace the frozen suffix comparison. All remaining
tokens() and token_context() checks execute before comparison credit is reported.
No compiler, SDK, model, admission or native query is performed.
"""
import argparse
import ast
import difflib
import gzip
import hashlib
import importlib
import inspect
import json
from pathlib import Path, PureWindowsPath
import subprocess
import sys
import adapt_windows_raw as custody

SOURCE = '3309e011184893b41b97491622fd31880982cab6'
PROTOCOL = 'c4e8cc4c2431c0250cefd4ee61e846c4c0eebcd188198e6bab7d11d5beb18303'
SDK = 'f57257876a383d13839a94adefb42b3d40bad2e93489a0f1a5ab29f045f139e5'
PACKAGE = 'tools/rust-ts-r0/qualification/property_assessor/'
COORDINATES = [(232, 1), (234, 1), (238, 1)]
API = q = token_context = projected = read = pin = require = None


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def check(value, message):
    if not value:
        raise ValueError(message)


def same_request_path(raw, expected):
    return isinstance(raw, str) and isinstance(expected, str) and raw.replace('\\', '/') == expected.replace('\\', '/')


def configure(api, carriers):
    """Configure our own bindings; frozen functions and assertions stay untouched."""
    global API, q, token_context, projected, read, pin, require
    API = api
    carriers.configure(api)
    q, token_context, projected = carriers.q, carriers.token_context, carriers.projected
    read, pin, require = carriers.read, carriers.pin, carriers.require


def windows_tokens(host,coordinate):
    base=host['root']/'evidence/token-guards';plan=host.get('token_family')
    require(isinstance(plan,dict),'explicit pinned token_family host input required')
    require(plan['execution_enabled'] is True and plan['candidate_execution_authorized'] is True and host['fixture']['token_execution_enabled'] is True,'actual token family disabled')
    expected=read(API.REPO/'docs/research/rust-ts-r0/cases/supplement-token-guards-20261021/expected.json')
    require(plan['expected']==expected and plan['counts']=={'issuance':13,'revalidation':7,'map_identity':1},'token expected/input denominator differs')
    import token_inputs
    frozen_plan=token_inputs.prepare(API.REPO/'docs/research/rust-ts-r0/cases/supplement-token-guards-20261021');frozen_plan['package_root']=plan['package_root']
    normalized=dict(plan,execution_enabled=False,candidate_execution_authorized=False);require(normalized==frozen_plan,'token full frozen fixture/Program/options input differs')
    request=read(base/'request.json');API.verify_request_template(request,plan['request_template']);require(request['id']==plan['request_template']['id'],'token request ID differs')
    outcome=read(base/'process-outcome.json');q.process(outcome);raw=json.loads(outcome['stdout']);actual=read(base/'actual-token-observations.json')
    invocation=read(base/'process-invocation.json');require(invocation['native_queries']==1 and invocation['cwd']==request['cwd'] and len(invocation['argv'])==3 and invocation['argv'][0]==host['fixture']['artifact_path'] and same_request_path(invocation['argv'][1],API.expected_request_path) and invocation['argv'][2]==host['fixture']['sdk_path'],'token actual invocation context differs')
    provenance=token_context(raw,request,host,actual,outcome['stdout_hash'])
    report=read(base/'token-report.json');require(report['actual']==actual and report['expected']==expected and read(host['root']/'evidence/token-results.json')==report,'token report substituted')
    require(report['native_queries']==1 and report['counts']==plan['counts'] and report['baseline_actual_program_records']==21 and report['qualified'] is False and all(report[k]==plan[k] for k in ('package_pin_sha256','manifest_sha256','expected_sha256')),'token actual frozen family/denominator differs')
    return {'state':'RELEVANT_PASS' if projected(actual,expected) else 'NONPASS','actual':actual,'expected':expected,'raw_refs':[pin(base/n) for n in ('request.json','process-outcome.json','process-invocation.json','actual-token-observations.json','token-report.json')],
      'scope':'Frozen13 issuance+7 revalidation+1 Map identity over actual bound native ownership context; controlled seals, no index-store attestation','binding':provenance,'coordinate':coordinate}

def copied_reader_diff(frozen):
    tree = ast.parse(frozen)
    original = ast.get_source_segment(frozen, next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'tokens'))
    candidate = inspect.getsource(windows_tokens).rstrip()
    restored = candidate.replace('def windows_tokens(', 'def tokens(').replace(
        "same_request_path(invocation['argv'][1],API.expected_request_path)",
        "invocation['argv'][1].endswith('/token-guards/request.json')")
    check(restored == original, 'copied token reader differs beyond approved path predicate')
    return ''.join(difflib.unified_diff(original.splitlines(True), candidate.splitlines(True),
                                      fromfile='C4/tokens', tofile='supplement/windows_tokens'))


def git_source(repo, path):
    return subprocess.check_output(['git', '--no-replace-objects', '-C', str(repo), 'show', SOURCE + ':' + path])


def pinned(path, expected):
    raw = custody.regular(path).read_bytes()
    check(sha(raw) == expected, 'pinned input differs: ' + str(path))
    return custody.document(raw)


def prepare(repo, protocol, protocol_sha256, cache):
    """Pre-outcome dependency/source audit. Reads no acquisition outcomes."""
    custody.protect_shipped_writes((cache,), (repo, protocol), (__file__,))
    check(protocol_sha256 == PROTOCOL and sha(protocol.read_bytes()) == PROTOCOL, 'C4 protocol differs')
    raw = protocol.read_bytes()
    scope = custody.document(gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw)
    check(len(scope['verifier_git_sources']) == 139, 'C4 source denominator differs')
    joins = {}
    for name, expected in scope['verifier_git_sources'].items():
        data = git_source(repo, name)
        check(sha(data) == expected['sha256'], 'C4 source Git pin differs: ' + name)
        joins[name] = sha(data)
    # Git33 is the authority for dependency bytes. The historical package manifest
    # supplies names only; its stale unrelated helper claims do not gate C4 tokens.
    package_manifest = json.loads(git_source(repo, PACKAGE + 'package-manifest.json'))
    check(not cache.exists(), 'fresh cache required')
    cache.mkdir(parents=True)
    dependencies = {}
    for name in package_manifest['files']:
        if not name.endswith('.py'):
            continue
        check(Path(name).name == name, 'unsafe helper name')
        data = git_source(repo, PACKAGE + name)
        (cache / name).write_bytes(data)
        dependencies[name] = {'sha256': sha(data), 'bytes': len(data)}
    diff = copied_reader_diff((cache / 'remaining_carriers.py').read_text())
    # Only these exact Git33 modules can supply the helper API in this process.
    for name in dependencies:
        check(name[:-3] not in sys.modules, 'preloaded frozen helper refused: ' + name)
    sys.path.insert(0, str(cache))
    a = importlib.import_module('assess_final')
    a.REPO, a.CACHE, a.SCOPE_MAP = repo, cache / 'projectors', protocol
    a.scope_protocol()  # Includes all frozen case/expectation byte checks.
    carriers = importlib.import_module('remaining_carriers')
    token_inputs = importlib.import_module('token_inputs')
    plan = token_inputs.prepare(repo / 'docs/research/rust-ts-r0/cases/supplement-token-guards-20261021')
    api = a.adapter_api()
    metadata = {'kind': 'WINDOWS_TOKEN_FIELDS_PREOUTCOME_SOURCE_FREEZE', 'source_head': SOURCE,
                'protocol_sha256': PROTOCOL, 'sdk_sha256': SDK, 'source_joins': joins,
                'helper_dependencies': dependencies, 'copied_reader_full_diff': diff,
                'verifier_sha256': sha(Path(__file__).read_bytes()),
                'token_freeze': {k: plan[k] for k in ('package_pin_sha256', 'manifest_sha256', 'expected_sha256', 'counts')},
                'coordinates': [list(c) for c in COORDINATES],
                'expected_request_relative': 'supplement-evidence/token-guards/request.json',
                'sole_normalization': 'local argv[1] and expected native request separator substitution',
                'native_queries': 0,
                'qualified': False, 'qualification_credit': 0, 'R0_decision': None}
    return a, api, carriers, metadata


def assessment_rows(c4, baseline):
    properties, coordinates, supports = [], [], []
    for row in c4['rows']:
        check(isinstance(row, dict), 'C4 row object required')
        if row.get('kind') == 'property':
            coordinate = row.get('coordinate')
            check(isinstance(coordinate, dict) and set(coordinate) == {'obligation_index', 'property_index'}
                  and all(type(coordinate[k]) is int and coordinate[k] >= 0 for k in coordinate),
                  'C4 property coordinate types differ')
            properties.append(row)
            coordinates.append((coordinate['obligation_index'], coordinate['property_index']))
        elif row.get('kind') == 'support':
            check(isinstance(row.get('support_id'), str), 'C4 support identity absent')
            supports.append(row['support_id'])
        else:
            raise ValueError('C4 unknown row kind')
    expected_coordinates = [(r['coordinate']['obligation_index'], r['coordinate']['property_index'])
                            for r in baseline if r['kind'] == 'property']
    expected_supports = [r['support_id'] for r in baseline if r['kind'] == 'support']
    check(len(coordinates) == len(set(coordinates)) == 395 and set(coordinates) == set(expected_coordinates),
          'C4 property coordinates differ from frozen baseline')
    check(len(supports) == len(set(supports)) == 51 and set(supports) == set(expected_supports),
          'C4 support identities differ from frozen baseline')
    return properties


def _evaluate(a, api, carriers, context, c4):
    manifest = context['manifest']
    native_raw_root = context['native_raw_root']
    registration = context['documents']['registration']
    inventory = context['documents']['inventory']
    check(manifest['expected_source_head'] == SOURCE and manifest['evaluation_protocol_sha256'] == PROTOCOL,
          'manifest source/protocol differs')
    check(set(manifest['hosts']) == {'windows'}, 'exact Windows host required')
    check(c4['kind'] == 'DETERMINISTIC_CURRENT_FIELD_ASSESSMENT' and c4['candidate_head'] == SOURCE,
          'C4 assessment kind/source differs')
    check(c4['qualified'] is False and type(c4['qualification_credit']) is int and c4['qualification_credit'] == 0 and c4['R0_decision'] is None,
          'C4 assessment qualification boundary differs')
    check(c4['evaluation_protocol_ref']['sha256'] == PROTOCOL and len(c4['rows']) == 446,
          'C4 assessment protocol/denominator differs')
    properties = assessment_rows(c4, a.scope_protocol()['baseline_rows'])
    selected = []
    for coordinate in COORDINATES:
        rows = [r for r in properties if (r['coordinate']['obligation_index'], r['coordinate']['property_index']) == coordinate]
        check(len(rows) == 1 and 'windows' in rows[0]['hosts'], 'C4 token coordinate/host absent or duplicate')
        selected.append(rows[0])
    core = {'source_head', 'protocol_sha256', 'sdk_sha256', 'verifier_sha256', 'coordinates',
            'expected_request_relative', 'output_relative', 'readback_head', 'adapter_sha256', 'caller_head'}
    check(core <= set(registration) <= core | {'public_bindings'}, 'registration fields differ')
    check(all(isinstance(registration[k], str) and registration[k] for k in core - {'coordinates'}),
          'registration string fields required')
    for field in ('readback_head', 'caller_head'):
        check(len(registration[field]) == 40 and all(c in '0123456789abcdef' for c in registration[field]),
              'registration Git epoch invalid')
    check(isinstance(registration.get('public_bindings', {}), dict)
          and all(isinstance(k, str) and isinstance(v, str) for k, v in registration.get('public_bindings', {}).items()),
          'registration public bindings must be strings')
    check(registration['expected_request_relative'] == 'supplement-evidence/token-guards/request.json',
          'registered request relative path differs')
    output_parts = registration['output_relative'].split('/')
    check(len(output_parts) == 2 and output_parts[0] == 'windows-raw'
          and output_parts[1] not in ('', '.', '..') and '\\' not in output_parts[1],
          'registered campaign output scope differs')
    check(inventory['kind'] == 'WINDOWS_R0_RAW_EXPORT_INVENTORY' and inventory['complete'] is True
          and type(inventory['schema_version']) is int and inventory['schema_version'] == 1, 'complete native inventory required')
    check(inventory['native_raw_root'] == native_raw_root and inventory['source_head'] == SOURCE
          and inventory['protocol_sha256'] == PROTOCOL and inventory['sdk_sha256'] == SDK
          and inventory['caller_head'] == registration['caller_head'], 'inventory native root/epoch differs')
    raw_root = PureWindowsPath(native_raw_root)
    check(raw_root.is_absolute() and '..' not in raw_root.parts and tuple(raw_root.parts[-2:]) == tuple(output_parts),
          'absolute owned native campaign root required')
    host_manifest = manifest['hosts']['windows']
    docs, identity = a.final_join.validate_host_epoch(host_manifest, SOURCE, 'windows')
    # load_host() uses this same unchanged validator result as its identity.
    # Join the complete campaign identity, including every receipt/file reference.
    check(c4.get('host_bindings', {}).get('windows') == identity, 'C4 host binding differs')
    fixture = docs['supplement.fixture']
    check(fixture['sdk_sha256'] == SDK, 'canonical SDK differs')
    for field, basename in [('token_family_path', 'token-family.enabled.json'), ('build_environment_path', 'build_environment.json')]:
        check(same_request_path(fixture[field], str(raw_root / basename)), 'fixture owned native root differs: ' + field)
    plan = a.load_pin(host_manifest['token_family'])
    check(host_manifest['token_family']['sha256'] == fixture['token_family_sha256'], 'token family fixture pin differs')
    host = {'root': Path(host_manifest['raw_root']), 'fixture': fixture,
            'sdk': a.load_pin(host_manifest['artifact_files']['sdk']), 'token_family': plan, 'source_head': SOURCE}
    check(host['sdk']['version'] == '5.9.3', 'SDK version differs')
    expected = str(raw_root / 'supplement-evidence' / 'token-guards' / 'request.json')
    check(registration['source_head'] == SOURCE and registration['protocol_sha256'] == PROTOCOL
          and registration['sdk_sha256'] == SDK and registration['verifier_sha256'] == sha(Path(__file__).read_bytes())
          and registration['coordinates'] == [list(c) for c in COORDINATES], 'registration scope/epoch differs')
    api.expected_request_path = expected
    configure(api, carriers)
    evidence = host['root'] / 'evidence'
    paths = [evidence / 'token-guards' / name for name in (
        'request.json', 'process-outcome.json', 'process-invocation.json',
        'actual-token-observations.json', 'token-report.json')]
    paths.append(evidence / 'token-results.json')
    raw_before = {str(path): sha(path.read_bytes()) for path in paths}
    invocation = json.loads((evidence / 'token-guards/process-invocation.json').read_bytes())
    raw_path = invocation['argv'][1]
    comparison = {'raw': raw_path, 'normalized': raw_path.replace('\\', '/'),
                  'expected_raw': expected, 'expected_normalized': expected.replace('\\', '/')}
    # Start the complete reader at its first check. An exception is a GAP and
    # explicitly records that later checks were not completed, never assumed.
    try:
        fields = windows_tokens(host, {'obligation_index': 232, 'property_index': 1})
        result = {'verdict': 'WINDOWS_TOKEN_FIELDS_MATCH' if fields['state'] == 'RELEVANT_PASS' else 'WINDOWS_TOKEN_FIELDS_DIFFER',
                  'fields': fields, 'complete_token_checks_executed': True}
    except (AssertionError, ValueError, TypeError, KeyError, IndexError, OSError, StopIteration) as error:
        result = {'verdict': 'WINDOWS_TOKEN_FIELDS_GAP', 'gap': str(error),
                  'complete_token_checks_executed': False}
    check(raw_before == {str(path): sha(path.read_bytes()) for path in paths}, 'raw token files changed during read')
    result.update(coordinates=[list(c) for c in COORDINATES], c4_rows_preserved=selected,
                  request_path_comparison=comparison, raw_file_sha256=raw_before, host_epoch=identity)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('repo', 'protocol', 'output', 'cache', 'readback-repo'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--protocol-sha256', required=True)
    parser.add_argument('--freeze-only', action='store_true')
    for name in ('manifest', 'c4-assessment', 'registration', 'inventory', 'ledger'):
        parser.add_argument('--' + name, type=Path)
        parser.add_argument('--' + name + '-sha256')
    for name in ('export-root', 'caller-repo'):
        parser.add_argument('--' + name, type=Path)
    args = parser.parse_args(argv)
    check(not args.output.exists(), 'fresh output required')
    repo, cache, output, readback_repo, protocol = map(custody.safe_path,
        (args.repo, args.cache, args.output, args.readback_repo, args.protocol))
    custody.protect_shipped_writes((cache, output), (repo, readback_repo, protocol), (__file__,))
    check(custody.regular(readback_repo / 'tools/rust-ts-r0/qualification/windows_token_fields.py').read_bytes()
          == custody.regular(__file__).read_bytes(), 'executing verifier differs from W source')
    references = {name: {'path': str(getattr(args, name)), 'sha256': getattr(args, name + '_sha256')}
                  for name in ('manifest', 'inventory', 'registration', 'ledger')}
    protocol = custody.regular(protocol)
    check(custody.regular(custody.__file__).read_bytes() == custody.regular(readback_repo / 'tools/rust-ts-r0/qualification/adapt_windows_raw.py').read_bytes(),
          'executing adapter differs from W source')
    context = None
    if not args.freeze_only:
        check(all((args.export_root, args.caller_repo, args.c4_assessment, args.c4_assessment_sha256))
              and all(getattr(args, name) and getattr(args, name + '_sha256') for name in references),
              'explicit pinned custody inputs required')
        custody.disjoint_writes((cache, output), (args.c4_assessment,))
        custody_args = dict(**references, export_root=args.export_root, source_repo=repo,
                            caller_repo=args.caller_repo, readback_repo=readback_repo, cache=cache, output=output)
        context = custody.verify_transport(**custody_args)
        c4 = pinned(args.c4_assessment, args.c4_assessment_sha256)
    a, api, carriers, metadata = prepare(repo, protocol, args.protocol_sha256, cache)
    metadata.update(readback_head=subprocess.check_output(['git', '-C', str(readback_repo), 'rev-parse', 'HEAD']).decode().strip(),
                    adapter_sha256=sha(custody.regular(readback_repo / 'tools/rust-ts-r0/qualification/adapt_windows_raw.py').read_bytes()),
                    readback_status=subprocess.check_output(['git', '-C', str(readback_repo), 'status', '--porcelain']).decode())
    result = metadata
    if context is not None:
        try:
            result = _evaluate(a, api, carriers, context, c4)
        except (AssertionError, ValueError, TypeError, KeyError, IndexError, OSError, StopIteration) as error:
            result = {'verdict': 'WINDOWS_TOKEN_FIELDS_GAP', 'gap': str(error)}
        result.update(kind='SUPPLEMENTARY_WINDOWS_TOKEN_FIELDS', freeze=metadata,
                      input_sha256={name: reference['sha256'] for name, reference in references.items()},
                      c4_assessment_sha256=args.c4_assessment_sha256,
                      registration=context['documents']['registration'], native_queries=0,
                      qualified=False, qualification_credit=0, R0_decision=None)
        check(custody.verify_transport(**custody_args) == context, 'verified custody changed during read')
        pinned(args.c4_assessment, args.c4_assessment_sha256)
    custody.protect_shipped_writes((cache, output), (repo, readback_repo, protocol), (__file__,))
    with output.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
    return 0 if result.get('verdict', '').endswith('MATCH') or args.freeze_only else 1


if __name__ == '__main__':
    raise SystemExit(main())
