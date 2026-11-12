from _supplement_test_paths import FROZEN, RUNTIME
"""Read-only public input preflight. Never queries the native candidate."""
import unittest
import copy
from pathlib import Path
import tempfile
import public_bridge
import lifecycle_adapter_29_strict as lifecycle
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

    def test_public_bridge_routes_only_bound_actual_full_consumer_dto(self):
        # Synthetic formatter input only: no native query or qualification credit.
        prepared = self.plan['recipes'][0]
        observed = {'consumer_kind': 't00-public-working-tree-admission-v1',
                    'source_baseline': '3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b',
                    'consumer_artifact_sha256': 'a'*64,
                    'repository_root': prepared['repository_root'],
                    '_rust_full_admission_context': {'consumer_artifact_sha256': 'a'*64},
                    'portable_projection': {'verdict': 'BLOCK'}}
        try:
            public_bridge.lifecycle_projection_guard(prepared, observed)
        except ValueError as error:
            self.fail('Bound full consumer DTO was rejected: '+str(error))
        self.assertIs(lifecycle.project_lifecycle(prepared, observed), observed['portable_projection'])
        for field, poison in [('consumer_kind', 'component-only'), ('source_baseline', 'foreign'),
                              ('consumer_artifact_sha256', 'b'*64), ('portable_projection', None)]:
            changed = copy.deepcopy(observed)
            changed[field] = poison
            with self.subTest(field=field), self.assertRaises(ValueError):
                public_bridge.lifecycle_projection_guard(prepared, changed)
        foreign = copy.deepcopy(prepared)
        foreign['adapter'] = 'lifecycle_adapter'
        with self.assertRaises(ValueError):
            public_bridge.lifecycle_projection_guard(foreign, observed)
        changed = copy.deepcopy(observed)
        del changed['_rust_full_admission_context']
        with self.assertRaises(ValueError):
            public_bridge.lifecycle_projection_guard(prepared, changed)

    def test_public_bridge_joins_recipe_capture_and_consumer_before_projection(self):
        from public_runtime import native_canonical
        prepared = copy.deepcopy(self.plan['recipes'][0])
        prepared['source_capture_stream_sha256'] = 'c'*64
        observed = {'consumer_kind': 't00-public-working-tree-admission-v1',
                    'source_baseline': '3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b',
                    'consumer_artifact_sha256': 'a'*64, 'portable_projection': {'verdict': 'BLOCK'}}
        evidence = {'lifecycle_observed': observed, 'binding': {
            'source_recipe_id': 'sha256:'+public_bridge.digest(native_canonical(prepared).encode('utf-8')),
            'capture_stream_sha256': 'c'*64, 'consumer_artifact_sha256': 'a'*64}}
        self.assertEqual(public_bridge.bound_lifecycle_observation(prepared, evidence)['portable_projection'],
                         observed['portable_projection'])
        self.assertNotIn('_rust_full_admission_context', observed)
        for key in ['source_recipe_id', 'capture_stream_sha256', 'consumer_artifact_sha256']:
            changed = copy.deepcopy(evidence)
            changed['binding'][key] = 'foreign'
            with self.subTest(binding=key), self.assertRaises(ValueError):
                public_bridge.bound_lifecycle_observation(prepared, changed)


    def test_actual_public_planner_keeps_full_consumer_tag_and_legacy_default(self):
        with tempfile.TemporaryDirectory() as temporary:
            planned = public_bridge.plan(ROOT, RUNTIME, Path(temporary)/'planned', '/sdk/lib', True,
                                         ownership_module_dir=RUNTIME, lifecycle_module_dir=RUNTIME)
        invocations = [row['prepared'] for row in planned['invocations']]
        full = [value for value in invocations if value.get('public_flow_kind') == 'public-verify']
        self.assertEqual(len(full), 5)
        self.assertEqual([(value['index_epoch_sequence'], value['sequence']) for value in full],
                         [(15, 29), (77, 92), (164, 178), (232, 246), (297, 311)])
        for value in full:
            self.assertEqual(value['adapter'], 'full_admission_adapter')
            self.assertEqual(value['consumer_entrypoint'], 't00_admission_consumer::working_tree_projection')
            self.assertEqual(value['index_epoch_files'], value['current_epoch_files'])
            self.assertFalse(value['index_snapshot_template']['qualified'])
            self.assertTrue(value['qualified_selected_template']['qualified'])
            self.assertTrue(value['qualified_broad_template']['qualified'])
            self.assertFalse(value['execution_enabled'])
        legacy = [value for value in invocations if value.get('surface') == 'qualified_flow_cli'
                  and value.get('public_flow_kind') != 'public-verify']
        self.assertTrue(legacy)
        self.assertTrue(all(value['adapter'] == 'lifecycle_adapter' for value in legacy))
        # Synthetic formatter carrier only; actual Rust acquisition stays separate.
        actual = {'consumer_kind':'t00-public-working-tree-admission-v1',
                  'source_baseline':'3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b',
                  'portable_projection':{'verdict':'WARN','admission':{'status':'rejected'}}}
        self.assertEqual(lifecycle.project_lifecycle(full[0], actual), actual['portable_projection'])
        foreign = copy.deepcopy(full[0]); foreign['adapter'] = 'lifecycle_adapter'
        with self.assertRaises((Gap, KeyError)):
            lifecycle.project_lifecycle(foreign, actual)


if __name__ == '__main__':
    unittest.main()
