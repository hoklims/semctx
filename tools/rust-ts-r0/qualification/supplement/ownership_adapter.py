"""Scratch public ownership adapter. Pure prepare/project/compare; never executes native code.

Map handles are provenance keys only. A caller-supplied fresh runtime nonce and epoch
ordinal enter the actual RAW request.id, and thus C1 request_id. No JS ownership
analysis is implemented here: effects come exclusively from C1 component fields.
"""
import copy
import hashlib
import json
import re
from pathlib import Path

MANIFEST_SHA = '923a03767cd5f675c66f4a35b458dcd6f38554fe3c41f90f5a83eebc7292ddc6'


class Gap(ValueError):
    pass


def canonical(value):
    if isinstance(value, dict):
        def order(key):
            numeric = key.isascii() and key.isdigit() and str(int(key)) == key and int(key) < 4294967295
            return (0, int(key)) if numeric else (1, key.encode('utf-16-be', errors='surrogatepass'))
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + canonical(value[k]) for k in sorted(value, key=order)) + '}'
    if isinstance(value, list):
        return '[' + ','.join(canonical(v) for v in value) + ']'
    if isinstance(value, float):
        raise Gap('FLOAT_IDENTITY_NOT_SUPPORTED')
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def digest_bytes(value):
    return 'sha256:' + hashlib.sha256(value).hexdigest()


def digest(value):
    return digest_bytes(canonical(value).encode('utf-8'))


def runtime_request_id(nonce, ordinal):
    if not isinstance(nonce, str) or not nonce.strip() or not isinstance(ordinal, int) or ordinal < 0:
        raise Gap('FRESH_RUNTIME_NONCE_AND_EPOCH_ORDINAL_REQUIRED')
    return 'public-ownership:' + nonce + ':' + str(ordinal)


def ownership_graph_view(graph):
    """Fields consumed by qualified.rs lookup_graph_coordinate/inline_owned/visit_inline_reference.

    Retain metadata.scope, duplicate coordinates, module/test fallback order, and
    call evidence file/startLine. IDs are translated to coordinates, never dropped
    from edges without resolution. This validates input equivalence, not ownership.
    """
    nodes, edges = graph['nodes'], graph['edges']
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise Gap('MISSING_GRAPH_INVENTORY')
    coordinates, callable_nodes, fallback = {}, [], {}
    for node in nodes:
        key = node['id']
        if key in coordinates:
            raise Gap('DUPLICATE_GRAPH_NODE')
        coordinate = [node['kind'], node.get('filePath'), node.get('name', ''),
                      node.get('metadata', {}).get('scope', '')]
        coordinates[key] = coordinate
        if node['kind'] in ('function', 'class'):
            callable_nodes.append(coordinate)
        if node['kind'] in ('module', 'test') and node.get('filePath') not in fallback:
            fallback[node.get('filePath')] = coordinate
    observed_edges = []
    for edge in edges:
        if edge['from'] not in coordinates or edge['to'] not in coordinates:
            raise Gap('UNRESOLVED_GRAPH_ENDPOINT')
        if edge['kind'] in ('calls', 'covers', 'tested_by'):
            evidence = sorted([[e.get('filePath'), e.get('startLine')] for e in edge.get('evidence', [])], key=canonical)
            observed_edges.append([edge['kind'], coordinates[edge['from']], coordinates[edge['to']], evidence])
    # JSON pairs retain fallback key values including null without Python key coercion.
    return {'callables': sorted(callable_nodes, key=canonical),
            'fallback': sorted([[k, v] for k, v in fallback.items()], key=canonical),
            'edges': sorted(observed_edges, key=canonical)}


def _map(value):
    return isinstance(value, dict) and '$mapIdentity' in value and '$map' in value


def _snapshot(operation):
    name, args = operation['baselineFunction'], operation['request']['arguments']
    index = {'registerOpaqueCallbackOwnership': 0, 'extractTypeScript': 2,
             'analyzeRepository': 2, 'inspectModuleConfiguration': 2}.get(name)
    return args[index] if index is not None and len(args) > index and _map(args[index]) else None


