"""Public verifier bridge. It never launches a candidate or implements C1 analysis."""
import argparse
import copy
import importlib
import json
from pathlib import Path
import subprocess
import sys

from source_adapter import MANIFEST_SHA, digest, verify_frozen


def runtime(module_dir):
    sys.path.insert(0, str(Path(module_dir).resolve()))
    return importlib.import_module('public_runtime')


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def save(path, value):
    path = Path(path)
    if path.exists():
        raise ValueError('fresh output required: '+str(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')


def complete_success_capture(outcome):
    """One admission guard, shared by every positive Python projection path."""
    if outcome.get('kind')!='success' or type(outcome.get('exit_code')) is not int or outcome['exit_code']!=0:
        raise ValueError('NATIVE_PROCESS_NOT_SUCCESS')
    for stream in ('stdout','stderr'):
        if not isinstance(outcome.get(stream),str) or type(outcome.get(stream+'_bytes')) is not int:
            raise ValueError('INCOMPLETE_RAW_CAPTURE')
        raw=outcome[stream].encode('utf-8')
        if outcome[stream+'_bytes']!=len(raw) or outcome.get(stream+'_hash') not in (digest(raw),'sha256:'+digest(raw)):
            raise ValueError('INCOMPLETE_RAW_CAPTURE')
    if outcome['stderr']!='':
        raise ValueError('NATIVE_STDERR_NONEMPTY')


def lifecycle_projection_guard(prepared, observed):
    """Full verification stays unavailable; strict Rust receipts govern mapped29."""
    if prepared['public_flow_kind']=='public-verify':
        raise ValueError('FULL_PUBLIC_VERIFICATION_DTO_NOT_REGISTERED')


def map_handles(value):
    result = []
    if isinstance(value, dict):
        if '$mapIdentity' in value:
            result.append(value['$mapIdentity'])
        for item in value.values():
            result.extend(map_handles(item))
    elif isinstance(value, list):
        for item in value:
            result.extend(map_handles(item))
    return result


def invocation_key(prepared, operation, vector):
    """Strict within-vector temporal equivalence, never baseline call-graph imitation."""
    request = copy.deepcopy(prepared['request'])
    if prepared['surface'] == 'raw_cli':
        request['id'] = '$QUERY_ID_NOT_A_SEMANTIC_INPUT'
    basis = {'row': vector['id'], 'capture_stream': vector['rawStream']['sha256'],
        'parent_epoch': operation['parent'], 'snapshot_handles': map_handles(operation['request']['arguments']),
        'query': prepared['baseline_function'], 'surface': prepared['surface'],
        'request': request, 'physical_epoch': prepared['physical_setup'],
        'auxiliary_requests': prepared.get('auxiliary_requests', []),
        'actual_programs': [program for program in vector['actualSemanticPrograms'] if program['parent'] == operation['sequence']]}
    # Parent IDs in actual Program records deliberately prevent sharing different semantic epochs.
    return digest(json.dumps(basis, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))


def add_parallel_control(prepared, frozen):
    if prepared['surface'] != 'parallel_cli':
        return
    files = {}
    for item in prepared['physical_setup']:
        if 'blob_ref' in item:
            raw = Path(item['blob_ref']['path']).read_bytes()
            if digest(raw) != item['blob_ref']['sha256'] or len(raw) != item['size']:
                raise ValueError('parallel control blob differs')
            files[item['path']] = raw.decode('utf-8', errors='replace')
    descriptor = prepared['request']
    prepared['direct_control_request'] = {'id': 'supplement-parallel-direct-control',
        'cwd': descriptor['repoRoot'], 'sdk_directory': prepared['sdk_directory'],
        'case_sensitive': prepared['native_host_case_sensitive'], 'roots': descriptor['rootAbsPaths'],
        'files': files, 'options': prepared['native_options'], 'retained': False,
        'qualified': False, 'roles': {}, 'selection': {}, 'disabled': [], 'utf16_files': {}, 'raw_files': {}}


def plan(frozen, module_dir, output, sdk_directory, case_sensitive, ownership_module_dir=None, lifecycle_module_dir=None):
    verify_frozen(frozen)
    api = runtime(module_dir)
    index = load(frozen/'public-vectors/index.json')['tests']
    rows, invocations = [], {}
    for row in index:
        vector = load(frozen/'public-vectors'/row['file'])
        operations = []
        placeholder = str((output/'planning-inputs'/row['id']).resolve()).replace('\\', '/')
        ownership_by_sequence = {}
        ownership_handles = set()
        for operation in vector['operations']:
            if operation['baselineFunction']=='registerOpaqueCallbackOwnership':
                ownership_handles.update(map_handles(operation['request']['arguments']))
        if ownership_module_dir is not None and ownership_handles:
            sys.path.insert(0,str(Path(ownership_module_dir).resolve()))
            owner=importlib.import_module('ownership_adapter')
            nonce=digest((str(output.resolve())+'|'+row['id']+'|'+MANIFEST_SHA).encode())
            plans=owner.prepare_ownership(frozen,row['id'],str((output/'ownership-inputs'/row['id']).resolve()).replace('\\','/'),sdk_directory,case_sensitive,nonce)
            for epoch in plans:
                key='ownership-'+digest(api.native_canonical(epoch['request']).encode())
                epoch['ownership_module_dir']=str(Path(ownership_module_dir).resolve())
                invocations[key]={'key':key,'prepared':epoch,'operation_refs':[],'auxiliaries':[]}
                for operation in epoch['operations']:
                    if operation['sequence'] in ownership_by_sequence:
                        raise ValueError('ownership operation assigned twice')
                    ownership_by_sequence[operation['sequence']]=(key,epoch,operation)
        for operation in vector['operations']:
            sequence = operation['sequence']
            if sequence in ownership_by_sequence:
                key,epoch,owned=ownership_by_sequence[sequence]
                invocations[key]['operation_refs'].append({'row_id':row['id'],'sequence':sequence,'parent':operation['parent']})
                operations.append({'sequence':sequence,'parent':operation['parent'],'invocation_key':key,'prepared_projection':epoch,'required_consumer_output':operation['parent'] is None,'expected_ref':owned['expected_ref'],'ownership_selector':owned})
                continue
            try:
                draft = api.prepare_operation(frozen, row['id'], sequence, placeholder, sdk_directory, case_sensitive)
                key = invocation_key(draft, operation, vector)
                actual_root = str((output/'invocations'/key/'input').resolve()).replace('\\', '/')
                prepared = api.prepare_operation(frozen, row['id'], sequence, actual_root, sdk_directory, case_sensitive)
                prepared['sdk_directory'] = sdk_directory
                prepared['native_options'] = api.a.OPTIONS_NATIVE.copy()
                if prepared['surface'] == 'raw_cli':
                    prepared['request']['id'] = 'supplement-'+key
                add_parallel_control(prepared, frozen)
                if key not in invocations:
                    invocations[key] = {'key': key, 'prepared': prepared, 'operation_refs': [], 'auxiliaries': []}
                    for number, auxiliary in enumerate(prepared.get('auxiliary_requests', [])):
                        child = {**prepared, **auxiliary}
                        add_parallel_control(child, frozen)
                        invocations[key]['auxiliaries'].append({'key': key+'-aux-'+str(number), 'prepared': child})
                invocations[key]['operation_refs'].append({'row_id': row['id'], 'sequence': sequence, 'parent': operation['parent']})
                operations.append({'sequence': sequence, 'parent': operation['parent'], 'invocation_key': key,
                    'prepared_projection': prepared, 'required_consumer_output': operation['parent'] is None,
                    'expected_ref': prepared['expected_ref']})
                if operation['baselineFunction']=='inspectModuleConfiguration' and ownership_handles.intersection(map_handles(operation['request']['arguments'])):
                    operations[-1]['projection_gap']='OWNERSHIP_PHASE_INPUT_STATE_NOT_YET_REGISTERED'
            except (api.Gap, ValueError, KeyError, TypeError) as primary_error:
                mapping_error = str(primary_error)
                if lifecycle_module_dir is not None:
                    try:
                        sys.path.insert(0,str(Path(lifecycle_module_dir).resolve()))
                        lifecycle=importlib.import_module('lifecycle_adapter_29_strict')
                        draft=lifecycle.prepare_lifecycle(frozen,row['id'],sequence,placeholder,sdk_directory,case_sensitive)
                        key='lifecycle-'+draft['invocation_group_id']
                        actual_root=str((output/'invocations'/key/'input').resolve()).replace('\\','/')
                        prepared=lifecycle.prepare_lifecycle(frozen,row['id'],sequence,actual_root,sdk_directory,case_sensitive)
                        prepared['adapter']='lifecycle_adapter'
                        prepared['lifecycle_module_dir']=str(Path(lifecycle_module_dir).resolve())
                        for request in prepared['requests']:
                            request['id']='supplement-'+key
                        if key not in invocations:
                            invocations[key]={'key':key,'prepared':prepared,'operation_refs':[],'auxiliaries':[]}
                        invocations[key]['operation_refs'].append({'row_id':row['id'],'sequence':sequence,'parent':operation['parent']})
                        operations.append({'sequence':sequence,'parent':operation['parent'],'invocation_key':key,'prepared_projection':prepared,'required_consumer_output':operation['parent'] is None,'expected_ref':prepared['expected_ref'],'lifecycle_selector':True})
                        continue
                    except (api.Gap, ValueError, KeyError, TypeError) as lifecycle_error:
                        mapping_error=str(lifecycle_error)
                operations.append({'sequence': sequence, 'parent': operation['parent'],
                    'state': 'UNKNOWN_INPUT_OR_OPERATION_MAPPING', 'gap': mapping_error,
                    'required_consumer_output': operation['parent'] is None,
                    'expected_ref':api.a.ref(frozen/'public-vectors'/row['file'],'/operations/'+str(vector['operations'].index(operation))+'/normalizedProjection')})
        rows.append({'id': row['id'], 'operations': operations,
            'required_outputs': [operation['sequence'] for operation in operations if operation['required_consumer_output']],
            'baseline_operation_count': len(operations)})
    if len(rows) != 25 or sum(len(row['operations']) for row in rows) != 677:
        raise ValueError('frozen public denominator differs')
    return {'schema_version': 1, 'manifest_sha256': MANIFEST_SHA, 'frozen_root':str(frozen.resolve()), 'rows': rows,
        'invocations': list(invocations.values()), 'native_queries_performed': 0,
        'candidate_execution_authorized': False, 'qualification_credit': 0,
        'ownership_extension_registered':ownership_module_dir is not None,
        'lifecycle_extension_registered':lifecycle_module_dir is not None,
        'deduplication_contract': 'Only exact request/query/physical epoch/options/roots/roles/case/capture stream/Map handles/parent epoch are shared. Every baseline operation retains its native invocation reference. No synthetic replayed native call graph.'}


def materialize(plan_path, key, module_dir):
    api = runtime(module_dir)
    document = load(plan_path)
    candidates = [row for row in document['invocations'] if row['key'] == key]
    if len(candidates) != 1:
        raise ValueError('invocation identity missing or duplicated')
    prepared = candidates[0]['prepared']
    if prepared['surface']=='qualified_flow_cli':
        return {'status':'INPUTS_PREPARED_FOR_REAL_GIT_CONSUMER_MATERIALIZATION','key':key,'candidate_queries':0}
    frozen=Path(document['frozen_root'])
    if digest((frozen/'manifest-sha256.json').read_bytes())!=MANIFEST_SHA:
        raise ValueError('frozen materialization manifest differs')
    indexed={entry['path']:entry for entry in load(frozen/'manifest-sha256.json')['files']}
    for item in prepared['physical_setup']:
        if 'blob_ref' in item:
            relative=Path(item['blob_ref']['path']).resolve().relative_to(frozen.resolve()).as_posix()
            if indexed.get(relative,{}).get('sha256')!=item['blob_ref']['sha256']:
                raise ValueError('physical blob reference outside frozen manifest')
    api.materialize_physical(prepared)
    root = Path(prepared['case_root']).resolve()
    cwd = Path(prepared.get('repository_root', prepared['case_root']))
    if not cwd.resolve().is_relative_to(root):
        raise ValueError('cwd escapes prepared input')
    cwd.mkdir(parents=True, exist_ok=True)
    return {'status': 'MATERIALIZED_FROZEN_PUBLIC_INPUT_ONLY', 'key': key, 'candidate_queries': 0}


def project(document, outcome_root, module_dir, node, graph_module):
    api = runtime(module_dir)
    def graph_projector(graph):
        script = 'const fs=require("node:fs");const p=require(process.argv[1]);process.stdout.write(JSON.stringify(p.canonicalGraph(JSON.parse(fs.readFileSync(0,"utf8")))));'
        result = subprocess.run([node, '-e', script, str(graph_module)], input=json.dumps(graph),
            text=True, encoding='utf-8',errors='strict',capture_output=True, timeout=20, check=False)
        if result.returncode or result.stderr:
            raise api.Gap('GRAPH_PROJECTOR_PROCESS_FAILED')
        return json.loads(result.stdout)
    records = {}
    for invocation in document['invocations']:
        key = invocation['key']
        path = outcome_root/key/'bridge-evidence.json'
        if not path.is_file():
            records[key] = {'status': 'UNKNOWN', 'reason': 'MISSING_SUPERVISED_NATIVE_EVIDENCE'}
            continue
        evidence = load(path)
        if evidence.get('binding_verified') is not True:
            records[key] = {'status': 'UNKNOWN', 'reason': evidence.get('error', 'NATIVE_BINDING_REJECTED')}
            continue
        if invocation['prepared']['surface']=='qualified_flow_cli':
            records[key]={'status':'BOUND_ACTUAL_NATIVE_FACTS','native':evidence['lifecycle_observed'],'native_invocation_id':evidence['native_invocation_id'],'binding':evidence['binding']}
            continue
        outcome = evidence['outcome']
        try:
            complete_success_capture(outcome)
            native = json.loads(outcome['stdout'])
            binding = evidence['binding']
            expected_request = 'sha256:'+api.a.digest(api.native_canonical(invocation['prepared']['request']).encode('utf-8'))
            if binding['request_descriptor_id'] != expected_request or native.get('request_descriptor_id', native.get('request_id')) != expected_request:
                raise api.Gap('REQUEST_DESCRIPTOR_BINDING_DIFFERS')
            if native.get('producer_artifact_id') != binding['producer_artifact_id']:
                raise api.Gap('PRODUCER_ARTIFACT_BINDING_DIFFERS')
            if binding['capture_stream_sha256'] != invocation['prepared']['source_capture_stream_sha256']:
                raise api.Gap('CAPTURE_STREAM_BINDING_DIFFERS')
            if 'rust_public_consumer_receipt' in binding:
                native['_rust_public_consumer_receipt'] = binding['rust_public_consumer_receipt']
                native['_rust_public_consumer_context'] = {'consumer_artifact_id': binding['consumer_artifact_id'],
                    'sdk_input_id': binding['sdk_input_id']}
            if invocation['auxiliaries']:
                auxiliary = load(outcome_root/invocation['auxiliaries'][0]['key']/'bridge-evidence.json')
                if auxiliary.get('binding_verified') is not True:
                    raise api.Gap('ASYNC_PARALLEL_AUXILIARY_UNBOUND')
                complete_success_capture(auxiliary['outcome'])
                native = {'analysis': native, 'parallel': json.loads(auxiliary['outcome']['stdout'])}
            records[key] = {'status': 'BOUND_ACTUAL_NATIVE_FACTS', 'native': native,
                'native_invocation_id': evidence['native_invocation_id'], 'binding': evidence['binding']}
        except (api.Gap, KeyError, ValueError, TypeError, AttributeError) as error:
            records[key] = {'status': 'UNKNOWN', 'reason': str(error)}
    rows = []
    for row in document['rows']:
        observations = []
        for operation in row['operations']:
            key = operation.get('invocation_key')
            facts = records.get(key, {})
            if facts.get('status') != 'BOUND_ACTUAL_NATIVE_FACTS':
                observations.append({**{k: operation[k] for k in ['sequence', 'parent', 'required_consumer_output']},
                    'status': 'UNKNOWN', 'gap': operation.get('gap', facts.get('reason', 'NO_BOUND_NATIVE_FACTS'))})
                continue
            try:
                if operation.get('projection_gap'):
                    raise api.Gap(operation['projection_gap'])
                if operation.get('lifecycle_selector'):
                    prepared=copy.deepcopy(operation['prepared_projection'])
                    sys.path.insert(0,prepared['lifecycle_module_dir'])
                    lifecycle=importlib.import_module('lifecycle_adapter_29_strict')
                    lifecycle_projection_guard(prepared,facts['native'])
                    actual_root=facts['native']['repository_root']
                    old_root=prepared['repository_root']
                    if Path(actual_root).resolve()!=Path(old_root).resolve():
                        raise api.Gap('LIFECYCLE_ACTUAL_ROOT_NOT_SAME_PREPARED_LOCATION')
                    prepared['repository_root']=actual_root
                    prepared['relocations']=[(old,actual_root if new==old_root else new) for old,new in prepared['relocations']]
                    actual=lifecycle.project_lifecycle(prepared,facts['native'])
                elif 'ownership_selector' in operation:
                    prepared=operation['prepared_projection']
                    sys.path.insert(0,prepared['ownership_module_dir'])
                    owner=importlib.import_module('ownership_adapter')
                    one={**prepared,'operations':[operation['ownership_selector']]}
                    actual=owner.project_ownership(one,facts['native'])[str(operation['sequence'])]['projection']
                else:
                    actual = api.project_operation(operation['prepared_projection'], facts['native'], graph_projector=graph_projector)
                expected = api.resolve_ref(operation['expected_ref'])
                status = 'MATCH' if api.a.canonical(actual) == api.a.canonical(expected) else 'MISMATCH'
                observations.append({'sequence': operation['sequence'], 'parent': operation['parent'],
                    'required_consumer_output': operation['required_consumer_output'], 'status': status,
                    'projection': actual, 'expected_ref': operation['expected_ref'], 'native_invocation_id': facts['native_invocation_id']})
            except (api.Gap, KeyError, ValueError, TypeError, AttributeError) as error:
                observations.append({'sequence': operation['sequence'], 'parent': operation['parent'],
                    'required_consumer_output': operation['required_consumer_output'], 'status': 'UNKNOWN', 'gap': str(error)})
        required = [item for item in observations if item['required_consumer_output']]
        state = 'CONSUMER_OUTPUTS_MATCH' if required and all(item['status'] == 'MATCH' for item in required) else ('CONSUMER_OUTPUT_MISMATCH' if any(item['status'] == 'MISMATCH' for item in required) else 'UNKNOWN_REQUIRED_CONSUMER_OUTPUT')
        rows.append({'id': row['id'], 'state': state, 'observations': observations,
            'qualification_credit': 0, 'required_outputs': row['required_outputs']})
    actual_invocations = [{'path':str(path.relative_to(outcome_root)),'process_outcome_id':load(path).get('process_outcome_id')} for path in sorted(outcome_root.rglob('process-invocation.json'))]
    for path in sorted(outcome_root.rglob('bridge-evidence.json')):
        evidence=load(path)
        for receipt in evidence.get('binding',{}).get('actual_process_receipts',[]):
            if receipt['native_c1']:
                actual_invocations.append(receipt)
    return {'rows': rows, 'native_invocation_count': len(actual_invocations), 'native_invocations': actual_invocations, 'primary_projection_groups': len(records), 'baseline_operations': 677,
        'qualified': False, 'qualification_credit': 0, 'r0_decision': None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['plan', 'materialize', 'project'])
    parser.add_argument('--frozen', type=Path)
    parser.add_argument('--module-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--plan', type=Path)
    parser.add_argument('--key')
    parser.add_argument('--sdk-directory', default='/sdk/lib')
    parser.add_argument('--case-sensitive', choices=['true', 'false'])
    parser.add_argument('--outcome-root', type=Path)
    parser.add_argument('--node')
    parser.add_argument('--graph-module', type=Path)
    parser.add_argument('--execution-root', type=Path)
    parser.add_argument('--ownership-module-dir',type=Path)
    parser.add_argument('--lifecycle-module-dir',type=Path)
    args = parser.parse_args()
    if args.action == 'plan':
        if args.case_sensitive is None:
            parser.error('plan requires measured --case-sensitive true|false')
        result = plan(args.frozen, args.module_dir, args.execution_root or args.output.parent, args.sdk_directory, args.case_sensitive == 'true',args.ownership_module_dir,args.lifecycle_module_dir)
    elif args.action == 'materialize':
        result = materialize(args.plan, args.key, args.module_dir)
    else:
        result = project(load(args.plan), args.outcome_root, args.module_dir, args.node, args.graph_module)
    save(args.output, result)
    print(json.dumps({'status': 'VERIFIER_STAGE_ONLY', 'action': args.action, 'output_sha256': digest(args.output.read_bytes())}))


if __name__ == '__main__':
    main()
