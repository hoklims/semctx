"""Synthetic, unqualified negatives for the supplementary token reader; no queries."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('windows_token_fields', Path(__file__).with_name('windows_token_fields.py'))


class PathContract(unittest.TestCase):
    def test_reader_exists(self):
        self.assertTrue(Path(SPEC.origin).is_file(), 'supplementary reader is absent')

    def test_separator_only_exact_path(self):
        module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(module)
        expected = r'C:\owned\raw\supplement-evidence\token-guards\request.json'
        self.assertTrue(module.same_request_path(expected.replace('\\', '/'), expected))
        for wrong in [expected.replace('owned', 'other'), expected.replace('request.json', 'wrong.json'),
                      expected.lower(), expected + '/extra', expected.replace('raw', 'raw/../raw')]:
            with self.subTest(wrong=wrong):
                self.assertFalse(module.same_request_path(wrong, expected))


class SyntheticTokenContract(unittest.TestCase):
    """Public expected fields with fabricated contexts; zero qualification evidence."""
    @classmethod
    def setUpClass(cls):
        import importlib
        import sys
        import tempfile
        cls.module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(cls.module)
        cls.repo = Path(__file__).resolve().parents[3]
        cls.dependencies = tempfile.TemporaryDirectory()
        cache = Path(cls.dependencies.name)
        for name in ('assess_final', 'final_join', 'raw_compare', 'qualified_carriers',
                     'remaining_carriers', 'physical_system_carrier', 'token_inputs'):
            (cache / (name + '.py')).write_bytes(cls.module.git_source(cls.repo, cls.module.PACKAGE + name + '.py'))
        sys.path.insert(0, str(cache))
        cls.a = importlib.import_module('assess_final')
        cls.carriers = importlib.import_module('remaining_carriers')
        cls.inputs = importlib.import_module('token_inputs')
        cls.plan = cls.inputs.prepare(cls.repo / 'docs/research/rust-ts-r0/cases/supplement-token-guards-20261021')
        cls.addClassCleanup(cls.dependencies.cleanup)

    def setUp(self):
        import copy
        import json
        import tempfile
        import types
        self.copy = copy.deepcopy
        self.json = json
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / 'evidence/token-guards'
        self.base.mkdir(parents=True)
        self.path = r'C:\owned\windows-raw\campaign\supplement-evidence\token-guards\request.json'
        self.api = types.SimpleNamespace(REPO=self.repo, expected_request_path=self.path,
            read=lambda p: json.loads(Path(p).read_bytes()),
            pin=lambda p: {'path': str(p), 'sha256': self.module.sha(Path(p).read_bytes())},
            verify_request_template=self.a.verify_request_template)
        self.module.configure(self.api, self.carriers)
        self.q = self.module.q
        plan = self.copy(self.plan)
        plan.update(execution_enabled=True, candidate_execution_authorized=True)
        request = self.copy(plan['request_template'])
        request.update(cwd='C:/owned/workspace', case_sensitive=False)
        request['files'] = {request['cwd'] + '/' + k: v for k, v in request['files'].items()}
        request['roots'] = [request['cwd'] + '/' + k for k in request['roots']]
        sdk = {'version': '5.9.3', 'archive_sha256': 'synthetic-sdk', 'files': {'/sdk/lib/lib.d.ts': 'synthetic lib'}}
        self.host = {'root': self.root, 'source_head': self.module.SOURCE, 'sdk': sdk, 'token_family': plan,
                     'fixture': {'artifact_sha256': 'synthetic-artifact', 'artifact_path': r'C:\owned\probe.exe',
                                 'sdk_path': r'C:\owned\sdk.json', 'token_execution_enabled': True}}
        before = {'executed': True, 'unsupported': [], 'reasons': ['SOURCE_OPAQUE_CALLBACK_UNSUPPORTED']}
        after = {'executed': True, 'unsupported': [], 'reasons': []}
        graph = {'nodes': [{'synthetic': True}], 'edges': [{'synthetic': True}]}
        removed = dict(graph, edges=[])
        own = {'executed': True, 'unsupported': [], 'observationScope': 'native_module_configuration_graph_ownership',
               'globalAdmissionInferred': False, 'graphBeforeEdgeRemoval': graph, 'graphAfterEdgeRemoval': removed,
               'graphBeforeEdgeRemovalId': self.q.digest(graph), 'graphAfterEdgeRemovalId': self.q.digest(removed),
               'beforeAnalysis': before, 'afterAnalysis': after, 'afterGraphEdgesRemoved': before}
        probes = [{'operation': 'read_file', 'found': True, 'path': p,
                   'content_id': 'sha256:' + self.module.sha(text.encode())}
                  for p, text in {**request['files'], **sdk['files']}.items()]
        raw = {'producer_artifact_id': 'sha256:synthetic-artifact', 'request': request['id'],
               'request_id': self.q.digest(request), 'input_manifest_id': self.q.digest(self.q.logical_input(request, sdk)),
               'complete': True, 'global_admission_inferred': False, 'capture_probes': probes,
               'subjects': [{'opaqueCallbackOwnership': own}]}
        stdout = json.dumps(raw)
        outcome = {'stdout': stdout, 'stderr': '', 'stdout_bytes': len(stdout.encode()), 'stderr_bytes': 0,
                   'stdout_hash': self.module.sha(stdout.encode()), 'stderr_hash': self.module.sha(b''),
                   'kind': 'success', 'exit_code': 0}
        actual = self.copy(plan['expected'])
        actual.update(kind='native-bound-application-token-controls-v1',
                      counts={'issuance': 13, 'revalidation': 7, 'mapIdentity': 1}, global_admission_inferred=False)
        for row in actual['revalidation']:
            registered = not row['refusal']
            row.update(registered=registered, actual_native_phase='afterAnalysis' if registered else 'beforeAnalysis',
                       configuration_observation=after if registered else before)
        actual['provenance'] = {'raw_facts_id': self.q.digest(raw), 'native_graph_id': self.q.digest(graph),
            'request_id': self.q.digest(request), 'capture_root': request['cwd'], 'input_manifest_id': raw['input_manifest_id'],
            'process_stdout_sha256': outcome['stdout_hash'],
            'controlled_seal_over_actual_native_observation_not_index_store_attestation': True,
            'native_binding': {'request_id': self.q.digest(request), 'input_manifest_id': raw['input_manifest_id'],
                               'artifact_sha256': 'synthetic-artifact'},
            'native_read_join': {'state': 'JOINED_REPORTED_SUCCESSFUL_READS_ONLY',
                'read_paths': sorted(p['path'] for p in probes), 'supplied_sdk_files': 1,
                'all_supplied_sdk_consumed_claimed': False}}
        self.documents = {'request.json': request, 'process-outcome.json': outcome,
                          'process-invocation.json': {'native_queries': 1, 'cwd': request['cwd'],
                           'argv': [self.host['fixture']['artifact_path'], self.path, self.host['fixture']['sdk_path']]},
                          'actual-token-observations.json': actual}
        self.sync_report()

    def sync_report(self):
        plan = self.host['token_family']
        report = {'actual': self.documents['actual-token-observations.json'], 'expected': plan['expected'],
                  'native_queries': 1, 'counts': plan['counts'], 'baseline_actual_program_records': 21,
                  'qualified': False, **{k: plan[k] for k in ('package_pin_sha256', 'manifest_sha256', 'expected_sha256')}}
        self.documents['token-report.json'] = report
        for name, value in self.documents.items():
            (self.base / name).write_text(self.json.dumps(value))
        (self.root / 'evidence/token-results.json').write_text(self.json.dumps(report))

    def run_reader(self):
        return self.module.windows_tokens(self.host, {'obligation_index': 232, 'property_index': 1})

    def test_complete_windows_separator_context_and_read_only(self):
        before = {p: p.read_bytes() for p in self.root.rglob('*.json')}
        self.assertEqual(self.run_reader()['state'], 'RELEVANT_PASS')
        argv = self.documents['process-invocation.json']['argv']
        argv[1] = argv[1].replace('\\', '/')
        self.sync_report()
        self.assertEqual(self.run_reader()['state'], 'RELEVANT_PASS')
        after = {p: p.read_bytes() for p in self.root.rglob('*.json')}
        self.run_reader()
        self.assertEqual(after, {p: p.read_bytes() for p in self.root.rglob('*.json')})
        self.assertNotEqual(before[self.base / 'process-invocation.json'], after[self.base / 'process-invocation.json'])

    def test_frozen_suffix_gap_is_preserved(self):
        self.carriers.configure(self.api)
        with self.assertRaisesRegex(ValueError, 'actual invocation context differs'):
            self.carriers.tokens(self.host, {})
        self.assertEqual(self.run_reader()['state'], 'RELEVANT_PASS')

    def test_all_21_control_mutations_detected(self):
        original = self.copy(self.documents)
        cases = [('issuance', i, 'issued') for i in range(13)] + [('revalidation', i, 'refusal') for i in range(7)]
        cases += [('mapIdentity', None, 'issuedTokenSameMapRefusal')]
        for group, index, field in cases:
            with self.subTest(group=group, index=index):
                self.documents = self.copy(original)
                row = self.documents['actual-token-observations.json'][group]
                row = row if index is None else row[index]
                row[field] = not row[field]
                self.sync_report()
                try:
                    self.assertEqual(self.run_reader()['state'], 'NONPASS')
                except ValueError as error:
                    self.assertIn('token revalidation', str(error))

    def test_invocation_negatives(self):
        original = self.copy(self.documents)
        for mutation in ('wrong-directory', 'wrong-file', 'artifact', 'sdk', 'extra-argument'):
            with self.subTest(mutation=mutation):
                self.documents = self.copy(original)
                argv = self.documents['process-invocation.json']['argv']
                if mutation == 'wrong-directory': argv[1] = argv[1].replace('owned', 'other')
                if mutation == 'wrong-file': argv[1] = argv[1].replace('request.json', 'other.json')
                if mutation == 'artifact': argv[0] += '.other'
                if mutation == 'sdk': argv[2] += '.other'
                if mutation == 'extra-argument': argv.append('extra')
                self.sync_report()
                with self.assertRaisesRegex(ValueError, 'invocation context differs'):
                    self.run_reader()

    def test_absent_request_plan_graph_reads_and_phase_refused(self):
        original = self.copy(self.documents)
        for mutation in ('request', 'altered-request', 'plan', 'missing-plan', 'sdk-bytes', 'graph', 'reads', 'phase'):
            with self.subTest(mutation=mutation):
                self.documents = self.copy(original)
                self.host['token_family'] = self.copy(self.plan)
                self.host['token_family'].update(execution_enabled=True, candidate_execution_authorized=True)
                if mutation == 'plan': self.host['token_family']['baseline_actual_program_records'] = 20
                if mutation == 'altered-request': self.documents['request.json']['files']['C:/owned/workspace/main.ts'] += '\n// mutation'
                if mutation == 'sdk-bytes': self.host['sdk']['version'] = 'different'
                else: self.host['sdk']['version'] = '5.9.3'
                if mutation in ('graph', 'reads', 'phase'):
                    outcome = self.documents['process-outcome.json']
                    raw = self.json.loads(outcome['stdout'])
                    if mutation == 'graph': raw['subjects'][0]['opaqueCallbackOwnership']['graphBeforeEdgeRemoval']['edges'] = []
                    if mutation == 'reads': raw['capture_probes'] = []
                    if mutation == 'phase': del raw['subjects'][0]['opaqueCallbackOwnership']['beforeAnalysis']
                    outcome['stdout'] = self.json.dumps(raw)
                    outcome['stdout_bytes'] = len(outcome['stdout'].encode())
                    outcome['stdout_hash'] = self.module.sha(outcome['stdout'].encode())
                self.sync_report()
                if mutation == 'request': (self.base / 'request.json').unlink()
                if mutation == 'missing-plan': self.host['token_family'] = None
                with self.assertRaises((ValueError, AssertionError, KeyError, OSError)):
                    self.run_reader()


class AssessmentJoinContract(unittest.TestCase):
    """Public frozen C4 metadata includes legitimate zero-based coordinates."""
    def setUp(self):
        import copy
        import gzip
        import json
        self.copy = copy.deepcopy
        self.module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(self.module)
        package = Path(__file__).parent / 'property_assessor/scope-map.json.gz'
        self.baseline = json.loads(gzip.decompress(package.read_bytes()))['baseline_rows']
        self.c4 = {'rows': self.copy(self.baseline)}

    def test_faithful_395_properties_51_supports_including_zero(self):
        properties = self.module.assessment_rows(self.c4, self.baseline)
        self.assertEqual(len(properties), 395)
        self.assertEqual(properties[0]['coordinate'], {'obligation_index': 0, 'property_index': 0})

    def test_exact_frozen_row_scope_required(self):
        original = self.copy(self.c4)
        for mutation in ('boolean', 'string', 'duplicate', 'missing', 'support-spoof', 'unknown-kind', 'foreign-support'):
            with self.subTest(mutation=mutation):
                self.c4 = self.copy(original)
                row = self.c4['rows'][0]
                if mutation == 'boolean': row['coordinate']['property_index'] = False
                if mutation == 'string': row['coordinate']['obligation_index'] = '0'
                if mutation == 'duplicate': self.c4['rows'][3] = self.copy(row)
                if mutation == 'missing': row['coordinate']['obligation_index'] = 999
                if mutation == 'support-spoof': row['kind'] = 'support'
                if mutation == 'unknown-kind': row['kind'] = 'foreign'
                if mutation == 'foreign-support': self.c4['rows'][-1]['support_id'] = 'foreign'
                with self.assertRaisesRegex(ValueError, 'C4 '):
                    self.module.assessment_rows(self.c4, self.baseline)


if __name__ == '__main__':
    unittest.main()