def prepare_ownership(frozen_root, row_id, case_root, sdk_directory, case_sensitive, runtime_nonce):
    """Prepare grouped native RAW recipes and frozen operation selectors, execution disabled.

    public_runtime must be importable from the sibling adapter directory. Call once
    per row with a nonce allocated by the real runner, never by a baseline handle.
    Expected values are not inspected to choose requests, epochs, graphs or phases.
    """
    import public_adapter as a
    import public_runtime as runtime
    runtime_request_id(runtime_nonce, 0)
    root = Path(frozen_root)
    manifest = root / 'manifest-sha256.json'
    if hashlib.sha256(manifest.read_bytes()).hexdigest() != MANIFEST_SHA:
        raise Gap('FOREIGN_FROZEN_MANIFEST')
    inventory = {e['path']: e for e in a.load(manifest)['files']}
    rel = 'public-vectors/' + row_id + '.json'
    vector = runtime.resolve_ref({'path': str(root / rel), 'sha256': inventory[rel]['sha256']})
    stream_rel = 'observed/primary/public/' + vector['rawStream']['file']
    stream = (root / stream_rel).read_bytes()
    if (hashlib.sha256(stream).hexdigest() != vector['rawStream']['sha256']
            or hashlib.sha256(stream).hexdigest() != inventory[stream_rel]['sha256']
            or len(stream) != inventory[stream_rel]['size']):
        raise Gap('FOREIGN_CAPTURE_STREAM')
    operations = vector['operations']
    registrations = [op for op in operations if op['baselineFunction'] == 'registerOpaqueCallbackOwnership']
    groups = {}
    for registration in registrations:
        snapshot = _snapshot(registration)
        if snapshot is None:
            raise Gap('REGISTRATION_MAP_SNAPSHOT_REQUIRED')
        key = (snapshot['$mapIdentity'], digest(snapshot['$map']))
        groups.setdefault(key, []).append(registration)
    plans = []
    for ordinal, ((handle, snapshot_id), members) in enumerate(groups.items()):
        compatible = [op for op in operations if (s := _snapshot(op)) is not None
                      and s['$mapIdentity'] == handle and digest(s['$map']) == snapshot_id]
        extracts = [op for op in compatible if op['baselineFunction'] == 'extractTypeScript']
        if not extracts:
            raise Gap('NO_CAPTURED_EXTRACTION_INPUT_FOR_OWNERSHIP_EPOCH')
        base = runtime.prepare_operation(root, row_id, extracts[0]['sequence'], case_root + '/epoch-' + str(ordinal), sdk_directory, case_sensitive)
        request = copy.deepcopy(base['request'])
        request.update(id=runtime_request_id(runtime_nonce + ':' + row_id, ordinal), retained=True, qualified=True)
        # Registration map is authoritative; roots/options are independently captured extraction inputs.
        source_map = runtime.map_value(_snapshot(members[0]))
        def move(path, base=base):
            path = a.normalize_path(path)
            for old, new in base['relocations']:
                match = path if case_sensitive else path.lower()
                prefix = old if case_sensitive else old.lower()
                if match == prefix or match.startswith(prefix + '/'):
                    return new + path[len(old):]
            raise Gap('UNBOUND_OWNERSHIP_SNAPSHOT_PATH')
        request['files'] = {move(path): text for path, text in source_map.items() if not runtime.undefined(text)}
        # C1 role inference is retained; captured analysis role has authority when present.
        analyses = [op for op in compatible if op['baselineFunction'] == 'analyzeRepository']
        if analyses:
            request['roles'] = {f['relPath']: f['role'] for f in analyses[0]['request']['arguments'][1]}
        selectors, gaps = [], []
        for operation in compatible:
            name = operation['baselineFunction']
            if name not in ('registerOpaqueCallbackOwnership', 'inspectModuleConfiguration'):
                continue
            seq = operation['sequence']
            previous = [op for op in members if op['sequence'] <= seq]
            registered = previous[-1] if previous else None
            graph = registered['request']['arguments'][1] if registered else None
            phase = 'beforeAnalysis' if graph is None else ('afterGraphEdgesRemoved' if graph['edges'] == [] else 'afterAnalysis')
            pointer = '/operations/' + str(operations.index(operation))
            record = {'sequence': seq, 'kind': 'register' if name == 'registerOpaqueCallbackOwnership' else 'inspect',
                      'phase': phase, 'snapshot_id': snapshot_id, 'input_graph': graph,
                      'request_ref': a.ref(root / rel, pointer + '/request'),
                      'expected_ref': a.ref(root / rel, pointer + '/normalizedProjection')}
            if name == 'inspectModuleConfiguration':
                target = move(operation['request']['arguments'][0])
                record['subject'] = target[len(request['cwd'].rstrip('/')) + 1:]
                if len(operation['request']['arguments']) > 3 and not runtime.undefined(operation['request']['arguments'][3]):
                    record['gap'] = 'OWNERSHIP_WITH_SOURCE_AST_PHASE_NOT_EXPOSED'
                    gaps.append(record['gap'])
            else:
                record['subject'] = '*'
            selectors.append(record)
        plans.append({**base, 'surface': 'raw_cli', 'mode': None, 'request': request,
            'adapter': 'ownership_adapter', 'execution_enabled': False,
            'epoch': ordinal, 'baseline_map_handle_provenance_only': handle,
            'snapshot_id': snapshot_id, 'readset': copy.deepcopy(request['files']),
            'operations': selectors, 'gaps': sorted(set(gaps)),
            'graph_equivalence_contract': 'qualified.rs:1909-1946,2040-2246',
            'observability_limit': 'arbitrary retained graph injection unavailable; project fails unless receiver-consumed graph fields match actual assembly or its edge-free variant'})
    return plans


