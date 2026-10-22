"""Operational public request/projection translators. No process execution code."""
import json
import re
from pathlib import Path
import public_adapter as a
import directory_closure


class Gap(ValueError):
    pass


def resolve_ref(reference):
    path = Path(reference['path'])
    raw = path.read_bytes()
    if a.digest(raw) != reference['sha256']:
        raise Gap('FROZEN_REFERENCE_HASH_MISMATCH')
    value = json.loads(raw)
    for segment in reference.get('json_pointer', '').split('/')[1:]:
        key = segment.replace('~1', '/').replace('~0', '~')
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


def undefined(value):
    return value is None or value == {'$undefined': True}


def map_value(value):
    if undefined(value):
        return None
    if not isinstance(value, dict) or '$map' not in value:
        raise Gap('INPUT_SNAPSHOT_NOT_CAPTURED_MAP')
    result = {}
    for key, text in value['$map']:
        key = a.normalize_path(key)
        if key in result:
            raise Gap('DUPLICATE_CAPTURED_MAP_KEY')
        if not undefined(text) and not isinstance(text, str):
            raise Gap('NON_TEXT_CAPTURED_MAP_VALUE')
        result[key] = text
    return result


def prepare_operation(frozen_root, row_id, sequence, case_root, sdk_directory, case_sensitive):
    """Resolve immutable refs and produce DTO + exact physical setup, without writing it.

    Caller must materialize each operation independently, then bind native process evidence.
    """
    root = Path(frozen_root)
    if a.digest((root / 'manifest-sha256.json').read_bytes()) != a.MANIFEST_SHA:
        raise Gap('FOREIGN_FROZEN_MANIFEST')
    inventory = {e['path']: e for e in a.load(root / 'manifest-sha256.json')['files']}
    rel = 'public-vectors/' + row_id + '.json'
    vector = resolve_ref({'path': str(root / rel), 'sha256': inventory[rel]['sha256']})
    matches = [o for o in vector['operations'] if o['sequence'] == sequence]
    if len(matches) != 1:
        raise Gap('OPERATION_SEQUENCE_ABSENT_OR_DUPLICATED')
    operation = matches[0]
    captured_case_modes = sorted({p['caseSensitive'] for p in vector['actualSemanticPrograms']})
    # This describes the spelling/canonical keys in the captured Windows input;
    # it does not choose or constrain the future native host's actual case mode.
    origin_case_sensitive = captured_case_modes not in ([], [False])
    args = operation['request']['arguments']
    name = operation['baselineFunction']
    closure = operation['request']['fixtureClosure']
    plan, _ = a.fixture_plan(closure)
    if plan['gaps']:
        raise Gap(';'.join(plan['gaps']))
    replacements = [(old, new.replace('$CASE', case_root)) for old, new in plan['root_relocations'].items()]
    if name == 'inspectNativeModuleBindings':
        ast_path = a.normalize_path(args[0]['fileName'])
        if not any(ast_path.startswith(old + '/') for old, _ in replacements):
            # This helper consumes a supplied SourceFile, independent of a repository.
            # Keep its authored lexical parent; do not infer a root from expectations.
            parent = ast_path.rsplit('/', 1)[0] if '/' in ast_path else '/supplied-ast'
            if not ast_path.startswith('/') and ':' not in ast_path:
                ast_path = '/supplied-ast/' + ast_path
                parent = '/supplied-ast'
            replacements.insert(0, (parent, case_root + '/supplied-ast'))
    def move(path):
        normalized = a.normalize_path(path)
        for old, new in replacements:
            candidate = normalized if origin_case_sensitive else normalized.lower()
            root_key = old if origin_case_sensitive else old.lower()
            if candidate == root_key or candidate.startswith(root_key + '/'):
                return new + normalized[len(old):]
        raise Gap('UNBOUND_ABSOLUTE_INPUT:' + path)
    physical = []
    live = {}
    for entry in closure:
        destination = move(a.normalize_path(entry['root']) + '/' + entry['path'])
        if 'symlink' in entry:
            physical.append({'path': destination, 'symlink': move(entry['symlink'])})
        else:
            blob = root / 'public-vectors' / entry['materializedBlob']
            data = blob.read_bytes()
            if a.digest(data) != entry['sha256'] or len(data) != entry['size']:
                raise Gap('FROZEN_BLOB_HASH_MISMATCH')
            physical.append({'path': destination, 'blob_ref': {'path': str(blob), 'sha256': entry['sha256']}, 'size': entry['size']})
            # Node source reads use UTF8 replacement, preserved raw bytes remain physical authority.
            live[a.normalize_path(entry['root']) + '/' + entry['path']] = data.decode('utf-8', errors='replace')
    programs = [p for p in vector['actualSemanticPrograms'] if p['parent'] == sequence]
    for program in programs:
        if a.options_to_native(program['options'])['status'] == 'UNKNOWN':
            raise Gap('UNSUPPORTED_ACTUAL_PROGRAM_OPTIONS')
    if name in ('indexRepository', 'runVerify', 'inspectRetainedQualifiedScope'):
        raise Gap('ACTUAL_GIT_INDEX_FRESHNESS_LIFECYCLE_NOT_MAPPED')
    if name == 'registerOpaqueCallbackOwnership':
        raise Gap('PERSISTENT_MAP_HANDLE_GRAPH_LIFECYCLE_NOT_MAPPED')
    result = {'row_id': row_id, 'sequence': sequence, 'baseline_function': name,
        'case_root': case_root,
        'native_host_case_sensitive': case_sensitive,
        'baseline_case_modes_metadata_only': captured_case_modes,
        'source_capture_stream_sha256': 'sha256:' + vector['rawStream']['sha256'],
        'execution_enabled': False, 'physical_setup': physical, 'relocations': replacements,
        'path_normalization': vector['pathNormalization'], 'required_sdk': '5.9.3',
        'request_ref': a.ref(root / rel, '/operations/' + str(vector['operations'].index(operation)) + '/request'),
        'expected_ref': a.ref(root / rel, '/operations/' + str(vector['operations'].index(operation)) + '/normalizedProjection'),
        'program_refs': [a.ref(root / rel, '/actualSemanticPrograms/' + str(vector['actualSemanticPrograms'].index(p))) for p in programs]}
    result.update(directory_closure.prepare(root, row_id, sequence, replacements))
    if name == 'extractRelativeImportSpecifiers':
        result.update(mode='--observe-primitives', surface='primitive_cli', request={
            'operation': 'relative_import_specifiers', 'source': args[0], 'filename': args[1]})
        return result
    config = args[0] if name in ('discoverRepository', 'analyzeRepository', 'analyzeRepositoryAsync') else None
    if config is not None:
        repository = config['repositoryRoot']
    elif name == 'inspectNativeModuleBindings':
        repository = next((old for old, _ in replacements if ast_path.startswith(old + '/')), None)
    elif name == 'resolveTypeScriptModule':
        repository = args[6] if len(args) > 6 and not undefined(args[6]) else next((old for old, _ in replacements if a.normalize_path(args[1]).startswith(old + '/')), None)
    else:
        repository = args[1] if name not in ('inspectJavaScriptSource',) else args[2]
    if not isinstance(repository, str):
        raise Gap('REPOSITORY_ROOT_NOT_BOUND')
    result['repository_root'] = move(repository)
    if name == 'discoverRepository':
        eligibility = args[1] if len(args) > 1 else config
        if eligibility.get('analysisProfile') == 'modelo-suite-static-v1':
            generated = {'dist', 'build', 'coverage', '.turbo', '.next'}
            physical_paths = [e['path'][len(move(repository).rstrip('/')) + 1:] for e in physical
                              if e['path'].startswith(move(repository).rstrip('/') + '/')]
            if any(generated.intersection(path.split('/')[:-1]) for path in physical_paths):
                raise Gap('QUALIFIED_DISCOVERY_GENERATED_PATHS_REQUIRE_NATIVE_ELIGIBILITY_AND_RETAINED_PATH_ABI')
            result['equivalence_basis'] = 'qualified eligibility returns true for all captured non-output non-hard-ignored paths; frozen closure contains no output directory paths'
        result.update(surface='repository_discovery_cli', mode='--discover-repository', request={
            'repositoryRoot': move(repository), 'config': {
                **{k: config[k] for k in ['version', 'include', 'exclude', 'migrationsDirs']},
                'languages': config.get('languages', {}) if config['version'] == 1 else config['languages']}})
        return result
    if name in ('extractTypeScriptParallel', '__partitionTypeScriptRootsForTesting'):
        if len(args) > 3 and not undefined(args[3]):
            raise Gap('PARALLEL_CAPTURED_SNAPSHOT_NOT_EXPOSED')
        result.update(surface='parallel_cli', mode='--extract-parallel', request={
            'repoRoot': move(repository), 'rootAbsPaths': [move(p) for p in args[0]], 'workers': args[2]})
        if name == '__partitionTypeScriptRootsForTesting':
            result['partition_count'] = args[2]
        return result
    snapshot = None
    target = None
    retained = False
    if name in ('extractTypeScript', '__partitionTypeScriptRootsForTesting'):
        roots = args[0]
        if name == 'extractTypeScript' and len(args) > 2:
            snapshot = map_value(args[2])
    elif name == 'inspectJavaScriptSource':
        target = args[0]
        roots = [target]
        if len(args) > 3:
            snapshot = map_value(args[3])
    elif name == 'inspectModuleConfiguration':
        target = args[0]
        roots = [target]
        if len(args) > 2:
            snapshot = map_value(args[2])
    elif name == 'inspectNativeModuleBindings':
        target = ast_path
        roots = [target]
    elif name == 'resolveTypeScriptModule':
        target = args[1]
        roots = [target]
        if not undefined(args[2]) and args[2] != 99:
            raise Gap('EXPLICIT_RESOLUTION_MODE_NOT_EXPOSED_BY_NATIVE_REQUEST')
        if args[2] == 99:
            result['resolution_mode_binding'] = 'ESNext(99), consumed by native ESNext semantic Program for the exact captured static import usage; public projection requires its actual import fact'
        if len(args) > 4:
            snapshot = map_value(args[4])
    elif name in ('analyzeRepository', 'analyzeRepositoryAsync'):
        if len(args) < 2 or not isinstance(args[1], list):
            raise Gap('ANALYSIS_DISCOVERY_RESULT_REQUIRED')
        discovered = args[1]
        if any(f['role'] not in ('source', 'test') for f in discovered):
            raise Gap('ANALYSIS_DOCUMENT_OR_MIGRATION_ASSEMBLY_NOT_EXPOSED')
        roots = [f['absPath'] for f in discovered]
        if name == 'analyzeRepository' and len(args) > 2:
            snapshot = map_value(args[2])
    else:
        raise Gap('UNMAPPED_PUBLIC_FUNCTION')
    retained = snapshot is not None
    files = snapshot if retained else live
    files = {move(path): text for path, text in files.items() if not undefined(text)}
    if name in ('analyzeRepository', 'analyzeRepositoryAsync'):
        for file in discovered:
            files[move(file['absPath'])] = file['content']
    # AST/source arguments are authoritative, independently captured bytes, not baseline outputs.
    if name == 'inspectNativeModuleBindings':
        files[move(target)] = args[0]['text']
    if name == 'inspectJavaScriptSource':
        files[move(target)] = args[1]
    if name == 'inspectModuleConfiguration' and len(args) > 3 and not undefined(args[3]):
        files[move(target)] = args[3]['text']
    # Ordinary physical sources behind an alias require the same lexical source spelling.
    for path in roots:
        key = move(path)
        if key not in files:
            for entry in physical:
                if 'symlink' in entry and key.startswith(entry['path'] + '/'):
                    physical_key = entry['symlink'] + key[len(entry['path']):]
                    if physical_key in files:
                        files[key] = files[physical_key]
    result['target_path'] = move(target) if target else None
    result['retained'] = retained
    if name == 'analyzeRepositoryAsync':
        result['auxiliary_requests'] = [{'surface': 'parallel_cli', 'mode': '--extract-parallel',
            'request': {'repoRoot': move(repository), 'rootAbsPaths': [move(p) for p in roots], 'workers': args[2]}}]
    if name == '__partitionTypeScriptRootsForTesting':
        result['partition_count'] = args[2]
        result['physical_sizes'] = {e['path']: e['size'] for e in physical if 'size' in e}
    if name == 'inspectModuleConfiguration':
        result['configuration_component'] = ('retainedWithSource' if len(args) > 3 and not undefined(args[3]) else 'retainedWithoutSource') if retained else 'ordinaryWithoutSnapshot'
    configured = name == 'resolveTypeScriptModule' and (args[3] is True if len(args) > 3 and not undefined(args[3]) else bool(re.search(r'\.(?:mjs|cjs|js|jsx)$', target)))
    if configured:
        result['runtime_repository_confinement_required'] = not retained and len(args) > 6 and not undefined(args[6])
        result.update(surface='configured_resolution_cli', mode='--observe-configured-resolution', request={
            'root': move(repository), 'sdk_directory': sdk_directory, 'case_sensitive': case_sensitive,
            'files': files, 'directories': sorted({p.rsplit('/', 1)[0] for p in files}),
            'containing_file': move(target), 'specifier': args[0]})
        if not retained and (len(args) <= 6 or undefined(args[6])):
            result['request']['repository_boundary'] = {'mode': 'absent'}
    else:
        result.update(surface='raw_cli', mode=None, request={
            'id': row_id + ':' + str(sequence), 'cwd': move(repository), 'sdk_directory': sdk_directory,
            'case_sensitive': case_sensitive, 'roots': [move(p) for p in roots], 'files': files,
            'options': a.OPTIONS_NATIVE.copy(), 'retained': retained, 'qualified': False,
            'roles': {}, 'selection': {}, 'disabled': [], 'utf16_files': {}, 'raw_files': {}})
        if name in ('analyzeRepository', 'analyzeRepositoryAsync'):
            result['request']['roles'] = {f['relPath']: f['role'] for f in discovered}
            result['request']['qualified'] = config.get('analysisProfile') == 'modelo-suite-static-v1'
        if name == 'resolveTypeScriptModule':
            result['specifier'] = args[0]
    directory_closure.attach_request(result)
    return result


