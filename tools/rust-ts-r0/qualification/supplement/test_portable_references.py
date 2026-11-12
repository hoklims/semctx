import tempfile
import unittest
from pathlib import Path

from prepare_registry import canonical_public_references


class PortableReferencesTests(unittest.TestCase):
    def test_relocated_reference_keeps_metadata_and_exact_relative_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            index = {'public-vectors/example.json': {'sha256': 'a' * 64}}
            original = {'path': 'C:/historical/root/public-vectors/example.json',
                        'sha256': 'a' * 64, 'json_pointer': '/operations/2',
                        'metadata': 'untouched source C:/historical/root'}
            actual = canonical_public_references(original, Path(directory), index)
            self.assertEqual(actual['path'], 'public-vectors/example.json')
            self.assertEqual(actual['pointer'], '/operations/2')
            self.assertEqual(actual['metadata'], original['metadata'])
            self.assertEqual(original['path'], 'C:/historical/root/public-vectors/example.json')

    def test_same_basename_or_foreign_bytes_are_not_a_frozen_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            index = {'public-vectors/example.json': {'sha256': 'a' * 64}}
            for path, digest in [('C:/other/example.json', 'a' * 64),
                                 ('C:/other/public-vectors/example.json', 'b' * 64)]:
                with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'outside frozen manifest'):
                    canonical_public_references({'path': path, 'sha256': digest, 'pointer': ''}, Path(directory), index)


if __name__ == '__main__':
    unittest.main()
