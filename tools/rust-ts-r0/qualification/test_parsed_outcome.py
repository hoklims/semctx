"""DEV process-envelope regressions; no native execution or qualification credit."""
import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent / 'property_assessor'
sys.path.insert(0, str(PACKAGE))
import assess_final as assessor


class ParsedOutcomeTests(unittest.TestCase):
    def test_original_carrier_requires_integer_exit_and_byte_counts(self):
        host = {'fixture': {'artifact_sha256': 'a' * 64, 'helper_sha256': 'b' * 64}}
        outcome = {'kind': 'success', 'exit_code': 0, 'stdout': '{"value":true}', 'stderr': ''}
        for stream in ('stdout', 'stderr'):
            raw = outcome[stream].encode('utf-8')
            outcome[stream + '_bytes'] = len(raw)
            outcome[stream + '_hash'] = hashlib.sha256(raw).hexdigest()
        binding = {'artifact_sha256': 'a' * 64, 'helper_sha256': 'b' * 64}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'artifact-observation.json').write_text(
                json.dumps({'before': binding, 'after': binding}), encoding='utf-8')
            for name, field, value in [
                ('healthy', None, None),
                ('boolean-exit', 'exit_code', False),
                ('floating-exit', 'exit_code', 0.0),
                ('boolean-count', 'stderr_bytes', False),
                ('floating-count', 'stdout_bytes', float(outcome['stdout_bytes'])),
            ]:
                with self.subTest(name=name):
                    # Each carrier has its own path so the reader's cache cannot hide a mutation.
                    path = root / (name + '.json')
                    carrier = copy.deepcopy(outcome)
                    if field is not None:
                        carrier[field] = value
                    path.write_text(json.dumps(carrier), encoding='utf-8')
                    if field is None:
                        raw, request, references = assessor.parsed_outcome(path, host)
                        self.assertEqual(raw, {'value': True})
                        self.assertIsNone(request)
                        self.assertEqual(len(references), 2)
                    else:
                        with self.assertRaisesRegex(AssertionError, 'capture bytes differ|process is not successful'):
                            assessor.parsed_outcome(path, host)


if __name__ == '__main__':
    unittest.main(verbosity=2)
