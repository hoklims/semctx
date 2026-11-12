"""Append only the six TS-baseline-derived semantic reason checks, with source binding."""
import hashlib
import json

UNITS = {
    'ORD-CALLABLE-DECLARATION-PAIR::variant-01', 'ORD-CALLABLE-DECLARATION-PAIR::variant-02',
    'V2-G11-constrained-sdk-generic-literal-input::base', 'V2-G12-constrained-sdk-generic-unknown-input::base',
    'V3-SDK-02-08::base', 'V3-SDK-02-02::base',
}
OPERATION = 'inspectModuleConfiguration retained snapshot without supplied SourceFile'
TARGET = ['subjects', {'path': 'main.ts'}, 'moduleConfigurationObservations', 'retainedWithoutSource', 'reasons']
BASELINE = '3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b'
SOURCE = 'packages/ts-analyzer/src/javascript-diagnostics.ts'

def append_existing_semantic_reason_assertions(recipes, document, origin, add_bound_check):
    assertions = document.get('assertions', [])
    if len(assertions) != 6 or {a['unit_id'] for a in assertions} != UNITS:
        raise ValueError('semantic reason assertions require exactly six authorized existing units')
    pending = []
    for index, assertion in enumerate(assertions):
        matches = [r for r in recipes if r['unit_id'] == assertion['unit_id']]
        if len(matches) != 1 or len(matches[0]['requests']) != 1:
            raise ValueError('semantic reason existing request must be unique')
        recipe = matches[0]
        request_hash = hashlib.sha256(json.dumps(recipe['requests'][0], sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        if (recipe['frozen_unit_pointer'] != assertion['frozen_unit_pointer']
                or recipe['frozen_unit_sha256'] != assertion['frozen_unit_sha256']
                or request_hash != assertion['request_sha256']):
            raise ValueError('semantic reason input differs from unchanged frozen request')
        if len(assertion.get('checks', [])) != 1:
            raise ValueError('semantic reason assertion must bind one executed module consumer')
        check = assertion['checks'][0]
        binding = check.get('operation_binding', {})
        authority = binding.get('authority', {})
        if (check.get('target') != TARGET or check.get('mode') != 'reason_constraints'
                or check.get('actual_transform') != 'none' or check.get('observation') != 0
                or binding.get('status') != 'VERIFIED_SOURCE_OPERATION'
                or binding.get('target') != TARGET or binding.get('baseline_operation') != OPERATION
                or authority.get('baseline') != BASELINE or authority.get('path') != SOURCE
                or authority.get('sha256') != document.get('baseline_sources', {}).get(SOURCE)
                or authority.get('start_line') != 363 or authority.get('end_line') != 383):
            raise ValueError('semantic reason check lacks exact verified source-operation binding')
        if (set(check.get('expected', {})) != {'exact_set'}
                or not isinstance(check['expected']['exact_set'], list)
                or any(not isinstance(r, str) for r in check['expected']['exact_set'])
                or check['expected']['exact_set'] != sorted(set(check['expected']['exact_set']))):
            raise ValueError('semantic reason expected set must be the complete derived string set')
        pending.append((recipe, check, f'{origin}#/assertions/{index}/checks/0'))
    for recipe, check, location in pending:
        add_bound_check(recipe, check['target'], check['expected'], check['mode'], location, check['operation_binding']['baseline_operation'], check['operation_binding']['authority'], check['actual_transform'], check['observation'])
