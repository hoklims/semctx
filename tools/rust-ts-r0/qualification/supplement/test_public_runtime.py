"""Synthetic DTO/projection tests, separate from the immutable baseline expectations."""
import unittest
from unittest.mock import patch
import json
import public_adapter as a
import public_runtime as r
from test_runtime_consumers import carried


class RuntimeTests(unittest.TestCase):
    def prepared(self, function, **extra):
        return {'baseline_function': function, 'surface': 'raw_cli',
            'repository_root': '/case/root', 'target_path': '/case/root/main.ts',
            'relocations': [('C:/fixture', '/case/root')],
            'path_normalization': {'roots': [{'raw': 'C:/fixture', 'token': '$FIXTURE/0'}]}, **extra}

    def test_discovery_projection_keeps_denominator_and_failure(self):
        native = {'executed': True, 'unsupported': [], 'candidates': [
            {'relPath': 'main.ts', 'selectionDecision': 'selected', 'analysisOutcome': 'failed', 'reason': 'ESCAPE', 'language': 'typescript'}], 'files': []}
        result = r.project_operation(self.prepared('discoverRepository', request={'config': {'version': 2}}), native)
        self.assertEqual(result['candidates'], [{'relPath': 'main.ts', 'selectionDecision': 'selected', 'analysisOutcome': 'failed', 'reason': 'ESCAPE'}])

    def test_native_bindings_projection_keeps_full_members(self):
        native = {'subjects': [{'path': 'main.ts', 'javascript': {'native': {'commonJsUnsupported': True, 'unmodeledMembers': ['module.x']}}}]}
        self.assertEqual(r.project_operation(self.prepared('inspectNativeModuleBindings'), native), native['subjects'][0]['javascript']['native'])

    def test_javascript_component_only(self):
        component = {'executed': True, 'unsupported': [], 'parseFailed': False, 'reasons': ['actual'], 'staticExports': [], 'staticModuleLinks': []}
        native = {'subjects': [{'path': 'main.ts', 'javascriptObservation': component, 'reasons': ['unrelated']}]}
        self.assertEqual(r.project_operation(self.prepared('inspectJavaScriptSource'), native)['reasons'], ['actual'])
        component['unsupported'] = ['missing']
        with self.assertRaises(r.Gap):
            r.project_operation(self.prepared('inspectJavaScriptSource'), native)

    def test_configuration_selects_actual_call_mode(self):
        native = {'subjects': [{'path': 'main.ts', 'moduleConfigurationObservations': {
            'ordinaryWithoutSnapshot': {'executed': True, 'unsupported': [], 'reasons': ['ordinary']},
            'retainedWithSource': {'executed': True, 'unsupported': [], 'reasons': ['retained']}}}]}
        self.assertEqual(r.project_operation(self.prepared('inspectModuleConfiguration', configuration_component='ordinaryWithoutSnapshot'), native), ['ordinary'])

    def test_raw_extraction_is_not_recomputed(self):
        facts = {'modules': ['main.ts'], 'calls': [{'calleeName': 'x'}], 'imports': [], 'symbols': []}
        self.assertEqual(r.project_operation(self.prepared('extractTypeScript'), {'raw_extraction': facts}), facts)

    def test_resolution_projects_bound_import_and_undefined(self):
        native = {'subjects': [{'path': 'main.ts'}], 'raw_extraction': {'imports': [
            {'fromRelPath': 'main.ts', 'moduleSpecifier': './dep', 'resolvedRelPath': 'dep.ts'}]}}
        prepared = self.prepared('resolveTypeScriptModule', specifier='./dep')
        self.assertEqual(r.project_operation(prepared, native), '$FIXTURE/0/dep.ts')
        del native['raw_extraction']['imports'][0]['resolvedRelPath']
        self.assertEqual(r.project_operation(prepared, native), {'$undefined': True})
        native['raw_extraction']['imports'] = []
        with self.assertRaises(r.Gap):
            r.project_operation(prepared, native)

    def test_configured_resolution_requires_actual_native_path(self):
        prepared = self.prepared('resolveTypeScriptModule', surface='configured_resolution_cli', request={})
        raw = {'resolved_file_name': '/case/root/a.mjs', 'producer_artifact_id': 'sha256:'+'a'*64}
        with self.assertRaisesRegex(r.Gap, 'ACTUAL_RUST_PUBLIC_CONSUMER_RECEIPT_REQUIRED'):
            r.project_operation(prepared, raw)
        native = carried(prepared, raw, '/case/root/a.mjs', 'configured-runtime-companion-v1')
        self.assertEqual(r.project_operation(prepared, native), '$FIXTURE/0/a.mjs')

    def test_parallelism_and_extraction_not_faked(self):
        native = {'extraction': {'modules': ['x.ts']}, 'parallelism': {'used': 1, 'mode': 'preflight-fallback'}}
        self.assertEqual(r.project_operation(self.prepared('extractTypeScriptParallel'), native), native)

    def test_partition_weights_require_actual_rust_chunks_without_python_repair(self):
        prepared = self.prepared('__partitionTypeScriptRootsForTesting', partition_count=2,
            physical_sizes={'/case/root/a.ts': 2, '/case/root/b.ts': 3, '/case/root/c.ts': 1}, request={})
        raw = {'producer_artifact_id': 'sha256:'+'a'*64, 'partitionObservation': {'executed': True, 'unsupported': [], 'dependencyComponents': [['a.ts'], ['b.ts'], ['c.ts']]}}
        with self.assertRaisesRegex(r.Gap, 'ACTUAL_RUST_PUBLIC_CONSUMER_RECEIPT_REQUIRED'):
            r.project_operation(prepared, raw)
        native = carried(prepared, raw, [['/case/root/a.ts', '/case/root/c.ts'], ['/case/root/b.ts']], 'partition-native-chunks-v1')
        self.assertEqual(r.project_operation(prepared, native), [['$FIXTURE/0/a.ts', '$FIXTURE/0/c.ts'], ['$FIXTURE/0/b.ts']])

    def test_component_failures_and_duplicate_subjects_fail_closed(self):
        with self.assertRaises(r.Gap):
            r.project_operation(self.prepared('extractTypeScript'), {'executed': False})
        with self.assertRaises(r.Gap):
            r.project_operation(self.prepared('inspectNativeModuleBindings'), {'subjects': [{'path': 'main.ts'}, {'path': 'main.ts'}]})

    def test_bound_comparator_reads_raw_not_supplied_projection(self):
        prepared = self.prepared('extractTypeScript', request={'id': 'synthetic'}, expected_ref={},
            source_capture_stream_sha256='sha256:' + 'c' * 64)
        binding = {k: 'sha256:' + 'a' * 64 for k in ['producer_artifact_id', 'sdk_input_id', 'input_manifest_id']}
        binding.update(request_descriptor_id='sha256:' + a.digest(r.native_canonical(prepared['request']).encode()),
                       capture_stream_sha256=prepared['source_capture_stream_sha256'])
        native = {'request_id': binding['request_descriptor_id'], 'producer_artifact_id': binding['producer_artifact_id'],
            'input_manifest_id': binding['input_manifest_id'], 'complete': True, 'capture_probes': [],
            'global_admission_inferred': False, 'raw_extraction': {'modules': ['actual.ts']}}
        raw = json.dumps(native)
        outcome = {'kind': 'success', 'exit_code': 0, 'stdout': raw, 'stderr': '',
            'stdout_bytes': len(raw.encode()), 'stdout_hash': a.digest(raw.encode()),
            'stderr_bytes': 0, 'stderr_hash': a.digest(b'')}
        with patch.object(r, 'resolve_ref', return_value={'modules': ['actual.ts']}):
            self.assertEqual(r.compare_native(prepared, outcome, binding)['status'], 'MATCH')
        with patch.object(r, 'resolve_ref', return_value={'modules': ['expected.ts']}):
            self.assertEqual(r.compare_native(prepared, outcome, binding)['status'], 'MISMATCH')
        outcome['stdout_bytes'] -= 1
        self.assertEqual(r.compare_native(prepared, outcome, binding)['status'], 'UNKNOWN')

    def test_native_identity_key_order_matches_numeric_and_utf16_contract(self):
        self.assertEqual(r.native_canonical({'10': 'ten', '2': 'two', 'a': True}), '{"2":"two","10":"ten","a":true}')
        with self.assertRaises(r.Gap):
            r.native_canonical({'float': 1.5})

    def test_graph_projection_requires_exact_js_collation_and_endpoint_binding(self):
        native = {'assembly': {'nodes': [{'id': 'm', 'kind': 'module', 'name': 'main.ts', 'filePath': 'main.ts'}], 'edges': []}}
        prepared = self.prepared('analyzeRepository')
        with self.assertRaisesRegex(r.Gap, 'LOCALE_COLLATION'):
            r.project_operation(prepared, native)
        result = r.project_operation(prepared, native, graph_projector=lambda assembly: {'nodes': [{'kind': 'module', 'name': 'main.ts', 'filePath': 'main.ts'}], 'edges': []})
        self.assertEqual(result['unresolvedReferences'], [])
        native['assembly']['edges'] = [{'kind': 'calls', 'from': 'm', 'to': 'missing'}]
        with self.assertRaisesRegex(r.Gap, 'UNRESOLVED_ENDPOINT'):
            r.project_operation(prepared, native, graph_projector=lambda assembly: {})


if __name__ == '__main__':
    unittest.main()
