import copy
from pathlib import Path
import tempfile
import unittest

from _supplement_test_paths import FROZEN
import public_runtime as runtime


class FrozenDirectoryClosureTests(unittest.TestCase):
    def prepare(self, sequence, destination):
        return runtime.prepare_operation(FROZEN, 'workspace-boundaries-02', sequence,
                                         str(destination).replace('\\', '/'), '/sdk/lib', True)

    def test_frozen_empty_directory_is_physical_and_captured_for_configured_query(self):
        for sequence in [2, 3]:
            with tempfile.TemporaryDirectory() as temporary:
                destination = Path(temporary)/'case'
                prepared = self.prepare(sequence, destination)
                self.assertIn('physical_empty_directories', prepared)
                expected = destination/'fixture-000/repo/.git'
                self.assertEqual(prepared['physical_empty_directories'], [str(expected).replace('\\', '/')])
                self.assertNotIn(str(expected).replace('\\', '/'), prepared['request']['files'])
                if sequence == 3:
                    self.assertIn(str(expected).replace('\\', '/'), prepared['request']['directories'])
                receipt = runtime.materialize_physical(prepared)
                self.assertTrue(expected.is_dir())
                self.assertEqual(list(expected.iterdir()), [])
                self.assertEqual(receipt['empty_directories'][0]['kind'], 'directory')
                self.assertFalse(receipt['empty_directories'][0]['authority']['directory_listing_captured'])

    def test_missing_foreign_authority_or_directory_refuses_before_writes(self):
        for poison in ['missing', 'hash', 'path', 'capture']:
            with tempfile.TemporaryDirectory() as temporary:
                destination = Path(temporary)/'case'
                prepared = self.prepare(3, destination)
                if poison == 'missing':
                    prepared.pop('directory_setup_authority')
                elif poison == 'hash':
                    prepared['directory_setup_authority']['source_sha256'] = '0'*64
                elif poison == 'path':
                    prepared['physical_empty_directories'] = [str(destination/'foreign/.git')]
                else:
                    prepared['request']['directories'].remove(prepared['physical_empty_directories'][0])
                with self.subTest(poison=poison), self.assertRaises(ValueError):
                    runtime.materialize_physical(prepared)
                self.assertFalse(destination.exists())

    def test_directory_authority_is_not_a_generic_physical_directory_api(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary)/'case'
            prepared = copy.deepcopy(self.prepare(3, destination))
            prepared['row_id'] = 'native-inert-01'
            with self.assertRaisesRegex(ValueError, 'OUTSIDE_EXACT_FROZEN_VECTOR'):
                runtime.materialize_physical(prepared)
            self.assertFalse(destination.exists())

    def test_absent_configured_boundary_is_explicit_and_only_for_the_live_call(self):
        with tempfile.TemporaryDirectory() as temporary:
            retained = self.prepare(2, Path(temporary)/'retained')
            live = self.prepare(3, Path(temporary)/'live')
            self.assertNotIn('repository_boundary', retained['request'])
            self.assertEqual(live['request']['repository_boundary'], {'mode': 'absent'})
            self.assertFalse(live['retained'])
            self.assertTrue(any(path.endswith('/pnpm-workspace.yaml') for path in live['request']['files']))


if __name__ == '__main__':
    unittest.main()