def _validate_native(plan, native):
    if (native.get('request') != plan['request']['id'] or native.get('request_id') != digest(plan['request'])
            or native.get('complete') is not True or native.get('global_admission_inferred') is not False):
        raise Gap('NATIVE_REQUEST_CAPTURE_BINDING_MISMATCH')
    if plan['readset'] != plan['request']['files']:
        raise Gap('MAP_CHANGED_AFTER_PREPARATION')
    probes = native.get('capture_probes')
    if not isinstance(probes, list):
        raise Gap('MISSING_NATIVE_READSET')
    sensitive = plan['request']['case_sensitive']
    key = lambda path: path.replace('\\', '/') if sensitive else path.replace('\\', '/').lower()
    reads = {}
    for probe in probes:
        if probe.get('operation') == 'read_file' and probe.get('found') is True:
            reads.setdefault(key(probe['path']), set()).add(probe.get('content_id'))
    for root in plan['request']['roots']:
        text = plan['readset'].get(root)
        if text is None or reads.get(key(root)) != {digest_bytes(text.encode('utf-8'))}:
            raise Gap('ROOT_READSET_MISSING_OR_FOREIGN')
    for path, text in plan['readset'].items():
        if key(path) in reads and reads[key(path)] != {digest_bytes(text.encode('utf-8'))}:
            raise Gap('CAPTURED_MAP_READ_CONTENT_MISMATCH')


def _normalize_reasons(reasons, plan):
    result = []
    for reason in reasons:
        if not isinstance(reason, str):
            raise Gap('NON_TEXT_NATIVE_REASON')
        text = reason.replace('\\', '/')
        for old, new in plan.get('relocations', []):
            text = text.replace(new, old)
        for replacement in plan.get('path_normalization', {}).get('roots', []):
            raw = replacement['raw'].replace('\\', '/')
            text = text.replace(raw, replacement['token']).replace(raw.rsplit('/', 1)[-1], replacement['token'].replace('/', '_'))
        result.append(text)
    return result