def materialize_physical(prepared):
    """Materialize a fresh isolated operation closure; never invoke a native process.

    Not called during this preparation phase. Reject aliases/escapes before any writes.
    """
    destination = Path(prepared['case_root']).resolve()
    if destination.exists():
        raise Gap('PHYSICAL_CASE_ROOT_MUST_BE_FRESH')
    directory_closure.validate(prepared)
    plans = prepared['physical_setup']
    validated = []
    for item in plans:
        target = Path(item['path']).resolve()
        if not target.is_relative_to(destination) or target == destination:
            raise Gap('PHYSICAL_FILE_ESCAPES_CASE')
        if 'symlink' in item:
            link = Path(item['symlink']).resolve()
            if not link.is_relative_to(destination):
                raise Gap('PHYSICAL_SYMLINK_ESCAPES_CASE')
            validated.append((target, None, link))
        else:
            raw = Path(item['blob_ref']['path']).read_bytes()
            if a.digest(raw) != item['blob_ref']['sha256'] or len(raw) != item['size']:
                raise Gap('FROZEN_BLOB_HASH_MISMATCH')
            validated.append((target, raw, None))
    destination.mkdir(parents=True, exist_ok=False)
    for target, raw, link in validated:
        if link is None:
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as stream:
                stream.write(raw)
    prelink_directory_records = directory_closure.materialize_prelinks(prepared)
    for target, _raw, link in validated:
        if link is not None:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(link, target_is_directory=link.is_dir())
    directory_records = directory_closure.materialize(prepared)
    return {'status': 'MATERIALIZED_INPUTS_ONLY', 'files': len(validated), 'empty_directories': directory_records,
            'prelink_empty_directories': prelink_directory_records, 'native_queries': 0}


