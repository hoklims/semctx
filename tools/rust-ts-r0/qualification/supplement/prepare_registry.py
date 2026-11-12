"""Create a separate, disabled draft registry; candidate execution is unavailable."""
import argparse
import collections
import json
from pathlib import Path
import sys

from source_adapter import MANIFEST_SHA, digest, load, materialize_checks, reference, resolve, source_rows, verify_frozen
from source_scope_addenda import attach_source_scopes


def canonical_public_references(value, frozen, indexed):
    if isinstance(value, list):
        return [canonical_public_references(item, frozen, indexed) for item in value]
    if not isinstance(value, dict):
        return value
    normalized = {key: canonical_public_references(item, frozen, indexed) for key, item in value.items()}
    if 'path' in value and 'sha256' in value and ('json_pointer' in value or 'pointer' in value):
        path = Path(value['path'])
        if path.is_absolute():
            try:
                path = path.relative_to(frozen.resolve())
            except ValueError:
                pass
        relative = path.as_posix()
        if indexed.get(relative, {}).get('sha256') != value['sha256']:
            # Relocate reference URIs only, never source strings: match the entire
            # indexed relative path plus exact content identity, not a basename.
            normalized_path=str(value['path']).replace('\\','/')
            candidates=[name for name,entry in indexed.items() if (normalized_path==name or normalized_path.endswith('/'+name)) and entry['sha256']==value['sha256']]
            if len(candidates)==1:
                relative=candidates[0]
        if indexed.get(relative, {}).get('sha256') != value['sha256']:
            raise ValueError('public reference outside frozen manifest')
        normalized.update(reference(indexed, relative, value.get('pointer', value.get('json_pointer', ''))))
    return normalized


