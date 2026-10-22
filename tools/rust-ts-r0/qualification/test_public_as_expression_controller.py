"""Pure DEV controller guards; no native query, build or frozen-case evaluation."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import native_build_identity
import public_as_expression_witness as controller


class BeforeNativeAcquisition(Exception):
    """Deliberate test boundary, never a process or infrastructure failure."""


def caught(call):
    try:
        call()
    except Exception as error:
        return error
    return None


class PublicAsExpressionControllerTests(unittest.TestCase):
    def fixture(self, root):
        fixture = {'candidate_execution_authorized': True, 'optimized_frozen': True,
                   'platform': 'windows', 'source_head': 'a' * 40}
        for tag in ('artifact', 'helper', 'transport_fixture', 'qualification_observer',
                    'build_environment', 'sdk'):
            path = root / (tag + '.DEV')
            path.write_bytes(('synthetic controller guard bytes: ' + tag).encode())
            fixture[tag + '_path'] = str(path)
            fixture[tag + '_sha256'] = controller.sha(path)
        return fixture

    def preflight(self):
        # These fixtures test orchestration guards, not real build/capsule admission.
        return (patch.object(native_build_identity, 'validate_frozen_document'),
                patch.object(controller, 'bundle_pins', return_value={}),
                patch.object(controller, 'materialize_bundle', side_effect=BeforeNativeAcquisition()))

    def test_authority_refuses_before_preflight_or_acquisition(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = self.fixture(root)
            for field, value in [('authorized', False), ('authorized', 1),
                                 ('candidate_execution_authorized', False),
                                 ('optimized_frozen', False), ('platform', 'linux')]:
                with self.subTest(field=field, value=value):
                    selected = copy.deepcopy(fixture)
                    authorized = value if field == 'authorized' else True
                    if field != 'authorized':
                        selected[field] = value
                    validate_patch, pins_patch, materialize_patch = self.preflight()
                    with validate_patch as validate, pins_patch, materialize_patch as materialize:
                        error = caught(lambda selected=selected, authorized=authorized:
                                       controller.acquire(root, root, selected, {}, None,
                                                          lambda: None, authorized=authorized))
                        self.assertIsInstance(error, ValueError)
                        self.assertIn('additional Windows witness authorization absent', str(error))
                        validate.assert_not_called()
                        materialize.assert_not_called()
                    self.assertFalse((root / 'public-as-expression').exists())

    def test_one_shot_refuses_existing_directory_without_touching_claim(self):
        for marker_name in ('one-shot-claim.json', 'partial-output.DEV'):
            with self.subTest(previous_output=marker_name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                fixture = self.fixture(root)
                claimed = root / 'public-as-expression'
                claimed.mkdir()
                marker = claimed / marker_name
                marker.write_bytes(b'DEV previous output must remain byte-identical\n')
                before = marker.read_bytes()
                validate_patch, pins_patch, materialize_patch = self.preflight()
                with validate_patch as validate, pins_patch, materialize_patch as materialize:
                    error = caught(lambda root=root, fixture=fixture:
                                   controller.acquire(root, root, fixture, {}, None,
                                                      lambda: None, authorized=True))
                    self.assertIsInstance(error, ValueError)
                    self.assertIn('public witness acquisition already attempted', str(error))
                    validate.assert_called_once()
                    materialize.assert_not_called()
                self.assertEqual(marker.read_bytes(), before)
                self.assertEqual([path.name for path in claimed.iterdir()], [marker_name])

    def test_complete_streams_accept_healthy_and_reject_corruption_or_wrong_types(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stdout, stderr = b'{"DEV":true}', b''
            (root / 'stdout.raw').write_bytes(stdout)
            (root / 'stderr.raw').write_bytes(stderr)
            healthy = {'kind': 'success', 'exit_code': 0,
                       'stdout_bytes': len(stdout), 'stdout_hash': hashlib.sha256(stdout).hexdigest(),
                       'stderr_bytes': 0, 'stderr_hash': hashlib.sha256(stderr).hexdigest()}

            def read(value, cap=controller.CAP):
                (root / 'process-outcome.json').write_text(json.dumps(value), encoding='utf-8')
                with patch.object(controller, 'CAP', cap):
                    return controller.validate_outcome(root)

            self.assertEqual(read(healthy), {'DEV': True})
            for field, value, reason in [
                ('stdout_bytes', len(stdout) - 1, 'actual stream size/cap differs'),
                ('stdout_bytes', float(len(stdout)), 'actual stream size/cap differs'),
                ('stderr_bytes', False, 'actual stream size/cap differs'),
                ('stdout_hash', '0' * 64, 'actual stream hash differs'),
                ('stderr_hash', '0' * 64, 'actual stream hash differs'),
                ('exit_code', False, 'candidate outcome non-success; no retry'),
                ('exit_code', 0.0, 'candidate outcome non-success; no retry'),
                ('exit_code', 1, 'candidate outcome non-success; no retry'),
                ('kind', 'nonzero', 'candidate outcome non-success; no retry'),
            ]:
                with self.subTest(field=field, value=value):
                    error = caught(lambda field=field, value=value: read(dict(healthy, **{field: value})))
                    self.assertIsInstance(error, ValueError)
                    self.assertIn(reason, str(error))
            error = caught(lambda: read(healthy, cap=len(stdout) - 1))
            self.assertIsInstance(error, ValueError)
            self.assertIn('actual stream size/cap differs', str(error))


if __name__ == '__main__':
    unittest.main(verbosity=2)
