import copy
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

from ordinary_existing_assertions import append_existing_assertions


class ExistingAssertionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='t00-ordinary-assertions-')
        cls.addClassCleanup(cls.directory.cleanup)
        source = pathlib.Path(__file__).resolve().parent
        output = pathlib.Path(cls.directory.name) / 'recipes'
        subprocess.run([sys.executable, str(source / 'prepare_recipes.py'), '--output', str(output)],
                       check=True, capture_output=True, text=True)
        cls.inputs = json.loads((output / 'replay-recipes.json').read_text(encoding='utf-8'))

    def setUp(self):
        self.frozen = json.loads(pathlib.Path(__file__).with_name('ordinary-existing-assertions.json').read_text(encoding='utf-8'))
        # Tests use only the immutable request inputs, never the old expected checks.
        inputs = {r['unit_id']: r['requests'] for r in self.inputs['recipes']}
        self.recipes = [{**{k: a[k] for k in ['unit_id', 'frozen_unit_pointer', 'frozen_unit_sha256']},
                         'requests': inputs[a['unit_id']], 'checks': [{'sentinel': 'old check'}]}
                        for a in self.frozen['assertions']]

    def test_append_preserves_every_input_and_old_check(self):
        before = copy.deepcopy(self.recipes)
        append_existing_assertions(self.recipes, self.frozen, 'frozen.json')
        self.assertEqual(len(before), len(self.recipes))
        for old, new, frozen in zip(before, self.recipes, self.frozen['assertions'], strict=True):
            self.assertEqual(old['requests'], new['requests'])
            self.assertEqual(old['checks'], new['checks'][:1])
            self.assertEqual(len(new['checks']), len(frozen['checks']) + 1)
            self.assertTrue(all(c['expected_origin'].startswith('frozen.json#/assertions/') for c in new['checks'][1:]))

    def test_input_drift_fails_without_partial_mutation(self):
        for field in ['frozen_unit_pointer', 'frozen_unit_sha256', 'requests']:
            with self.subTest(field=field):
                recipes = copy.deepcopy(self.recipes)
                if field == 'requests': recipes[-1][field][0]['files']['main.ts'] += ' '
                else: recipes[-1][field] = 'changed'
                before = copy.deepcopy(recipes)
                with self.assertRaises(ValueError): append_existing_assertions(recipes, self.frozen, 'frozen.json')
                self.assertEqual(before, recipes)

    def test_changed_source_hash_fails(self):
        frozen = copy.deepcopy(self.frozen)
        frozen['assertions'][-1]['input_documents'][0]['sha256'] = 'bad'
        before = copy.deepcopy(self.recipes)
        with self.assertRaises(ValueError): append_existing_assertions(self.recipes, frozen, 'frozen.json')
        self.assertEqual(before, self.recipes)

    def test_wrong_baseline_is_refused(self):
        self.frozen['baseline'] = 'candidate'
        with self.assertRaises(ValueError): append_existing_assertions(self.recipes, self.frozen, 'frozen.json')


if __name__ == '__main__': unittest.main()
