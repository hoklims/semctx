import ast
import copy
import json
import pathlib
import unittest

from existing_semantic_reason_assertions import append_existing_semantic_reason_assertions, TARGET

SOURCE = pathlib.Path(__file__).resolve().parent
ROOT = SOURCE.parents[2]
DOCUMENT = ROOT / 'docs/research/rust-ts-r0/resumption/existing-semantic-reason-assertions-20261021.json'

def preparer_functions():
    # Execute only four existing function definitions, never preparer top-level corpus reads.
    tree = ast.parse((SOURCE / 'prepare_recipes.py').read_text(encoding='utf-8'))
    names = {'check', 'operation_binding', 'add_bound_check', 'complete_component_fields'}
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert len(selected) == len(names)
    scope = {}
    exec(compile(ast.Module(body=selected, type_ignores=[]), 'existing-public-preparer-functions', 'exec'), scope)
    return scope

class ExistingSemanticReasonAssertionsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = json.loads(DOCUMENT.read_text(encoding='utf-8'))
        cls.input_pins = json.loads((SOURCE / 'existing-semantic-reason-input-pins.json').read_text(encoding='utf-8'))['rows']
        cls.preparer = preparer_functions()

    def recipes(self):
        return [{**copy.deepcopy(row), 'checks': [{'original': {'opaque': True}}], 'unrelated_metadata': {'preserve': 1}} for row in self.input_pins]

    def append(self, recipes, document=None):
        append_existing_semantic_reason_assertions(recipes, document or self.document, 'derived-public-document.json', self.preparer['add_bound_check'])

    def test_six_appends_preserve_requests_old_checks_and_every_other_field(self):
        recipes = self.recipes()
        before = copy.deepcopy(recipes)
        self.append(recipes)
        for actual, original in zip(recipes, before, strict=True):
            self.assertEqual(actual['checks'][:-1], original['checks'])
            self.assertEqual({k:v for k,v in actual.items() if k != 'checks'}, {k:v for k,v in original.items() if k != 'checks'})
            check = actual['checks'][-1]
            self.assertEqual(check['target'], TARGET)
            self.assertEqual(check['operation_binding']['target'], TARGET)
            self.assertEqual(check['operation_binding']['status'], 'VERIFIED_SOURCE_OPERATION')

    def test_missing_or_misbound_operation_metadata_is_refused_without_partial_append(self):
        mutations = [
            lambda c: c.pop('operation_binding'),
            lambda c: c['operation_binding'].update(target=['wrong', 'reasons']),
            lambda c: c['operation_binding'].update(baseline_operation='inspectSemanticDependencies'),
            lambda c: c['operation_binding'].update(status='UNVERIFIED'),
            lambda c: c['operation_binding'].update(authority={}),
            lambda c: c.update(target=['subjects', {'path':'main.ts'}, 'semanticObservation', 'reasons']),
        ]
        for mutate in mutations:
            document = copy.deepcopy(self.document)
            mutate(document['assertions'][-1]['checks'][0])
            recipes = self.recipes()
            before = copy.deepcopy(recipes)
            with self.assertRaisesRegex(ValueError, 'verified source-operation'):
                self.append(recipes, document)
            self.assertEqual(recipes, before)

    def test_changed_sources_roots_options_and_frozen_identity_are_refused(self):
        for field in ['files', 'roots', 'options', 'retained']:
            recipes = self.recipes()
            recipes[-1]['requests'][0][field] = None
            before = copy.deepcopy(recipes)
            with self.assertRaisesRegex(ValueError, 'unchanged frozen request'):
                self.append(recipes)
            self.assertEqual(recipes, before)
        for field in ['frozen_unit_pointer', 'frozen_unit_sha256']:
            recipes = self.recipes()
            recipes[-1][field] = 'forged'
            with self.assertRaises(ValueError):
                self.append(recipes)

    def test_only_the_six_existing_rows_and_complete_derived_reason_sets_are_allowed(self):
        for rows in [self.document['assertions'][:-1], self.document['assertions'] + self.document['assertions'][:1], self.document['assertions'][:1] * 6]:
            document = {**self.document, 'assertions': rows}
            with self.assertRaisesRegex(ValueError, 'six authorized'):
                self.append(self.recipes(), document)
        document = copy.deepcopy(self.document)
        document['assertions'][-1]['checks'][0]['expected'] = {'contains': ['fabricated']}
        with self.assertRaisesRegex(ValueError, 'complete derived'):
            self.append(self.recipes(), document)

    def test_existing_completeness_helper_targets_the_same_nested_component(self):
        recipes = self.recipes()
        self.append(recipes)
        for recipe in recipes:
            recipe['checks'] = recipe['checks'][1:]
            self.preparer['complete_component_fields'](recipe)
            for field, expected in [('executed', True), ('unsupported', [])]:
                self.assertTrue(any(c['target'] == TARGET[:-1] + [field] and c['expected'] == expected and c['mode'] == 'eq' for c in recipe['checks']))

if __name__ == '__main__':
    unittest.main()
