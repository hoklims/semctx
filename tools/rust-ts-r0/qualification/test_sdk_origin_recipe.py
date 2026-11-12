import copy
import json
import pathlib
import unittest

from sdk_origin_recipe import append_sdk_origin_checks

ROOT = pathlib.Path(__file__).resolve().parents[3]
DOCUMENT = ROOT / 'docs/research/rust-ts-r0/resumption/sdk-origin-assertions-20261021.json'

class SdkOriginRecipeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = json.loads(DOCUMENT.read_text(encoding='utf-8'))
        # Only the 12 requests already frozen in the public oracle; no new source inputs.
        oracle_path = pathlib.Path(__file__).resolve().parent / 'sdk-origin-test-requests.json'
        cls.requests = json.loads(oracle_path.read_text(encoding='utf-8'))

    def recipes(self):
        return [dict(unit_id=a['unit_id'], frozen_unit_pointer=a['frozen_unit_pointer'], frozen_unit_sha256=a['frozen_unit_sha256'], requests=[copy.deepcopy(self.requests[a['unit_id']])], checks=[dict(original=True)]) for a in self.document['assertions']]

    def test_only_appends_twelve_checks_and_preserves_all_existing_fields(self):
        recipes = self.recipes()
        recipes.append(dict(unit_id='unrelated-existing-row', requests=[], checks=[dict(original=True)]))
        before = copy.deepcopy(recipes)
        append_sdk_origin_checks(recipes, self.document, 'separate-assertions.json')
        self.assertEqual(recipes[-1], before[-1])
        for actual, original in zip(recipes[:-1], before[:-1], strict=True):
            self.assertEqual(actual['checks'][:-1], original['checks'])
            self.assertEqual({k:v for k,v in actual.items() if k != 'checks'}, {k:v for k,v in original.items() if k != 'checks'})
            self.assertEqual(actual['checks'][-1]['target'], ['_sdk_origin_assertion'])
            self.assertEqual(actual['checks'][-1]['mode'], 'eq')

    def test_changed_request_is_rejected_before_any_append(self):
        for field in ['files', 'roots', 'options']:
            recipes = self.recipes()
            recipes[-1]['requests'][0][field] = {}
            before = copy.deepcopy(recipes)
            with self.assertRaisesRegex(ValueError, 'unchanged frozen request'):
                append_sdk_origin_checks(recipes, self.document, 'origin')
            self.assertEqual(recipes, before)

    def test_changed_frozen_id_hash_or_pointer_is_rejected(self):
        for field in ['frozen_unit_sha256', 'frozen_unit_pointer']:
            recipes = self.recipes()
            recipes[-1][field] = 'forged'
            before = copy.deepcopy(recipes)
            with self.assertRaises(ValueError):
                append_sdk_origin_checks(recipes, self.document, 'origin')
            self.assertEqual(recipes, before)

    def test_rows_beyond_authorized_twelve_missing_and_duplicates_are_rejected(self):
        for assertions in [self.document['assertions'][:-1], self.document['assertions'] + [self.document['assertions'][0]], [self.document['assertions'][0]] * 12]:
            document = {**self.document, 'assertions': assertions}
            recipes = self.recipes()
            before = copy.deepcopy(recipes)
            with self.assertRaisesRegex(ValueError, '12 authorized'):
                append_sdk_origin_checks(recipes, document, 'origin')
            self.assertEqual(recipes, before)

if __name__ == '__main__':
    unittest.main()