def normalize(value, prepared):
    if isinstance(value, str):
        text = a.normalize_path(value)
        for old, new in prepared['relocations']:
            text = text.replace(new, old)
        for replacement in prepared['path_normalization']['roots']:
            raw = a.normalize_path(replacement['raw'])
            text = text.replace(raw, replacement['token']).replace(raw.rsplit('/', 1)[-1], replacement['token'].replace('/', '_'))
        return text
    if isinstance(value, list):
        return [normalize(v, prepared) for v in value]
    if isinstance(value, dict):
        return {k: normalize(v, prepared) for k, v in value.items()}
    return value


def rust_consumer_value(prepared, native, kind):
    receipt = native.get('_rust_public_consumer_receipt')
    context = native.get('_rust_public_consumer_context')
    raw = {k: v for k, v in native.items() if not k.startswith('_rust_public_consumer_')}
    identity = lambda value: 'sha256:' + a.digest(native_canonical(value).encode('utf-8'))
    if not isinstance(receipt, dict) or not isinstance(context, dict):
        raise Gap('ACTUAL_RUST_PUBLIC_CONSUMER_RECEIPT_REQUIRED')
    if (receipt.get('kind') != kind or receipt.get('baseline_function') != prepared['baseline_function']
            or receipt.get('prepared_id') != identity(prepared)
            or receipt.get('request_descriptor_id') != identity(prepared['request'])
            or receipt.get('native_fact_id') != identity(raw)
            or receipt.get('producer_artifact_id') != raw.get('producer_artifact_id')
            or receipt.get('sdk_input_id') != context.get('sdk_input_id')
            or receipt.get('consumer_artifact_id') != context.get('consumer_artifact_id')
            or not isinstance(receipt.get('consumer_artifact_id'), str)
            or not re.fullmatch(r'sha256:[0-9a-f]{64}', receipt['consumer_artifact_id'])
            or 'value' not in receipt):
        raise Gap('RUST_PUBLIC_CONSUMER_CONTEXT_DIFFERS')
    unsigned = {k: v for k, v in receipt.items() if k != 'receipt_id'}
    if receipt.get('receipt_id') != identity(unsigned):
        raise Gap('RUST_PUBLIC_CONSUMER_RECEIPT_HASH_DIFFERS')
    return receipt['value']


