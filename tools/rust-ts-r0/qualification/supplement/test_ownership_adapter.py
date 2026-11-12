"""Pure synthetic DTO tests; these are not candidate observations."""
import copy
import json
import unittest
import ownership_adapter as o


class OwnershipTests(unittest.TestCase):
    def fixture(self):
        graph = {'nodes': [
            {'id': 'm', 'kind': 'module', 'name': 'main.ts', 'filePath': 'main.ts'},
            {'id': 'a', 'kind': 'function', 'name': 'main', 'filePath': 'main.ts'},
            {'id': 'b', 'kind': 'function', 'name': 'helper', 'filePath': 'main.ts'}],
            'edges': [{'kind': 'calls', 'from': 'a', 'to': 'b',
                       'evidence': [{'filePath': 'main.ts', 'startLine': 1}]}]}
        request = {'id': 'nonce:epoch:1', 'cwd': '/case', 'files': {'/case/main.ts': 'synthetic'},
                   'roots': ['/case/main.ts'], 'case_sensitive': True}
        plan = {'request': request, 'source_capture_stream_sha256': o.digest('capture'),
                'operations': [{'sequence': 1, 'kind': 'inspect', 'subject': 'main.ts',
                    'phase': 'afterAnalysis', 'snapshot_id': o.digest([['/case/main.ts', 'synthetic']]),
                    'input_graph': graph}], 'readset': request['files']}
        phase = lambda reasons: {'executed': True, 'unsupported': [], 'reasons': reasons}
        native = {'request': request['id'], 'request_id': o.digest(request),
            'complete': True, 'global_admission_inferred': False,
            'producer_artifact_id': o.digest('producer'), 'input_manifest_id': o.digest('inputs'),
            'assembly': graph, 'capture_probes': [{'operation': 'read_file', 'path': '/case/main.ts',
                'found': True, 'content_id': o.digest_bytes(b'synthetic')}],
            'subjects': [{'path': 'main.ts', 'opaqueCallbackOwnership': {
                'executed': True, 'unsupported': [], 'globalAdmissionInferred': False,
                'observationScope': 'native_module_configuration_graph_ownership',
                'graphBeforeEdgeRemoval': copy.deepcopy(graph),
                'graphAfterEdgeRemoval': copy.deepcopy(dict(graph, edges=[])),
                'graphBeforeEdgeRemovalId': o.digest(graph),
                'graphAfterEdgeRemovalId': o.digest(dict(graph, edges=[])),
                'beforeAnalysis': phase(['opaque']), 'afterAnalysis': phase([]),
                'afterGraphEdgesRemoved': phase(['opaque'])}}]}
        binding = {'request_descriptor_id': native['request_id'],
                   'producer_artifact_id': native['producer_artifact_id'],
                   'input_manifest_id': native['input_manifest_id'],
                   'sdk_input_id': o.digest('sdk'),
                   'capture_stream_sha256': plan['source_capture_stream_sha256']}
        return plan, native, binding

    def outcome(self, native):
        text = json.dumps(native)
        return {'kind': 'success', 'exit_code': 0, 'stdout': text, 'stderr': '',
            'stdout_bytes': len(text.encode()), 'stdout_hash': o.digest_bytes(text.encode()),
            'stderr_bytes': 0, 'stderr_hash': o.digest_bytes(b'')}

    def test_projects_actual_phase_and_rejects_missing_binding(self):
        plan, native, binding = self.fixture()
        self.assertEqual(o.project_ownership(plan, native)['1']['projection'], [])
        self.assertEqual(o.compare_ownership(plan, self.outcome(native), {}, {'1': []})['status'], 'UNKNOWN')
        self.assertEqual(o.compare_ownership(plan, self.outcome(native), binding, {'1': []})['status'], 'MATCH')

    def test_foreign_aligned_text_and_changed_map_rejected(self):
        plan, native, binding = self.fixture()
        native['request_id'] = o.digest('foreign equal-byte capture')
        self.assertEqual(o.compare_ownership(plan, self.outcome(native), binding, {'1': []})['status'], 'UNKNOWN')
        plan, native, binding = self.fixture()
        plan['request']['files']['/case/main.ts'] = 'changed'
        self.assertEqual(o.compare_ownership(plan, self.outcome(native), binding, {'1': []})['status'], 'UNKNOWN')

    def test_edge_removed_or_call_line_changed_cannot_satisfy_registration(self):
        plan, native, _ = self.fixture()
        for change in ('remove', 'line'):
            value = copy.deepcopy(native)
            if change == 'remove':
                value['assembly']['edges'] = []
            else:
                value['assembly']['edges'][0]['evidence'][0]['startLine'] = 2
            component = value['subjects'][0]['opaqueCallbackOwnership']
            component['graphBeforeEdgeRemoval'] = copy.deepcopy(value['assembly'])
            component['graphAfterEdgeRemoval'] = copy.deepcopy(dict(value['assembly'], edges=[]))
            component['graphBeforeEdgeRemovalId'] = o.digest(value['assembly'])
            component['graphAfterEdgeRemovalId'] = o.digest(dict(value['assembly'], edges=[]))
            with self.assertRaisesRegex(o.Gap, 'RETAINED_GRAPH_NOT_NATIVE_PHASE'):
                o.project_ownership(plan, value)

    def test_empty_graph_selects_removal_phase_and_registration_is_effectful(self):
        plan, native, _ = self.fixture()
        plan['operations'][0].update(kind='register', phase='afterGraphEdgesRemoved',
            input_graph=dict(native['assembly'], edges=[]))
        value = o.project_ownership(plan, native)['1']
        self.assertEqual(value['projection'], {'$undefined': True})
        self.assertEqual(value['effect']['reasons'], ['opaque'])
        native['subjects'][0]['opaqueCallbackOwnership']['afterGraphEdgesRemoved']['executed'] = False
        with self.assertRaises(o.Gap):
            o.project_ownership(plan, native)

    def test_duplicate_subject_and_wrong_read_content_rejected(self):
        plan, native, _ = self.fixture()
        native['subjects'].append(copy.deepcopy(native['subjects'][0]))
        with self.assertRaises(o.Gap):
            o.project_ownership(plan, native)
        plan, native, _ = self.fixture()
        native['capture_probes'][0]['content_id'] = o.digest('foreign')
        with self.assertRaises(o.Gap):
            o.project_ownership(plan, native)

    def test_equal_byte_handles_have_distinct_runtime_requests(self):
        first = o.runtime_request_id('runtime-nonce', 0)
        second = o.runtime_request_id('runtime-nonce', 1)
        self.assertNotEqual(first, second)
        with self.assertRaises(o.Gap):
            o.runtime_request_id('', 0)

    def test_registration_undefined_does_not_ignore_effect_execution(self):
        plan, native, binding = self.fixture()
        plan['operations'][0]['kind'] = 'register'
        expected = {'1': {'$undefined': True}}
        native['subjects'][0]['opaqueCallbackOwnership']['afterAnalysis']['unsupported'] = ['missing']
        self.assertEqual(o.compare_ownership(plan, self.outcome(native), binding, expected)['status'], 'UNKNOWN')

    def test_missing_graph_id_read_or_cropped_capture_rejected(self):
        for variant in ('graph-id', 'read', 'capture'):
            plan, native, binding = self.fixture()
            if variant == 'graph-id':
                del native['subjects'][0]['opaqueCallbackOwnership']['graphBeforeEdgeRemovalId']
            if variant == 'read':
                native['capture_probes'] = []
            outcome = self.outcome(native)
            if variant == 'capture':
                outcome['stdout_bytes'] += 1
            self.assertEqual(o.compare_ownership(plan, outcome, binding, {'1': []})['status'], 'UNKNOWN')

    def test_projection_uses_native_reasons_and_actual_scope_metadata(self):
        plan, native, binding = self.fixture()
        native['subjects'][0]['opaqueCallbackOwnership']['afterAnalysis']['reasons'] = ['actual unexpected reason']
        self.assertEqual(o.compare_ownership(plan, self.outcome(native), binding, {'1': []})['status'], 'MISMATCH')
        native['assembly']['nodes'][1]['metadata'] = {'scope': 'different'}
        component = native['subjects'][0]['opaqueCallbackOwnership']
        component['graphBeforeEdgeRemoval'] = copy.deepcopy(native['assembly'])
        component['graphAfterEdgeRemoval'] = copy.deepcopy(dict(native['assembly'], edges=[]))
        component['graphBeforeEdgeRemovalId'] = o.digest(native['assembly'])
        component['graphAfterEdgeRemovalId'] = o.digest(dict(native['assembly'], edges=[]))
        # The fixture input_graph aliases the synthetic assembly; detach its old view.
        plan['operations'][0]['input_graph'] = copy.deepcopy(native['assembly'])
        plan['operations'][0]['input_graph']['nodes'][1].pop('metadata')
        with self.assertRaisesRegex(o.Gap, 'RETAINED_GRAPH_NOT_NATIVE_PHASE'):
            o.project_ownership(plan, native)


    def test_phase_graph_payload_is_distinct_from_later_assembly_annotations(self):
        plan, native, _ = self.fixture()
        native['assembly']['nodes'][0]['metadata'] = {'staticExports': 'later annotation'}
        self.assertEqual(o.project_ownership(plan, native)['1']['projection'], [])
        for change in ('hash', 'swapped', 'graph'):
            plan, native, _ = self.fixture()
            component = native['subjects'][0]['opaqueCallbackOwnership']
            if change == 'hash':
                component['graphBeforeEdgeRemovalId'] = o.digest('foreign')
            elif change == 'swapped':
                component['graphBeforeEdgeRemoval'], component['graphAfterEdgeRemoval'] = component['graphAfterEdgeRemoval'], component['graphBeforeEdgeRemoval']
            else:
                component['graphBeforeEdgeRemoval']['nodes'][0]['name'] = 'foreign'
            with self.subTest(change=change), self.assertRaises(o.Gap):
                o.project_ownership(plan, native)


if __name__ == '__main__':
    unittest.main()
