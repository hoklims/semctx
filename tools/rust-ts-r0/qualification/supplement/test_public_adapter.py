"""Pure synthetic ABI tests; no native producer invocation or candidate observation."""
import copy
import unittest
import public_adapter as a


class AdapterTests(unittest.TestCase):
    def fixture(self):
        raw = b'\xff\xfeA\x00\r\x00\n\x00'
        return {'root': 'C:/f', 'path': 'src/a.ts', 'bytesBase64': a.base64.b64encode(raw).decode(),
                'sha256': a.digest(raw), 'size': len(raw)}

    def test_raw_bytes_are_not_decoded_or_normalized(self):
        item = self.fixture()
        plan, relocate = a.fixture_plan([item])
        self.assertEqual(plan['entries'][0]['bytesBase64'], item['bytesBase64'])
        self.assertEqual(relocate('C:\\f\\src\\a.ts'), '$CASE/fixture-000/src/a.ts')
        self.assertEqual(relocate('C:/foreign.ts'), 'C:/foreign.ts')

    def test_tamper_rejected(self):
        item = self.fixture()
        item['size'] += 1
        with self.assertRaisesRegex(ValueError, 'byte mismatch'):
            a.validate_closure([item])

    def test_unsafe_and_duplicate_paths_rejected(self):
        for path in ['../escape', '/abs', 'C:/abs', 'a\\b', 'a//b', './x']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                a.validate_closure([dict(self.fixture(), path=path)])
        with self.assertRaises(ValueError):
            a.validate_closure([self.fixture(), self.fixture()])

    def test_symlink_relocation_requires_known_closure(self):
        plan, _ = a.fixture_plan([self.fixture(), {'root': 'C:/f', 'path': 'alias', 'symlink': 'C:\\f\\src'}])
        self.assertEqual(plan['entries'][1]['relocated_target'], '$CASE/fixture-000/src')
        self.assertEqual(plan['gaps'], [])
        plan, _ = a.fixture_plan([{'root': 'C:/f', 'path': 'alias', 'symlink': 'C:/outside'}])
        self.assertIn('UNBOUND_SYMLINK_TARGET:alias', plan['gaps'])

    def test_exact_options_only(self):
        self.assertEqual(a.options_to_native(a.OPTIONS_TS)['value'], a.OPTIONS_NATIVE)
        for changed in [dict(a.OPTIONS_TS, strict=True), dict(a.OPTIONS_TS, target=99),
                        dict(a.OPTIONS_TS, extra=True), dict(a.OPTIONS_TS, allowJs=1)]:
            self.assertEqual(a.options_to_native(changed)['status'], 'UNKNOWN')

    def test_map_identity_is_not_flattened(self):
        one = {'$mapIdentity': 1, '$map': [['a', 'x']]}
        handles = a.map_handles([one, one])
        self.assertEqual(len(handles), 1)
        with self.assertRaises(ValueError):
            a.map_handles([one, {'$mapIdentity': 1, '$map': [['a', 'changed']]}])

    def evidence(self):
        dto = {'operation': 'relative_import_specifiers', 'source': 'import "./a"', 'filename': 'a.ts'}
        binding = {key: 'sha256:' + 'a' * 64 for key in ['producer_artifact_sha256', 'sdk_descriptor_digest',
            'capture_stream_sha256', 'input_manifest_digest']}
        binding['request_digest'] = 'sha256:' + a.digest(a.canonical(dto))
        native = {'operation': 'relative_import_specifiers', 'specifiers': ['./a'], 'executed': True,
            'unsupported': [], 'request_descriptor_id': binding['request_digest'],
            'producer_artifact_id': binding['producer_artifact_sha256'], 'runtime_dependency_claim': False}
        raw = a.canonical(native)
        actual = {'binding': binding, 'global_admission_inferred': False, 'complete': True,
            'unsupported': [], 'capture_probes': [], 'capture': {
                'stdout': {'sha256': a.digest(raw), 'bytes': len(raw)},
                'stderr': {'sha256': a.digest(b''), 'bytes': 0}}}
        return binding, raw, actual, {'native_dto': dto}

    def test_comparator_uses_only_bound_raw_native_projection(self):
        binding, raw, actual, recipe = self.evidence()
        self.assertEqual(a.compare({'output': ['./a']}, actual, binding, raw, b'', recipe)['status'], 'MATCH')
        self.assertEqual(a.compare({'output': ['./b']}, actual, binding, raw, b'', recipe)['status'], 'MISMATCH')
        actual['public_projection'] = {'output': ['./b']}
        self.assertEqual(a.compare({'output': ['./b']}, actual, binding, raw, b'', recipe)['status'], 'MISMATCH')

    def test_comparator_refuses_missing_foreign_and_truncated_evidence(self):
        binding, raw, actual, recipe = self.evidence()
        for key, value in [('complete', False), ('global_admission_inferred', True), ('unsupported', ['x'])]:
            changed = copy.deepcopy(actual)
            changed[key] = value
            self.assertEqual(a.compare({}, changed, binding, raw, b'', recipe)['status'], 'UNKNOWN')
        self.assertEqual(a.compare({}, actual, binding, raw[:-1], b'', recipe)['status'], 'UNKNOWN')
        self.assertEqual(a.compare({}, actual, binding, raw, b'foreign', recipe)['status'], 'UNKNOWN')
        self.assertEqual(a.compare({}, actual, binding, raw, b'', None)['status'], 'UNKNOWN')


if __name__ == '__main__':
    unittest.main()