def public_extraction(native):
    """Select the baseline public DTO; native-only exact ranges remain in RAW."""
    result = {**native}
    if 'symbols' in native:
        result['symbols'] = [{key: value for key, value in symbol.items()
                              if key not in ('startUtf16', 'endUtf16')}
                             for symbol in native['symbols']]
    return result


def public_repository_graph(assembly, prepared):
    """Normalize only the repository node's verified path-derived display name."""
    result = {**assembly, 'nodes': [{**node} for node in assembly['nodes']]}
    root = a.normalize_path(prepared['repository_root']).rstrip('/')
    for node in result['nodes']:
        if node.get('kind') != 'repository':
            continue
        if (a.normalize_path(node.get('metadata', {}).get('root', '')) != root
                or node.get('name') != root.rsplit('/', 1)[-1]):
            raise Gap('REPOSITORY_DISPLAY_NAME_NOT_BOUND_TO_ACTUAL_ROOT')
        origins = [a.normalize_path(old).rstrip('/') for old, new in prepared['relocations']
                   if a.normalize_path(new).rstrip('/') == root]
        if len(origins) != 1:
            raise Gap('REPOSITORY_DISPLAY_ROOT_RELOCATION_NOT_UNIQUE')
        node['name'] = normalize(origins[0].rsplit('/', 1)[-1], prepared)
    return result