def prepare(frozen, public_registry=None):
    indexed = verify_frozen(frozen)
    rows = source_rows(frozen, indexed)
    for row in rows:
        row['recipes'] = [materialize_checks(row, frozen, indexed)]
        if row['id'] == 'source::reference-outside':
            row['recipes'][0]['surface'] = 'source_component_cli'
            row['integration_status'] = 'EXPLICIT_SOURCE_COMPONENT_MODE_UNEXECUTED'
        if row['id'] == 'source::computed-dts':
            row['recipes'][0]['surface'] = 'declaration_root_cli'
            row['gaps'] = [gap for gap in row['gaps'] if gap != 'UNKNOWN_NATIVE_DECLARATION_ONLY_ROOT_SUBJECT']
            row['recipes'][0]['supplement_unmapped_properties'] = row['gaps'] + row.get('unmapped_expected_fields', [])
            row['integration_status'] = 'EXPLICIT_DECLARATION_ROOT_COMPONENT_MODE_IMPLEMENTED_NOT_NATIVE_EXECUTED'
        if 'snapshot_boundary' in row:
            boundary=row['snapshot_boundary']
            row['recipes'].append({'surface':'snapshot_boundary_cli','unit_id':row['id'], 'template':row['template'], 'workspace_name':boundary['workspace_name'], 'expected_error':resolve(frozen,indexed,boundary['refusal_ref']), 'expected_error_code':resolve(frozen,indexed,boundary['refusal_ref']).split(':',1)[0], 'expected_error_ref':boundary['refusal_ref'], 'expected_nodes':resolve(frozen,indexed,boundary['graph_nodes_ref']), 'expected_nodes_ref':boundary['graph_nodes_ref'], 'source_capture_stream_sha256':'sha256:'+indexed['observed/primary/source-50/source-50.operations.jsonl']['sha256']})
        row['operation_mappings'] = [{'baseline_operation': check['operation'], 'entrypoint': row['entrypoint'], 'selector': check['target'], 'expected_ref': check['expected_ref']} for check in row['checks']]
        row['execution_enabled'] = False
    attach_source_scopes({"rows": rows}, frozen)
    public_rows = []
    if public_registry is not None:
        public = json.loads(public_registry.read_text(encoding='utf-8'))
        if public.get('manifest_sha256') != MANIFEST_SHA or len(public.get('rows', [])) != 25:
            raise ValueError('public module identity or25-vector denominator differs')
        public_rows = canonical_public_references(public['rows'], frozen, indexed)
        if any(row.get('execution_enabled') is True for row in public_rows):
            raise ValueError('public module must remain disabled')
        for row in public_rows:
            if row.get('entrypoint') == 'public_adapter_cli':
                row['gaps'] = [gap for gap in row['gaps'] if gap != 'UNKNOWN_PUBLIC_RUNTIME_RUST_BRIDGE']
                row['entrypoint'] = 'supervised_public_bridge'
                row['integration_status'] = 'IMPLEMENTED_VERIFIER_PLAN_RUST_SUPERVISION_AND_PURE_PROJECTION_UNEXECUTED'
            row['execution_enabled'] = False
        rows.extend(public_rows)
    if len({row['id'] for row in rows}) != len(rows):
        raise ValueError('duplicate supplement row')
    pairs = [{'id': pair['id'], 'before_id': 'source::'+pair['id']+'-before', 'after_id': 'source::'+pair['id']+'-after', 'expected_relation': pair['relation'], 'expected_ref': reference(indexed, 'expected-additional-observables.json', '/digestPairs/'+str(index)+'/relation')} for index, pair in enumerate(load(frozen, 'expected-additional-observables.json')['digestPairs'])]
    return {'schema_version': 1, 'manifest_sha256': MANIFEST_SHA, 'status': 'DRAFT_ABI_FROZEN_BEFORE_ANY_NATIVE_QUERY', 'execution_enabled': False, 'candidate_execution_authorized': False, 'counts': {'sources': 67, 'public_vectors': len(public_rows), 'required_public_vectors': 25, 'public_operations': 677, 'original_units_unchanged': 354, 'original_supports_unchanged': 51}, 'normalization': {'paths': 'Explicit root-token map only; never basename-substitute arbitrary content or reason strings.', 'case': 'Measure and bind actual host mode for source67; observed Windows false remains baseline provenance. Explicit case-control and alias witnesses require their own mapping.', 'options': 'Exact named TS5 enum meaning to native DTO strings; actual-use Program context takes precedence. No numeric enum-value mirror.', 'expected': 'Only frozen manifest-indexed references; component executed/unsupported guards are separate adapter completeness requirements.', 'components': 'Require actual request/artifact/SDK identities and successful source/SDK read joins through existing harness. No synthetic positive native observations.', 'rows': 'Preserve raw component outcomes; an unmapped property makes the whole row UNKNOWN even when every mapped comparison passes.'}, 'rows': rows, 'digest_pairs': pairs, 'gap_counts': dict(collections.Counter(gap for row in rows for gap in row['gaps'])), 'qualification_credit': 0, 'r0_decision': None}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--frozen', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--public-registry', type=Path)
    args = parser.parse_args(argv)
    document = prepare(args.frozen, args.public_registry)
    args.output.mkdir(exist_ok=False)
    path = args.output / 'registry.json'
    path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    table = ['| Source | Operation/entrypoint | Expected selectors | Gaps |', '|---|---|---|---|']
    for row in document['rows']:
        mappings = row.get('operation_mappings', [])
        names = sorted({mapping.get('baseline_operation', mapping.get('baseline_function', mapping.get('baselineFunction', 'UNKNOWN'))) for mapping in mappings})
        table.append('| '+row['id']+' | '+', '.join(names)+' / '+row.get('entrypoint', 'per-operation')+' | '+str(len(mappings))+' | '+(', '.join(row['gaps']) or 'No static mapping gap; actual observation still required')+' |')
    (args.output / 'mapping-table.md').write_text('\n'.join(table)+'\n', encoding='utf-8')
    files = {name: digest((args.output / name).read_bytes()) for name in ['registry.json', 'mapping-table.md']}
    code_names = ['source_adapter.py', 'source_scope_addenda.py', 'prepare_registry.py', 'preflight.py', 'public_bridge.py']
    optional = ['supplement_replay.rs','supplement_public_bridge.rs','public_adapter.py','public_runtime.py','public_graph_projection.cjs','lifecycle_adapter_29_frozen.py','ownership_adapter.py','harness-bridge-v2.patch','test_adapter.py','test_public_bridge.py']
    code_names += [name for name in optional if (Path(__file__).parent/name).is_file()]
    code = {name: digest((Path(__file__).parent/name).read_bytes()) for name in code_names}
    freeze = {'status': 'DRAFT_ONLY_NO_NATIVE_EXECUTION', 'manifest_sha256': MANIFEST_SHA, 'files': files, 'code_sha256': code, 'consumer_build_provenance_claimed':False,'execution_enabled': False, 'candidate_binding': None, 'counts': document['counts']}
    (args.output / 'abi-freeze.json').write_text(json.dumps(freeze, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'counts': document['counts'], 'gaps': document['gap_counts'], 'registry_sha256': files['registry.json'], 'execution_enabled': False}))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError) as error:
        print('SUPPLEMENT_PREFLIGHT_REFUSED: '+str(error), file=sys.stderr)
        sys.exit(2)
