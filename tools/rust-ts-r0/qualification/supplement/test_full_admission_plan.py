from _supplement_test_paths import FROZEN
"""Read-only public input preflight. Never queries the native candidate."""
import unittest
import full_admission_adapter as f
from public_runtime import Gap

ROOT = FROZEN


class FullPlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plan = f.prepare_all(ROOT)

    def test_uses_last_real_index_epoch_instead_of_initial_fixture_index(self):
        self.assertEqual([(r['index_epoch_sequence'], r['sequence']) for r in self.plan['recipes']],
                         [(15, 29), (77, 92), (164, 178), (232, 246), (297, 311)])

    def test_context_profiles_and_captures_are_separate_without_relabelling(self):
        for recipe in self.plan['recipes']:
            ordinary = recipe['index_snapshot_template']
            qualified = recipe['qualified_selected_template']
            self.assertFalse(ordinary['qualified'])
            self.assertTrue(qualified['qualified'])
            self.assertNotEqual(ordinary['id'], qualified['id'])
            self.assertEqual(ordinary['files'], qualified['files'])
            self.assertEqual(recipe['index_epoch_files'], recipe['current_epoch_files'])
            self.assertEqual(recipe['git_after_index'], [])
            self.assertFalse(recipe['execution_enabled'])

    def test_generated_physical_file_is_not_promoted_into_retained_snapshot(self):
        reference = self.plan['recipes'][0]
        self.assertIn('build/generated.ts', reference['index_epoch_files'])
        self.assertNotIn('build/generated.ts', reference['index_snapshot_template']['files'])

    def test_formatter_never_invents_a_missing_consumer_projection(self):
        with self.assertRaises(Gap):
            f.project_full_admission({}, {'status': 'admitted'})
        actual = {'verdict': 'BLOCK', 'admission': {'status': 'rejected'}}
        self.assertIs(f.project_full_admission({}, {'consumer_kind': 't00-public-working-tree-admission-v1',
            'source_baseline': '3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b', 'portable_projection': actual}), actual)


if __name__ == '__main__':
    unittest.main()