def project_operation(prepared, native, graph_projector=None):
    """Project actual native facts only. No expectation argument is accepted."""
    name = prepared['baseline_function']
    if native.get('unsupported') or native.get('executed') is False:
        raise Gap('NATIVE_COMPONENT_UNSUPPORTED')
    if name == 'discoverRepository':
        file_fields = ('relPath', 'role', 'content') if prepared['request']['config']['version'] == 1 else ('relPath', 'role', 'language', 'content')
        result = {'candidates': [{k: c[k] for k in ('relPath', 'selectionDecision', 'analysisOutcome', 'reason') if k in c} for c in native['candidates']],
            'files': [{k: f[k] for k in file_fields} for f in native['files']]}
    elif name == 'extractRelativeImportSpecifiers':
        result = native['specifiers']
    elif name == 'extractTypeScriptParallel':
        result = {'extraction': public_extraction(native['extraction']), 'parallelism': native['parallelism']}
    elif name == 'extractTypeScript':
        result = public_extraction(native['raw_extraction'])
    elif name in ('analyzeRepository', 'analyzeRepositoryAsync'):
        raw = native['analysis'] if name == 'analyzeRepositoryAsync' else native
        assembly = raw['assembly']
        nodes = assembly['nodes']
        edges = assembly['edges']
        ids = {node['id'] for node in nodes}
        if len(ids) != len(nodes):
            raise Gap('ASSEMBLY_DUPLICATE_NODE_ID')
        # Same builder contract: inferred missing endpoints are fatal; authored
        # unresolved references require explicit provenance that this ABI lacks.
        if any(edge['from'] not in ids or edge['to'] not in ids for edge in edges):
            raise Gap('ASSEMBLY_UNRESOLVED_ENDPOINT_WITHOUT_PROVENANCE')
        if graph_projector is None:
            raise Gap('GRAPH_LOCALE_COLLATION_REQUIRES_PUBLIC_GRAPH_PROJECTION_CJS')
        graph = graph_projector(public_repository_graph(assembly, prepared))
        result = {'graph': graph, 'unresolvedReferences': []}
        if name == 'analyzeRepositoryAsync':
            result = {'analysis': result, 'parallelism': native['parallel']['parallelism']}
    elif name == '__partitionTypeScriptRootsForTesting':
        result = rust_consumer_value(prepared, native, 'partition-native-chunks-v1')
    elif name == 'resolveTypeScriptModule' and prepared['surface'] == 'configured_resolution_cli':
        result = rust_consumer_value(prepared, native, 'configured-runtime-companion-v1')
    else:
        target = prepared['target_path']
        relative = target[len(prepared['repository_root'].rstrip('/')) + 1:]
        subjects = [s for s in native['subjects'] if s['path'] in (relative, target)]
        if len(subjects) != 1:
            raise Gap('NATIVE_SUBJECT_MISSING_OR_DUPLICATED')
        subject = subjects[0]
        if name == 'inspectNativeModuleBindings':
            result = subject['javascript']['native']
        elif name == 'inspectJavaScriptSource':
            component = subject['javascriptObservation']
            if component['executed'] is not True or component['unsupported']:
                raise Gap('JAVASCRIPT_COMPONENT_UNSUPPORTED')
            result = {k: component[k] for k in ('parseFailed', 'reasons', 'staticExports', 'staticModuleLinks')}
        elif name == 'inspectModuleConfiguration':
            component = subject['moduleConfigurationObservations'][prepared['configuration_component']]
            if component['executed'] is not True or component['unsupported']:
                raise Gap('CONFIGURATION_COMPONENT_UNSUPPORTED')
            result = component['reasons']
        elif name == 'resolveTypeScriptModule':
            imports = [i for i in native['raw_extraction']['imports'] if i['fromRelPath'] == relative and i['moduleSpecifier'] == prepared['specifier']]
            if not imports:
                raise Gap('RESOLUTION_IMPORT_FACT_MISSING')
            paths = {i.get('resolvedRelPath') for i in imports}
            if len(paths) != 1:
                raise Gap('RESOLUTION_IMPORT_FACT_AMBIGUOUS')
            path = paths.pop()
            result = prepared['repository_root'].rstrip('/') + '/' + path if path is not None else {'$undefined': True}
        else:
            raise Gap('NATIVE_PUBLIC_PROJECTION_NOT_IMPLEMENTED')
    return normalize(result, prepared)


