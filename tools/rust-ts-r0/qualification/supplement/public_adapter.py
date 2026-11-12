"""Public supplement v2 draft ABI. Pure planning only; no subprocess/native entrypoint."""
import argparse
import base64
import hashlib
import json
from pathlib import Path, PurePosixPath

MANIFEST_SHA = '923a03767cd5f675c66f4a35b458dcd6f38554fe3c41f90f5a83eebc7292ddc6'
OPTIONS_TS = {'target': 9, 'module': 99, 'moduleResolution': 100, 'allowJs': True,
              'jsx': 1, 'skipLibCheck': True, 'noEmit': True, 'strict': False}
OPTIONS_NATIVE = dict(OPTIONS_TS, target='ES2022', module='ESNext',
                      moduleResolution='Bundler', jsx='Preserve')
ROUTES = {
    'discoverRepository': ('repository.discover', 'repository_replay', '--discover-repository'),
    'analyzeRepository': ('repository.analyze', 'repository_replay', '--analyze-retained-discovery'),
    'analyzeRepositoryAsync': ('repository.analyze-with-workers', 'parallel', '--extract-parallel'),
    'extractTypeScript': ('typescript.extract', 'raw', None),
    'extractTypeScriptParallel': ('typescript.extract-with-workers', 'parallel', '--extract-parallel'),
    '__partitionTypeScriptRootsForTesting': ('typescript.partition-roots', 'raw', None),
    'inspectJavaScriptSource': ('javascript.inspect', 'raw', None),
    'inspectNativeModuleBindings': ('native-bindings.inspect', 'raw', None),
    'inspectModuleConfiguration': ('module-configuration.inspect', 'raw', None),
    'resolveTypeScriptModule': ('typescript.resolve-module', 'raw', '--observe-configured-resolution'),
    'registerOpaqueCallbackOwnership': ('ownership.register-extracted-graph', 'legacy_identity', None),
    'extractRelativeImportSpecifiers': ('pilot.relative-specifiers', 'primitive', '--observe-primitives'),
    'indexRepository': ('repository.index', 'qualified_flow_cli', None),
    'runVerify': ('repository.verify', 'qualified_flow_cli', None),
    'inspectRetainedQualifiedScope': ('qualification.inspect-retained-scope', 'qualified_flow_cli', None),
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def load(path):
    return json.loads(Path(path).read_bytes())


def ref(path, pointer=''):
    return {'path': str(path).replace('\\', '/'), 'json_pointer': pointer,
            'sha256': digest(Path(path).read_bytes())}


def options_to_native(options):
    # Exact equality including types: bool is not an integer in the JSON contract.
    if canonical(options) != canonical(OPTIONS_TS):
        return {'status': 'UNKNOWN', 'reason': 'UNSUPPORTED_EXPLICIT_OPTIONS', 'original': options}
    return {'status': 'DRAFT', 'value': OPTIONS_NATIVE.copy(), 'original': options}


def validate_closure(entries):
    """Validate bytes and paths without reading source payloads outside the frozen input."""
    seen = set()
    for item in entries:
        name = item['path']
        path = PurePosixPath(name)
        if (path.is_absolute() or '\\' in name or ':' in name or '\x00' in name
                or any(p in ('', '.', '..') for p in name.split('/'))):
            raise ValueError('unsafe fixture path')
        key = (item['root'], name)
        if key in seen:
            raise ValueError('duplicate fixture path')
        seen.add(key)
        if 'symlink' in item:
            if 'bytesBase64' in item or '\x00' in item['symlink']:
                raise ValueError('ambiguous symlink')
        else:
            raw = base64.b64decode(item['bytesBase64'], validate=True)
            if len(raw) != item['size'] or digest(raw) != item['sha256']:
                raise ValueError('fixture byte mismatch')
    return True


def normalize_path(value):
    return value.replace('\\', '/')


def fixture_plan(entries):
    validate_closure(entries)
    roots = sorted({normalize_path(e['root']) for e in entries}, key=lambda s: (-len(s), s))
    mapping = {root: f'$CASE/fixture-{i:03d}' for i, root in enumerate(roots)}
    def relocate(value):
        if isinstance(value, str):
            normalized = normalize_path(value)
            for root, target in mapping.items():
                if normalized == root or normalized.startswith(root + '/'):
                    return target + normalized[len(root):]
            return value
        if isinstance(value, list):
            return [relocate(v) for v in value]
        if isinstance(value, dict):
            return {k: relocate(v) for k, v in value.items()}
        return value
    planned = []
    gaps = []
    for entry in entries:
        item = dict(entry, destination=relocate(normalize_path(entry['root']) + '/' + entry['path']))
        if 'symlink' in entry:
            item['relocated_target'] = relocate(entry['symlink'])
            if item['relocated_target'] == entry['symlink']:
                gaps.append('UNBOUND_SYMLINK_TARGET:' + entry['path'])
        planned.append(item)
    return {'root_relocations': mapping, 'entries': planned, 'gaps': gaps}, relocate


def map_handles(value, handles=None):
    """Keep identity and entry order; divergent same-handle snapshots are never overwritten."""
    handles = {} if handles is None else handles
    if isinstance(value, dict):
        if '$map' in value:
            key = str(value['$mapIdentity'])
            snapshot = canonical(value['$map'])
            if key in handles and handles[key] != snapshot:
                raise ValueError('map identity has divergent snapshot; lifecycle adapter required')
            handles[key] = snapshot
        for child in value.values():
            map_handles(child, handles)
    elif isinstance(value, list):
        for child in value:
            map_handles(child, handles)
    return handles


def build_registry(frozen_root):
    from public_runtime import prepare_operation, Gap
    root = Path(frozen_root)
    manifest = root / 'manifest-sha256.json'
    if digest(manifest.read_bytes()) != MANIFEST_SHA:
        raise ValueError('foreign frozen manifest')
    inventory = {e['path']: e for e in load(manifest)['files']}
    def verified(relative):
        record = inventory[relative]
        data = (root / relative).read_bytes()
        if digest(data) != record['sha256'] or len(data) != record['size']:
            raise ValueError('frozen input mismatch: ' + relative)
        return json.loads(data) if relative.endswith('.json') else data
    index = verified('public-vectors/index.json')
    verified('expected-public-projections.json')
    verified('capture.ts')
    rows = []
    for test in index['tests']:
        relative = 'public-vectors/' + test['file']
        vector = verified(relative)
        if len(vector['operations']) != test['operationCount']:
            raise ValueError('operation denominator mismatch')
        stream = 'observed/primary/public/' + vector['rawStream']['file']
        stream_bytes = (root / stream).read_bytes()
        if digest(stream_bytes) != vector['rawStream']['sha256'] or digest(stream_bytes) != inventory[stream]['sha256']:
            raise ValueError('foreign capture stream')
        mappings, recipes, gaps = [], [], []
        for position, operation in enumerate(vector['operations']):
            function = operation['baselineFunction']
            abstract, surface, mode = ROUTES[function]
            pointer = '/operations/' + str(position)
            plan, relocate = fixture_plan(operation['request']['fixtureClosure'])
            args = operation['request']['arguments']
            map_handles(args)
            local_gaps = list(plan['gaps'])
            programs = [p for p in vector['actualSemanticPrograms'] if p['parent'] == operation['sequence']]
            option_translations = [options_to_native(p['options']) for p in programs]
            if any(p['status'] == 'UNKNOWN' for p in option_translations):
                local_gaps.append('UNSUPPORTED_ACTUAL_PROGRAM_OPTIONS')
            prepared = None
            try:
                prepared = prepare_operation(root, test['id'], operation['sequence'], '/case', '/sdk/lib', False)
            except Gap as error:
                local_gaps.append(str(error))
            mappings.append({'sequence': operation['sequence'], 'parent': operation['parent'],
                'baseline_function': function, 'frozen_operation': operation['request']['operation'],
                'abstract_operation': abstract, 'surface': surface, 'mode': mode,
                'overlay_only': function == 'inspectRetainedQualifiedScope',
                'status': 'DRAFT_DTO' if prepared is not None else 'UNKNOWN'})
            recipes.append({'sequence': operation['sequence'], 'execution_enabled': False,
                'status': 'PREPARED_NOT_RUN' if prepared is not None else 'UNKNOWN',
                'surface': prepared['surface'] if prepared is not None else surface,
                'adapter': 'public_runtime.prepare_operation', 'projector': 'public_runtime.project_operation',
                'adapter_arguments': {'row_id': test['id'], 'sequence': operation['sequence']},
                'request_ref': ref(root / relative, pointer + '/request'),
                'expected_ref': ref(root / relative, pointer + '/normalizedProjection'),
                'raw_expected_ref': ref(root / relative, pointer + '/expectedBaseline'),
                'fixture_ref': ref(root / relative, pointer + '/request/fixtureClosure'),
                'actual_programs_ref': ref(root / relative, '/actualSemanticPrograms'),
                'parser_contracts_ref': ref(root / relative, '/sourceFileParserContracts'),
                'required_evidence': ['request_digest', 'producer_artifact_sha256', 'sdk_descriptor_digest',
                    'capture_stream_sha256', 'complete_stdout_stderr_bytes_and_hashes', 'input_manifest_digest',
                    'capture_probes', 'canonical_path_case_mode', 'global_admission_inferred_false'],
                'gaps': local_gaps})
            gaps.extend(local_gaps)
        if test['id'].startswith('scope-admission-'):
            gaps.append('GLOBAL_ADMISSION_UNKNOWN_DO_NOT_PROMOTE_COMPONENT_REASONS')
        gaps.append('UNKNOWN_PUBLIC_RUNTIME_RUST_BRIDGE')
        rows.append({'id': test['id'], 'kind': 'public-baseline-vector',
            'entrypoint': 'public_adapter_cli',
            'integration_status': 'PURE_TRANSLATORS_READY_NATIVE_DISPATCH_NOT_CONNECTED',
            'expected_refs': [ref(root / relative, '/operations'), ref(root / 'expected-public-projections.json')],
            'input_refs': [ref(root / relative), ref(root / stream), ref(root / 'capture.ts'),
                ref(root / 'v1-preserved/observed/typescript-sdk-manifest.json')],
            'operation_mappings': mappings, 'recipes': recipes, 'gaps': sorted(set(gaps))})
    if len(rows) != 25 or sum(len(r['operation_mappings']) for r in rows) != 677:
        raise ValueError('public denominator changed')
    return {'schema_version': 1, 'manifest_sha256': MANIFEST_SHA, 'rows': rows}


def compare(expected, actual, binding, raw_stdout, raw_stderr, recipe=None):
    """Strict public projection comparison; UNKNOWN until complete bound evidence exists."""
    required = ('request_digest', 'producer_artifact_sha256', 'sdk_descriptor_digest',
                'capture_stream_sha256', 'input_manifest_digest')
    if (not isinstance(actual, dict) or any(not binding.get(k) for k in required)
            or actual.get('binding') != binding or actual.get('global_admission_inferred') is not False
            or actual.get('complete') is not True or actual.get('unsupported') != []
            or not isinstance(actual.get('capture_probes'), list)):
        return {'status': 'UNKNOWN', 'reason': 'MISSING_OR_FOREIGN_EVIDENCE'}
    for name, raw in [('stdout', raw_stdout), ('stderr', raw_stderr)]:
        evidence = actual.get('capture', {}).get(name, {})
        if evidence != {'sha256': digest(raw), 'bytes': len(raw)}:
            return {'status': 'UNKNOWN', 'reason': 'INCOMPLETE_RAW_CAPTURE'}
    try:
        native = json.loads(raw_stdout)
    except (ValueError, UnicodeDecodeError):
        return {'status': 'UNKNOWN', 'reason': 'NATIVE_JSON_ABSENT'}
    dto = recipe.get('native_dto') if isinstance(recipe, dict) else None
    if not dto or dto.get('operation') != 'relative_import_specifiers':
        return {'status': 'UNKNOWN', 'reason': 'PUBLIC_TRANSLATOR_NOT_IMPLEMENTED'}
    # This DTO has only non-numeric ASCII field names, for which sorted JSON equals
    # the Rust identity canonicalizer. Other DTOs need its full numeric/UTF16 rules.
    request_digest = 'sha256:' + digest(canonical(dto))
    if (binding['request_digest'] != request_digest or native.get('request_descriptor_id') != request_digest
            or native.get('producer_artifact_id') != binding['producer_artifact_sha256']
            or native.get('operation') != 'relative_import_specifiers'
            or native.get('runtime_dependency_claim') is not False
            or native.get('executed') is not True or native.get('unsupported') != []
            or not isinstance(native.get('specifiers'), list)
            or any(not isinstance(s, str) for s in native.get('specifiers', []))):
        return {'status': 'UNKNOWN', 'reason': 'FOREIGN_NATIVE_PRIMITIVE'}
    projection = {'output': native['specifiers']}
    return {'status': 'MATCH' if canonical(projection) == canonical(expected) else 'MISMATCH',
            'claim': 'public-component-projection-only', 'global_admission': 'UNKNOWN'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--frozen', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    result = build_registry(args.frozen)
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
