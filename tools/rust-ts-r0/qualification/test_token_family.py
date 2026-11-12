"""Authority and input-preparation controls; no compiler or baseline query."""
import copy
import os
from pathlib import Path
import shutil
import tempfile
import unittest

import prepare_token_family as token
from native_compiler_identity import record_native_compiler_source
import run_windows_milestone as windows


def repository():
    configured = os.environ.get('SEMCTX_T00_TEST_REPO')
    candidates = [Path(configured)] if configured else [*Path(__file__).resolve().parents, Path.cwd(), *Path.cwd().parents]
    return next(path for path in candidates if (path/'docs/research/rust-ts-r0/cases/supplement-token-guards-20261021/package-pin.json').is_file())


class TokenFamilyAuthorityTests(unittest.TestCase):
    def package(self):
        return repository()/'docs/research/rust-ts-r0/cases/supplement-token-guards-20261021'

    def test_preparation_retains_exact_frozen_inputs_and_does_not_authorize_queries(self):
        result = token.prepare(self.package())
        self.assertFalse(result['execution_enabled'])
        self.assertFalse(result['candidate_execution_authorized'])
        self.assertEqual(result['native_queries'], 0)
        self.assertEqual(result['planned_native_queries'], 1)
        self.assertEqual(result['baseline_actual_program_records'], 21)
        self.assertEqual(result['baseline_program_records_joined'], 21)
        self.assertTrue(result['baseline_retained_map_bytes_joined'])
        self.assertEqual(result['baseline_program_options'], token.BASELINE_OPTIONS)
        self.assertEqual(result['counts'], {'issuance': 13, 'revalidation': 7, 'map_identity': 1})
        self.assertEqual(set(result['request_template']['files']), {'main.ts', 'package.json'})
        self.assertTrue(result['request_template']['retained'])
        self.assertTrue(result['request_template']['qualified'])
        self.assertEqual(result['request_template']['roots'], ['main.ts'])
        self.assertEqual(result['request_template'].get('sdk_directory'), '/sdk/lib')
        for name, text in result['request_template']['files'].items():
            self.assertEqual(token.digest(text.encode()), result['source_pins'][name]['sha256'])
        self.assertEqual(result['expected_sha256'], token.EXPECTED_SHA)

    def test_changed_package_or_expected_bytes_are_refused(self):
        for name in ['package-pin.json', 'expected.json', 'lot.tar.gz.b64']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                target = Path(directory)/'package'
                shutil.copytree(self.package(), target)
                with (target/name).open('ab') as stream:
                    stream.write(b'\n')
                with self.assertRaisesRegex(ValueError, 'token package'):
                    token.prepare(target)

    def test_a_build_time_version_override_is_refused_before_source_access(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'override must be absent'):
                record_native_compiler_source(Path(directory), {'GOPORT_BUILD_VERSION': 'foreign'})
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_windows_counting_requires_actual_complete_family_not_only_pass_flag(self):
        self.assertEqual(windows.token_nonpass(None), 1)
        self.assertEqual(windows.token_nonpass({'pass': True}), 1)
        healthy = {'state': 'TOKEN_GUARD_OBSERVATIONS_MATCH', 'pass': True,
            'counts': {'issuance': 13, 'revalidation': 7, 'map_identity': 1},
            'native_queries': 1, 'baseline_actual_program_records': 21,
            'actual': {'counts': {'issuance': 13, 'revalidation': 7, 'mapIdentity': 1},
                'issuance': [{'name': str(i)} for i in range(13)],
                'revalidation': [{'name': str(i)} for i in range(7)],
                'mapIdentity': {'identical_map_content': True, 'same_map_identity': False}}}
        self.assertEqual(windows.token_nonpass(healthy), 0)
        for field, value in [('native_queries', 21), ('baseline_actual_program_records', 1), ('counts', {})]:
            changed = copy.deepcopy(healthy)
            changed[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                windows.token_nonpass(changed)
        changed = copy.deepcopy(healthy)
        changed['actual']['issuance'].pop()
        with self.assertRaises(ValueError):
            windows.token_nonpass(changed)


if __name__ == '__main__':
    unittest.main()