def native_canonical(value):
    """Rust identity.rs key ordering for these DTOs; reject unsupported number types."""
    if isinstance(value, dict):
        def order(key):
            numeric = key.isascii() and key.isdigit() and str(int(key)) == key and int(key) < 4294967295
            return (0, int(key)) if numeric else (1, key.encode('utf-16-be', errors='surrogatepass'))
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + native_canonical(value[k]) for k in sorted(value, key=order)) + '}'
    if isinstance(value, list):
        return '[' + ','.join(native_canonical(v) for v in value) + ']'
    if isinstance(value, float):
        raise Gap('FLOAT_IDENTITY_CANONICALIZATION_NOT_SUPPORTED')
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def compare_native(prepared, process_outcome, binding, graph_projector=None):
    """Pure evidence admission + comparison against a strictly resolved frozen ref.

    process_outcome preserves full stdout/stderr strings, byte counts and hashes.
    Binding must come from the frozen common runner permit, never the observation.
    """
    try:
        required = ['producer_artifact_id', 'request_descriptor_id', 'sdk_input_id',
                    'capture_stream_sha256', 'input_manifest_id']
        if any(not isinstance(binding.get(k), str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', binding[k]) for k in required):
            raise Gap('INCOMPLETE_EXPECTED_BINDING')
        if type(process_outcome.get('exit_code')) is not int or process_outcome.get('kind') != 'success' or process_outcome.get('exit_code') != 0:
            raise Gap('NATIVE_PROCESS_NOT_SUCCESS')
        for stream in ('stdout', 'stderr'):
            text = process_outcome[stream]
            raw = text.encode('utf-8')
            expected_hash = 'sha256:' + a.digest(raw)
            if type(process_outcome[stream + '_bytes']) is not int or process_outcome[stream + '_bytes'] != len(raw) or process_outcome[stream + '_hash'] not in (expected_hash, expected_hash[7:]):
                raise Gap('INCOMPLETE_RAW_CAPTURE')
        if process_outcome['stderr']:
            raise Gap('NATIVE_STDERR_NONEMPTY')
        native = json.loads(process_outcome['stdout'])
        request_id = 'sha256:' + a.digest(native_canonical(prepared['request']).encode('utf-8'))
        if request_id != binding['request_descriptor_id'] or native.get('request_descriptor_id', native.get('request_id')) != request_id:
            raise Gap('NATIVE_REQUEST_BINDING_MISMATCH')
        if binding['capture_stream_sha256'] != prepared['source_capture_stream_sha256']:
            raise Gap('FOREIGN_BASELINE_CAPTURE_STREAM')
        if native.get('producer_artifact_id') != binding['producer_artifact_id']:
            raise Gap('NATIVE_ARTIFACT_BINDING_MISMATCH')
        if prepared['surface'] not in ('primitive_cli', 'raw_cli') and native.get('sdk_input_id') != binding['sdk_input_id']:
            # Ordinary discovery performs physical reads and receives no SDK descriptor.
            if prepared['surface'] != 'repository_discovery_cli':
                raise Gap('NATIVE_SDK_BINDING_MISMATCH')
        if prepared['surface'] == 'raw_cli':
            if native.get('input_manifest_id') != binding['input_manifest_id'] or native.get('complete') is not True or not isinstance(native.get('capture_probes'), list):
                raise Gap('NATIVE_INPUT_MANIFEST_OR_PROBES_MISSING')
        if prepared['surface'] == 'configured_resolution_cli' and not isinstance(native.get('probes'), list):
            raise Gap('NATIVE_RESOLUTION_PROBES_MISSING')
        if prepared['surface'] == 'repository_discovery_cli' and (not isinstance(native.get('reads'), list) or not isinstance(native.get('resolution_probes'), list)):
            raise Gap('NATIVE_DISCOVERY_READS_OR_PROBES_MISSING')
        if native.get('global_admission_inferred', native.get('globalAdmissionInferred', False)) is not False:
            raise Gap('GLOBAL_ADMISSION_INFERENCE_FORBIDDEN')
        projection = project_operation(prepared, native, graph_projector=graph_projector)
        expected = resolve_ref(prepared['expected_ref'])
        return {'status': 'MATCH' if a.canonical(projection) == a.canonical(expected) else 'MISMATCH',
                'projection': projection, 'global_admission': 'UNKNOWN', 'native_raw_preserved': True}
    except (Gap, ValueError, KeyError, TypeError) as error:
        return {'status': 'UNKNOWN', 'reason': str(error), 'global_admission': 'UNKNOWN'}