def project_ownership(plan, native):
    """Select existing real C1 phases. This function never accepts expected values."""
    _validate_native(plan, native)
    graph = native['assembly']
    removed = dict(graph, edges=[])
    subjects = native['subjects']
    paths = [subject['path'] for subject in subjects]
    if len(set(paths)) != len(paths):
        raise Gap('DUPLICATED_NATIVE_OWNERSHIP_SUBJECT')
    projected = {}
    for operation in plan['operations']:
        if operation.get('gap'):
            raise Gap(operation['gap'])
        selected = subjects if operation['subject'] == '*' else [s for s in subjects if s['path'] == operation['subject']]
        if not selected:
            raise Gap('MISSING_NATIVE_OWNERSHIP_SUBJECT')
        input_graph = operation['input_graph']
        phase = operation['phase']
        phase_graph = ({'nodes': [], 'edges': []} if phase == 'beforeAnalysis' else
                       removed if phase == 'afterGraphEdgesRemoved' else graph)
        if input_graph is not None and ownership_graph_view(input_graph) != ownership_graph_view(phase_graph):
            raise Gap('RETAINED_GRAPH_NOT_NATIVE_PHASE:ARBITRARY_GRAPH_INPUT_NOT_EXPOSED')
        effects, refs = {}, []
        for subject in selected:
            component = subject['opaqueCallbackOwnership']
            if (component.get('executed') is not True or component.get('unsupported') != []
                    or component.get('observationScope') != 'native_module_configuration_graph_ownership'
                    or component.get('globalAdmissionInferred') is not False
                    or component.get('graphBeforeEdgeRemovalId') != digest(graph)
                    or component.get('graphAfterEdgeRemovalId') != digest(removed)):
                raise Gap('OPAQUE_OWNERSHIP_GRAPH_BINDING_MISSING')
            observed = component[phase]
            if observed.get('executed') is not True or observed.get('unsupported') != [] or not isinstance(observed.get('reasons'), list):
                raise Gap('OWNERSHIP_PHASE_NOT_EXECUTED')
            effects[subject['path']] = observed['reasons']
            refs.append(['subjects', {'path': subject['path']}, 'opaqueCallbackOwnership', phase])
        value = {'$undefined': True} if operation['kind'] == 'register' else _normalize_reasons(effects[operation['subject']], plan)
        projected[str(operation['sequence'])] = {'projection': value,
            'effect': {'reasons': next(iter(effects.values()))} if len(effects) == 1 else effects,
            'observations': refs, 'native_request_id': native['request_id'],
            'native_graph_id': digest(phase_graph), 'native_readset_id': digest(native['capture_probes'])}
    return projected


def compare_ownership(plan, process_outcome, binding, expected):
    """Caller supplies independently resolved frozen projections only at comparison time."""
    try:
        required = ('request_descriptor_id', 'producer_artifact_id', 'input_manifest_id',
                    'sdk_input_id', 'capture_stream_sha256')
        if any(not re.fullmatch(r'sha256:[0-9a-f]{64}', binding.get(k, '')) for k in required):
            raise Gap('INCOMPLETE_EXPECTED_BINDING')
        if process_outcome.get('kind') != 'success' or process_outcome.get('exit_code') != 0:
            raise Gap('NATIVE_PROCESS_NOT_SUCCESS')
        for stream in ('stdout', 'stderr'):
            raw = process_outcome[stream].encode('utf-8')
            if process_outcome[stream + '_bytes'] != len(raw) or process_outcome[stream + '_hash'] not in (digest_bytes(raw), digest_bytes(raw)[7:]):
                raise Gap('INCOMPLETE_RAW_CAPTURE')
        if process_outcome['stderr']:
            raise Gap('NATIVE_STDERR_NONEMPTY')
        native = json.loads(process_outcome['stdout'])
        if (binding['request_descriptor_id'] != digest(plan['request'])
                or native.get('producer_artifact_id') != binding['producer_artifact_id']
                or native.get('input_manifest_id') != binding['input_manifest_id']
                or binding['capture_stream_sha256'] != plan['source_capture_stream_sha256']):
            raise Gap('FOREIGN_NATIVE_BINDING')
        projected = project_ownership(plan, native)
        values = {seq: value['projection'] for seq, value in projected.items()}
        if set(values) != set(expected):
            raise Gap('OWNERSHIP_OPERATION_DENOMINATOR_CHANGED')
        return {'status': 'MATCH' if canonical(values) == canonical(expected) else 'MISMATCH',
                'operations': projected, 'global_admission': 'UNKNOWN', 'native_raw_preserved': True}
    except (Gap, KeyError, TypeError, ValueError) as error:
        return {'status': 'UNKNOWN', 'reason': str(error), 'global_admission': 'UNKNOWN'}
