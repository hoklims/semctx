"""Input-only plan for the five working-tree cases; all policy remains Rust."""
import argparse
import copy
import json
from pathlib import Path
import public_adapter as a
import lifecycle_adapter_29_frozen as original
from lifecycle_adapter_29_frozen import vector_and_operation, closure_files
from public_runtime import Gap


def prepare_full_admission(frozen_root, row_id, sequence, case_root, sdk_directory, case_sensitive):
    root, vector, operation, _ = vector_and_operation(frozen_root, row_id, sequence)
    if operation['baselineFunction'] != 'runVerify' or operation['request']['arguments'][1] != {'kind': 'working-tree'}:
        raise Gap('FULL_CONSUMER_ONLY_FROZEN_WORKING_TREE_VERIFY')
    prepared = original.prepare_lifecycle(root, row_id, sequence, case_root, sdk_directory, case_sensitive)
    repository = operation['request']['arguments'][0]
    calls = [o for o in vector['operations'] if o['baselineFunction'] == 'indexRepository'
             and o['sequence'] < sequence and a.normalize_path(o['request']['arguments'][0]).lower() == a.normalize_path(repository).lower()]
    if not calls:
        raise Gap('ACTUAL_PRECEDING_INDEX_EPOCH_NOT_CAPTURED')
    latest = calls[-1]
    index_plan = original.prepare_lifecycle(root, row_id, latest['sequence'], case_root, sdk_directory, case_sensitive)
    index_files = closure_files(latest, repository, root)
    current_files = closure_files(operation, repository, root)
    # These five test bodies call verify immediately after their final reindex.
    # Do not reinterpret the initial selectedRepository index as the final seal.
    if index_files != current_files:
        raise Gap('DIFFERING_INDEX_VERIFY_EPOCHS_REQUIRE_EXPLICIT_TEMPORAL_REPLAY')
    discovery = next((o for o in vector['operations'] if o['baselineFunction'] == 'discoverRepository' and o['parent'] == latest['sequence']), None)
    if discovery is None:
        raise Gap('ACTUAL_INDEX_CONFIGURATION_INPUT_ABSENT')
    config = discovery['request']['arguments'][0]
    structural = copy.deepcopy(index_plan['requests'][0])
    structural['qualified'] = False
    structural['id'] = row_id + ':' + str(sequence) + ':ordinary-index'
    selected = copy.deepcopy(structural)
    selected['qualified'] = True
    selected['id'] = row_id + ':' + str(sequence) + ':qualified-selected'
    broad = copy.deepcopy(selected)
    broad['id'] = row_id + ':' + str(sequence) + ':qualified-broad'
    broad['roots'] = [path for path in broad['files'] if path.endswith(('.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'))]
    prepared.update({
        'adapter': 'full_admission_adapter', 'public_flow_kind': 'public-verify', 'execution_enabled': False,
        'projection_gap': None, 'requests': [structural], 'index_snapshot_template': structural,
        'qualified_selected_template': selected, 'qualified_broad_template': broad,
        'index_epoch_files': index_files, 'current_epoch_files': current_files,
        'index_epoch_sequence': latest['sequence'], 'index_requested_at': latest['request']['arguments'][1],
        'index_epoch_request_ref': a.ref(root / 'public-vectors' / (row_id + '.json'), '/operations/' + str(vector['operations'].index(latest)) + '/request'),
        'selected_discovery_config': {k: config[k] for k in ['version', 'include', 'exclude', 'languages', 'migrationsDirs']},
        'broad_discovery_config': {'version': 2, 'include': ['**/*'], 'exclude': [],
            'languages': {'typescript': 'on', 'javascript': 'on', 'python': 'on', 'markdown': 'on', 'sql': 'on'}, 'migrationsDirs': config['migrationsDirs']},
        'configured_rules': config['blockingRules'], 'git_after_index': [],
        'epoch_equivalence_basis': 'nearest preceding index in the same frozen root; complete physical snapshots identical; exact public test invokes working-tree verify directly after final index',
        'consumer_entrypoint': 't00_admission_consumer::working_tree_projection',
        'required_native_profiles': ['ordinary structural index', 'qualified selected index context', 'qualified broad current context'],
        'gaps': [],
    })
    semantic = {'root': a.normalize_path(repository), 'index_epoch': latest['sequence'],
                'index_snapshot_template': structural, 'qualified_selected_template': selected,
                'qualified_broad_template': broad, 'index_epoch_files': index_files, 'current_epoch_files': current_files,
                'selected_discovery_config': prepared['selected_discovery_config'], 'broad_discovery_config': prepared['broad_discovery_config']}
    prepared['invocation_group_id'] = a.digest(a.canonical(semantic))
    return prepared


def project_full_admission(prepared, observed):
    # Actual Rust kernel owns every admission/rule/freshness decision. This wrapper
    # selects its DTO; it never builds missing reasons or a fallback verdict.
    if (observed.get('consumer_kind') != 't00-public-working-tree-admission-v1'
            or observed.get('source_baseline') != '3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b'
            or not isinstance(observed.get('portable_projection'), dict)):
        raise Gap('ACTUAL_RUST_WORKING_TREE_CONSUMER_RECEIPT_REQUIRED')
    return observed['portable_projection']


def prepare_all(root):
    rows = []
    for row_id in ['scope-admission-01', 'scope-admission-02', 'scope-admission-03']:
        vector = a.load(Path(root) / 'public-vectors' / (row_id + '.json'))
        for operation in vector['operations']:
            if operation['baselineFunction'] == 'runVerify':
                rows.append(prepare_full_admission(root, row_id, operation['sequence'], '/case', '/sdk/lib', True))
    if len(rows) != 5:
        raise Gap('FULL_WORKING_TREE_FROZEN_DENOMINATOR_CHANGED')
    return {'schema_version': 1, 'manifest_sha256': a.MANIFEST_SHA, 'execution_enabled': False, 'native_queries': 0, 'recipes': rows}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--frozen', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    plan = prepare_all(args.frozen)
    Path(args.output).write_bytes((json.dumps(plan, ensure_ascii=False, indent=2) + '\n').encode())
    print(json.dumps({'recipes': len(plan['recipes']), 'native_queries': 0, 'execution_enabled': False}))
