from _supplement_test_paths import FROZEN, RUNTIME
"""Comparator/preflight tests only; no candidate process, Rust build or native case."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from prepare_registry import prepare
from preflight import validate
from source_adapter import MANIFEST_SHA, digest, pointer, resolve, verify_frozen

HERE = Path(__file__).resolve().parent



class DraftAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.indexed = verify_frozen(FROZEN)
        cls.document = prepare(FROZEN)

    def test_manifest_identity_and_all67_source_coordinates(self):
        self.assertEqual(digest((FROZEN/'manifest-sha256.json').read_bytes()), MANIFEST_SHA)
        rows = self.document['rows']
        self.assertEqual(len(rows), 67)
        self.assertEqual(len({row['id'] for row in rows}), 67)
        self.assertEqual(self.document['counts']['original_units_unchanged'], 354)
        self.assertEqual(self.document['counts']['original_supports_unchanged'], 51)

    def test_all_expected_literals_are_exact_frozen_refs(self):
        for row in self.document['rows']:
            for recipe in row['recipes']:
                for check in recipe.get('checks', []):
                    if isinstance(check['expected_origin'], dict):
                        self.assertEqual(check['expected'], resolve(FROZEN, self.indexed, check['expected_origin']))

    def test_positive_pointer_and_absence_are_distinct_from_null(self):
        self.assertEqual(pointer({'a': [{'b/c': None}]}, '/a/0/b~1c'), None)
        with self.assertRaises(KeyError):
            pointer({'a': [{}]}, '/a/0/b~1c')

    def test_foreign_or_modified_expected_ref_is_rejected(self):
        ref = copy.deepcopy(self.document['rows'][0]['checks'][0]['expected_ref'])
        ref['sha256'] = '0'*64
        with self.assertRaises(ValueError):
            resolve(FROZEN, self.indexed, ref)
        ref['manifest_sha256'] = 'f'*64
        with self.assertRaises(ValueError):
            resolve(FROZEN, self.indexed, ref)

    def test_source_dts_physical_file_is_not_silently_added_to_capture(self):
        row = next(row for row in self.document['rows'] if row['id'] == 'source::computed-dts')
        self.assertNotIn('main.ts', row['template']['files'])
        self.assertIn('main.ts', row['physical_only_files'])
        self.assertEqual(row['recipes'][0]['physical_uncaptured_files'], row['physical_only_files'])
        self.assertEqual(row['recipes'][0]['physical_live_after_capture'], {})
        self.assertEqual(row['recipes'][0]['surface'], 'declaration_root_cli')
        self.assertIn('main.d.ts', row['template']['roots'])
        self.assertTrue(all(path.endswith('.d.ts') for path in row['template']['roots']))
        self.assertNotIn('main.ts', row['template']['roots'])
        self.assertNotIn('main.ts', row['recipes'][0]['requests'][0]['files'])

    def test_all_source_capture_bytes_are_preserved_without_newline_rewrite(self):
        for row in self.document['rows'][:50]:
            prefix = 'v1-preserved/observed/fixtures/'+row['id'].removeprefix('source::')+'/'
            for name, text in row['template']['files'].items():
                self.assertEqual(text.encode('utf-8'), (FROZEN/(prefix+name)).read_bytes())

    def test_semantic_contexts_use_actual_records_not_auxiliary_origins(self):
        for row in self.document['rows']:
            self.assertFalse(row['parameters']['auxiliary_program_may_substitute'])
            for ref in row['actual_program_refs']:
                context = resolve(FROZEN, self.indexed, ref)
                self.assertEqual(context['caseSensitive'], row['parameters']['baseline_observed_case_sensitive'])
                self.assertIsNone(row['parameters']['case_sensitive'])
                self.assertEqual(context['options'], row['parameters']['compiler_options_ts'])

    def test_snapshot_full_error_and_prefix_are_both_frozen(self):
        row = next(row for row in self.document['rows'] if row['id'] == 'source::snapshot')
        recipe = next(r for r in row['recipes'] if r['surface'] == 'snapshot_boundary_cli')
        expected = resolve(FROZEN, self.indexed, recipe['expected_error_ref'])
        self.assertEqual(recipe.get('expected_error'), expected)
        self.assertEqual(recipe['expected_error_code'], expected.split(':', 1)[0])
        with tempfile.TemporaryDirectory() as directory:
            registry = Path(directory)/'registry.json'
            abi = Path(directory)/'abi-freeze.json'
            def check(document):
                registry.write_text(json.dumps(document), encoding='utf-8')
                abi.write_text(json.dumps({'manifest_sha256': MANIFEST_SHA, 'execution_enabled': False, 'files': {'registry.json': digest(registry.read_bytes())}}), encoding='utf-8')
                return validate(registry, FROZEN, abi)
            check(self.document)
            for error in [recipe['expected_error_code'], expected+' changed suffix', None]:
                bad = copy.deepcopy(self.document)
                item = next(r for row in bad['rows'] if row['id']=='source::snapshot' for r in row['recipes'] if r['surface']=='snapshot_boundary_cli')
                if error is None: item.pop('expected_error', None)
                else: item['expected_error'] = error
                with self.assertRaises((ValueError, KeyError)): check(bad)
            bad = copy.deepcopy(self.document)
            item = next(r for row in bad['rows'] if row['id']=='source::snapshot' for r in row['recipes'] if r['surface']=='snapshot_boundary_cli')
            item['expected_error_code'] = 'OTHER_PREFIX'
            with self.assertRaises(ValueError): check(bad)

    def test_no_program_is_invented_for_early_baseline_returns(self):
        row = next(row for row in self.document['rows'] if row['id'] == 'source::snapshot')
        self.assertFalse(row['baseline_program_created'])
        self.assertEqual(row['actual_program_refs'], [])

    def test_digest_all10_use_exact_frozen_sources_and_full_outline(self):
        rows = [row for row in self.document['rows'] if row['id'].startswith('source::digest-')]
        self.assertEqual(len(rows), 10)
        for row in rows:
            original = resolve(FROZEN, self.indexed, row['expected_refs'][0])
            self.assertEqual(row['template']['files'], {'main.ts': original['source']})
            self.assertEqual(row['recipes'][0]['checks'][0]['expected'], original['outline'])
            self.assertFalse(row['parser_contract']['numeric_enum_mirror_required'])

    def test_component_guards_and_read_binding_entrypoint_are_not_dropped(self):
        for row in self.document['rows']:
            self.assertEqual(row['entrypoint'], 'run_raw_recipe')
            for check in row['checks']:
                if check['target'][-1] == 'reasons':
                    actual = row['recipes'][0]['checks']
                    self.assertTrue(any(c['target'] == check['target'][:-1]+['executed'] and c['expected'] is True for c in actual))
                    self.assertTrue(any(c['target'] == check['target'][:-1]+['unsupported'] and c['expected'] == [] for c in actual))

    def test_draft_can_never_enable_execution_or_award_credit(self):
        self.assertIs(self.document['execution_enabled'], False)
        self.assertIs(self.document['candidate_execution_authorized'], False)
        self.assertEqual(self.document['qualification_credit'], 0)
        self.assertTrue(all(row['execution_enabled'] is False for row in self.document['rows']))

    def test_public_foreign_manifest_cannot_be_composed(self):
        with tempfile.TemporaryDirectory(dir=HERE) as directory:
            public = Path(directory)/'public.json'
            public.write_text(json.dumps({'manifest_sha256': 'wrong', 'rows': [{}]*25}))
            with self.assertRaises(ValueError):
                prepare(FROZEN, public)

    def test_cli_draft_prepare_and_preflight_preserve_existing_output(self):
        with tempfile.TemporaryDirectory(dir=HERE) as directory:
            output = Path(directory)/'draft'
            args = [sys.executable, str(RUNTIME/'prepare_registry.py'), '--frozen', str(FROZEN), '--output', str(output)]
            first = subprocess.run(args, capture_output=True, text=True, timeout=30)
            self.assertEqual(first.returncode, 0, first.stderr)
            expected = (output/'registry.json').read_bytes()
            second = subprocess.run(args, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(second.returncode, 0)
            self.assertEqual((output/'registry.json').read_bytes(), expected)
            result = validate(output/'registry.json', FROZEN, output/'abi-freeze.json')
            self.assertEqual(result['status'], 'DRAFT_PREFLIGHT_ONLY')
            rejected = subprocess.run([sys.executable, str(RUNTIME/'preflight.py'), '--native-run'], capture_output=True, text=True, timeout=10)
            self.assertNotEqual(rejected.returncode, 0)

    def test_preflight_rejects_tampered_recipe_even_with_valid_source_manifest(self):
        with tempfile.TemporaryDirectory(dir=HERE) as directory:
            output = Path(directory)
            registry = output/'registry.json'
            registry.write_text(json.dumps(self.document))
            abi = output/'abi-freeze.json'
            abi.write_text(json.dumps({'manifest_sha256': MANIFEST_SHA, 'execution_enabled': False, 'files': {'registry.json': digest(registry.read_bytes())}}))
            modified = copy.deepcopy(self.document)
            modified['rows'][0]['recipes'][0]['checks'][0]['expected'] = 'forged'
            registry.write_text(json.dumps(modified))
            with self.assertRaisesRegex(ValueError, 'registry bytes'):
                validate(registry, FROZEN, abi)
            abi.write_text(json.dumps({'manifest_sha256': MANIFEST_SHA, 'execution_enabled': False, 'files': {'registry.json': digest(registry.read_bytes())}}))
            with self.assertRaisesRegex(ValueError, 'expected value'):
                validate(registry, FROZEN, abi)


if __name__ == '__main__':
    unittest.main()
