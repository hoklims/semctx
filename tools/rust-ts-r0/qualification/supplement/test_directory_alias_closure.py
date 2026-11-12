import copy
import json
import os
from pathlib import Path
import tempfile
import unittest

from _supplement_test_paths import FROZEN
import directory_closure as closure
import public_bridge as bridge
import public_runtime as runtime


class FrozenAliasTargetClosureTests(unittest.TestCase):
    def prepare(self, target):
        return runtime.prepare_operation(FROZEN, 'directory-alias-03', 8,
            str(target).replace('\\', '/'), '/sdk/lib', True)

    def test_preparer_restores_only_the_frozen_empty_target_and_retains_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)/'case'
            prepared = self.prepare(target)
            expected = str(target/'fixture-000/outside').replace('\\', '/')
            self.assertEqual(prepared.get('physical_prelink_empty_directories'), [expected],
                'frozen empty symlink target must be in prepared physical input closure')
            links = [entry for entry in prepared['physical_setup'] if 'symlink' in entry]
            self.assertEqual(len(links), 2)
            self.assertEqual(links[1]['symlink'], expected)
            self.assertFalse(target.exists())
            (target/'fixture-000/physical').mkdir(parents=True)
            records = closure.materialize_prelinks(prepared)
            self.assertTrue(Path(expected).is_dir())
            self.assertEqual(list(Path(expected).iterdir()), [])
            self.assertEqual(records[0]['purpose'], 'existing_captured_symlink_target')
            self.assertFalse(records[0]['authority']['directory_listing_captured'])
            self.assertEqual(records[0]['authority']['additional_symlinks_created'], 0)

    def test_native_setup_has_healthy_existing_directory_links_when_os_supports_them(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)/'case'
            prepared = self.prepare(target)
            try:
                receipt = runtime.materialize_physical(prepared)
            except OSError as error:
                if os.name == 'nt' and getattr(error, 'winerror', None) == 1314:
                    self.skipTest('Windows directory symlink API unavailable; no native property credit')
                raise
            fixture = target/'fixture-000'
            self.assertTrue((fixture/'physical/external').is_symlink())
            self.assertTrue((fixture/'physical/external').is_dir())
            self.assertEqual((fixture/'physical/external').resolve(), (fixture/'outside').resolve())
            self.assertEqual((fixture/'alias').resolve(), (fixture/'physical').resolve())
            self.assertEqual(list((fixture/'outside').iterdir()), [])
            self.assertEqual(len(receipt['prelink_empty_directories']), 1)
            self.assertEqual(receipt['native_queries'], 0)
            self.assertFalse((fixture/'physical/external/not-created/missing.mjs').exists())

    def test_foreign_authority_paths_links_and_closure_refuse_before_writes(self):
        for poison in ['missing', 'hash', 'path', 'layout', 'link', 'extra-file', 'row', 'function', 'sequence']:
            with self.subTest(poison=poison), tempfile.TemporaryDirectory() as temporary:
                target = Path(temporary)/'case'
                prepared = self.prepare(target)
                if poison == 'missing': prepared.pop('prelink_directory_setup_authority')
                elif poison == 'hash': prepared['prelink_directory_setup_authority']['source_sha256'] = '0'*64
                elif poison == 'path': prepared['physical_prelink_empty_directories'] = [str(Path(temporary)/'escape')]
                elif poison == 'layout': prepared['relocations'][0] = (prepared['relocations'][0][0], str(Path(temporary)/'outside'))
                elif poison == 'link': prepared['physical_setup'][1]['symlink'] = str(Path(temporary)/'outside')
                elif poison == 'extra-file': prepared['physical_setup'].append(copy.deepcopy(prepared['physical_setup'][-1]))
                elif poison == 'row': prepared['row_id'] = 'directory-alias-01'
                elif poison == 'function': prepared['baseline_function'] = 'analyzeRepository'
                else: prepared['sequence'] = 7
                with self.assertRaises(ValueError): runtime.materialize_physical(prepared)
                self.assertFalse(target.exists())

    def test_tampered_caller_bytes_refuse_before_writes(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)/'case'
            prepared = self.prepare(target)
            fake = Path(temporary)/'foreign-frozen'
            fake.mkdir()
            (fake/'manifest-sha256.json').write_bytes((FROZEN/'manifest-sha256.json').read_bytes())
            source = fake/closure.ALIAS_SOURCE
            source.parent.mkdir(parents=True)
            source.write_bytes((FROZEN/closure.ALIAS_SOURCE).read_bytes()+b'\n// altered caller\n')
            prepared['prelink_directory_setup_authority']['manifest_path'] = str(fake/'manifest-sha256.json')
            with self.assertRaisesRegex(ValueError, 'DIRECTORY_SETUP_AUTHORITY_DIFFERS'):
                runtime.materialize_physical(prepared)
            self.assertFalse(target.exists())

    def test_materialization_refuses_existing_target_and_preserves_its_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)/'case'
            prepared = self.prepare(target)
            sentinel = target/'fixture-000/outside/sentinel'
            sentinel.parent.mkdir(parents=True)
            sentinel.write_bytes(b'owned negative control')
            with self.assertRaises(FileExistsError): closure.materialize_prelinks(prepared)
            self.assertEqual(sentinel.read_bytes(), b'owned negative control')

    def test_prelink_parent_alias_cannot_escape_owned_case(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)/'case'
            prepared = self.prepare(target)
            foreign = Path(temporary)/'foreign'
            foreign.mkdir()
            target.mkdir()
            try: (target/'fixture-000').symlink_to(foreign, target_is_directory=True)
            except OSError as error:
                if os.name == 'nt' and getattr(error, 'winerror', None) == 1314:
                    self.skipTest('Windows directory symlink API unavailable; no native property credit')
                raise
            with self.assertRaisesRegex(ValueError, 'ESCAPES_CASE'):
                closure.materialize_prelinks(prepared)
            self.assertEqual(list(foreign.iterdir()), [])

    def test_invocation_identity_binds_prelink_authority_and_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            prepared = self.prepare(Path(temporary)/'case')
            vector = json.loads((FROZEN/'public-vectors/directory-alias-03.json').read_text())
            operation = vector['operations'][0]
            original = bridge.invocation_key(prepared, operation, vector)
            for field in ['physical_prelink_empty_directories', 'prelink_directory_setup_authority']:
                poison = copy.deepcopy(prepared)
                if field == 'physical_prelink_empty_directories': poison[field] = [str(Path(temporary)/'outside')]
                else: poison[field]['source_sha256'] = '0'*64
                self.assertNotEqual(original, bridge.invocation_key(poison, operation, vector))


if __name__ == '__main__': unittest.main()
