import copy
import json
import os
from pathlib import Path
import unittest
from source_adapter import source_rows, materialize_checks, verify_frozen, resolve
from source_scope_addenda import attach_source_scopes, prepare_addenda, SCOPE_IDS

CASES = Path(os.environ['T00_CASES_ROOT']) if 'T00_CASES_ROOT' in os.environ else Path(__file__).resolve().parents[4] / 'docs/research/rust-ts-r0/cases'


class MappingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.frozen = CASES / 'supplement-v2'
        cls.indexed = verify_frozen(cls.frozen)
        cls.rows = source_rows(cls.frozen, cls.indexed)
        for row in cls.rows:
            row['recipes'] = [materialize_checks(row, cls.frozen, cls.indexed)]
            row['operation_mappings'] = []
        cls.addenda = prepare_addenda(CASES)

    def test_seven_full_scope_outputs_and_exact_input_contract(self):
        document = attach_source_scopes({'rows': copy.deepcopy(self.rows)}, self.frozen)
        scopes = [r for row in document['rows'] for r in row['recipes'] if r['surface'] == 'source_scope_cli']
        self.assertEqual(len(scopes), 7)
        self.assertEqual(len(document['rows']), 67)
        for recipe in scopes:
            self.assertEqual(recipe['git_setup'], [['git', 'init', '-q']])
            self.assertEqual(recipe['scope_input']['graph'], {'nodes': [], 'edges': []})
            self.assertEqual(recipe['scope_input']['expectedInputHash'], 'retained-witness')
            self.assertFalse(recipe['scope_input']['checkChanged'])
            self.assertEqual(recipe['expected_scope'], resolve(self.frozen, self.indexed, recipe['expected_scope_ref']))
            self.assertEqual(set(recipe['expected_scope']), {'links', 'reasons', 'externalModuleSpecifiers', 'unresolvedImports'})
        retained = next(r for r in scopes if r['unit_id'] == 'source::reference-retained')
        self.assertEqual(retained['requests'][0]['roots'], ['main.ts', 'generated.ts'])
        for row in document['rows']:
            if row['id'].removeprefix('source::') in SCOPE_IDS:
                self.assertNotIn('UNKNOWN_NATIVE_LIFECYCLE_MAPPING', row['gaps'])
                self.assertEqual(row['unmapped_expected_fields'], [])

    def test_missing_scope_mapping_refuses(self):
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            attach_source_scopes({'rows': copy.deepcopy(self.rows[:-20])}, self.frozen)

    def test_eight_independent_reason_components_with_bindings_and_guards(self):
        self.assertEqual(self.addenda['counts'], {'addenda': 8})
        for row in self.addenda['rows']:
            recipe = row['recipes'][0]
            request = recipe['requests'][0]
            self.assertEqual(list(request['files']), ['main.ts'])
            self.assertEqual(request['roots'], ['main.ts'])
            self.assertEqual(len(row['actual_program_refs']), 2)
            reason_checks = [c for c in recipe['checks'] if c['target'][-1] == 'reasons']
            self.assertEqual(len(reason_checks), 2)
            self.assertEqual(len(recipe['checks']), 6)
            for check in reason_checks:
                self.assertEqual(check['operation_binding']['target'], check['target'])
                self.assertEqual(check['operation_binding']['authority'], check['expected_origin'])
                prefix = check['target'][:-1]
                for key, value in [('executed', True), ('unsupported', [])]:
                    self.assertTrue(any(c['target'] == prefix + [key] and c['expected'] == value for c in recipe['checks']))
            ref = row['expected_ref']
            actual = json.loads(Path(ref['path']).read_text(encoding='utf-8'))[int(ref['pointer'][1:])]
            self.assertEqual(reason_checks[0]['expected'], actual['response']['semantic'])
            self.assertEqual(reason_checks[1]['expected'], actual['response']['configuration'])


if __name__ == '__main__':
    unittest.main()
