"""Portable synthetic source/path tests; no native execution or qualification."""
import ast
import copy
import gzip
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest

import windows_public_fields as p

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]


class OwnedPathsContract(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.transport = Path(self.tmp.name).resolve()
        self.root = self.transport / 'view'
        self.folder = self.root / 'evidence/public/invocations/key/input'
        self.folder.mkdir(parents=True)
        self.file = self.folder / 'native-process.json'
        self.file.write_bytes(b'{"synthetic":true}')
        key = self.file.relative_to(self.transport).as_posix()
        self.native = 'C:/owned/windows-raw/campaign'
        self.context = {'manifest': {'hosts': {'windows': {'raw_root': str(self.root)}}},
                        'native_raw_root': self.native,
                        'documents': {'inventory': {'native_raw_root': self.native.replace('/', '\\')}},
                        'verified_files': {key: {'sha256': p.sha(self.file.read_bytes()), 'bytes': self.file.stat().st_size}}}
        self.paths = p.OwnedPaths(self.context)
        self.expected = self.native + '/supplement-evidence/public/invocations/key/input/native-process.json'

    def test_exact_inventory_file_posix_backslash_and_mixed(self):
        for captured in (self.expected, self.expected.replace('/', '\\'), self.expected.replace('/public/', '\\public/')):
            with self.subTest(captured=captured):
                self.assertEqual(self.paths.frame({'root': self.root}, self.folder, captured), self.file)
        self.assertEqual(self.paths.native_file(self.file), self.expected)

    def test_foreign_root_drive_case_parent_and_dot_are_refused(self):
        for captured in (self.expected.replace('owned', 'other'), self.expected.replace('C:', 'D:'),
                         self.expected.replace('C:', 'c:'), self.expected.replace('/key/', '/foreign/'),
                         self.expected.replace('/key/', '/KEY/'), self.expected.replace('/key/', '/key/../key/')):
            with self.subTest(captured=captured), self.assertRaises(ValueError):
                self.paths.frame({'root': self.root}, self.folder, captured)
        with self.assertRaises(ValueError):
            self.paths.frame({'root': self.root}, self.folder, self.expected.replace('native-process.json', 'missing.json'))

    def test_inventory_hash_and_basename_collision_refused(self):
        self.file.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'inventoried local file changed'):
            self.paths.frame({'root': self.root}, self.folder, self.expected)
        with self.assertRaises(ValueError):
            self.paths.frame({'root': self.root / 'other'}, self.folder, self.expected)

    def test_argv_only_request_position_can_normalize(self):
        expected = ['C:\\probe.exe', '--batch', 'C:/owned/request.json', 'C:\\sdk.json']
        actual = list(expected)
        actual[2] = actual[2].replace('/', '\\')
        self.assertTrue(self.paths.argv(actual, expected, 2))
        for mutation in ('artifact', 'mode', 'sdk', 'extra', 'request'):
            with self.subTest(mutation=mutation):
                changed = list(actual)
                if mutation == 'artifact': changed[0] = 'C:/probe.exe'
                if mutation == 'mode': changed[1] = '--other'
                if mutation == 'sdk': changed[3] = 'C:/sdk.json'
                if mutation == 'extra': changed.append('extra')
                if mutation == 'request': changed[2] = 'C:\\other\\request.json'
                self.assertFalse(self.paths.argv(changed, expected, 2))

    def test_original_evidence_mapping_and_suffix_contract(self):
        local = self.root / 'original-evidence/support-001/before/request.json'
        local.parent.mkdir(parents=True)
        local.write_bytes(b'{}')
        key = local.relative_to(self.transport).as_posix()
        self.paths.files[key] = {'sha256': p.sha(b'{}'), 'bytes': 2}
        self.assertEqual(self.paths.native_file(local), self.native + '/original-evidence/support-001/before/request.json')
        self.assertTrue(p.separators('D:\\another-prefix\\implementation-0').endswith('/implementation-0'))
        self.assertFalse(p.separators('D:\\another-prefix\\implementation-1').endswith('/implementation-0'))


class FrozenSourceContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources = {name: p.tokens.git_source(REPO, p.tokens.PACKAGE + name + '.py').decode()
                       for name in ('qualified_carriers', 'remaining_carriers', 'nonqualified_carriers')}
        cls.baseline = json.loads(gzip.decompress((HERE / 'windows-token-fields-test-protocol.json.gz').read_bytes()))['baseline_rows']

    def test_independent_normative_delta_table_pin(self):
        # Normative contract: exactly5 path-only variants,2 byte-identical
        # forwarding callers;9 literal substitutions authorized before outcomes.
        self.assertEqual(set(p.REPLACEMENTS), {
            ('qualified_carriers', 'load_public_lifecycle'),
            ('remaining_carriers', 'public_verify'),
            ('remaining_carriers', 'native_process_binding'),
            ('remaining_carriers', 'identity_support'),
            ('nonqualified_carriers', 'legacy_one'),
            ('remaining_carriers', 'public_base_binding'),
            ('nonqualified_carriers', 'legacy')})
        contract = [{'module': module, 'function': name, 'replacements': changes}
                    for (module, name), changes in sorted(p.REPLACEMENTS.items())]
        encoded = json.dumps(contract, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()
        self.assertEqual(p.sha(encoded), '18cba4d9adcde1ed21983a9cb747d21d5a63411add3b32515d6152910e691b72')
        self.assertEqual(sum(bool(changes) for changes in p.REPLACEMENTS.values()), 5)
        self.assertEqual(sum(len(changes) for changes in p.REPLACEMENTS.values()), 9)

    def test_all_seven_segments_restore_exact_sources_and_ast(self):
        for (module, name), changes in p.REPLACEMENTS.items():
            with self.subTest(module=module, name=name):
                changed, metadata = p.variant_source(self.sources[module], name, changes)
                restored = changed
                for before, after in reversed(changes):
                    restored = restored.replace(after, before)
                self.assertEqual(restored, p.segment(self.sources[module], name))
                self.assertEqual(ast.dump(ast.parse(restored)), ast.dump(ast.parse(p.segment(self.sources[module], name))))
                self.assertTrue(metadata['source_ast_exactly_restorable'])
                self.assertEqual(metadata['byte_identical_forwarder'], not changes)
                if changes:
                    with self.assertRaisesRegex(ValueError, 'anchor differs'):
                        p.variant_source(self.sources[module].replace(changes[0][0], 'unregistered', 1), name, changes)

    def test_fixed_ten_properties_three_supports_and_zero_types(self):
        rows = copy.deepcopy(self.baseline)
        p.tokens.assessment_rows({'rows': rows}, rows)
        self.assertEqual(len(p.selected(rows)), 13)
        self.assertIn((236, 0), p.COORDINATES)
        self.assertEqual(set(p.SUPPORTS), {'IDENTITY::I-relocation', 'IDENTITY::I-request-separation', 'IDENTITY::complete-baseline-specimen'})
        for mutation in ('duplicate', 'missing', 'foreign-support', 'boolean'):
            with self.subTest(mutation=mutation):
                changed = copy.deepcopy(rows)
                selected = next(r for r in changed if r.get('coordinate') == {'obligation_index': 0, 'property_index': 1})
                if mutation == 'duplicate': changed.append(copy.deepcopy(selected))
                if mutation == 'missing': changed.remove(selected)
                if mutation == 'foreign-support':
                    next(r for r in changed if r.get('support_id') == p.SUPPORTS[0])['support_id'] = 'foreign'
                if mutation == 'boolean': selected['coordinate']['property_index'] = True
                with self.assertRaises(ValueError):
                    p.tokens.assessment_rows({'rows': changed}, rows)

    def test_complete_assessor_reconfiguration_in_isolated_process(self):
        result = subprocess.run([sys.executable, '-B', str(Path(__file__).resolve()), '--configuration-child'],
                                capture_output=True, text=True, timeout=45)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('ACTUAL_FROZEN_RUN_COMPLETED_TWICE_WITH_CURRENT_API', result.stdout)


class PublicRegistrationContract(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name).resolve()
        self.file = self.repo / p.PUBLIC_FILE
        self.file.parent.mkdir(parents=True)
        self.current = Path(p.__file__).read_bytes()
        self.file.write_bytes(self.current)
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        self.head = self.commit('Exact synthetic public reader snapshot')
        self.bindings = {'public_reader_sha256': p.sha(self.current),
                         'public_coordinates': json.dumps([list(c) for c in p.COORDINATES], separators=(',', ':')),
                         'public_support_ids': json.dumps(list(p.SUPPORTS), separators=(',', ':'))}
        self.registration = {'readback_head': self.head, 'public_bindings': dict(self.bindings)}
        self.context = {'documents': {'registration': self.registration}}

    def commit(self, message):
        subprocess.run(['git', '-C', str(self.repo), 'add', p.PUBLIC_FILE], check=True)
        hooks = self.repo / 'empty-hooks'
        hooks.mkdir(exist_ok=True)
        subprocess.run(['git', '-C', str(self.repo), '-c', 'user.name=Synthetic',
                        '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false',
                        '-c', 'core.hooksPath=' + str(hooks), 'commit', '-qm', message], check=True)
        return subprocess.check_output(['git', '-C', str(self.repo), 'rev-parse', 'HEAD']).decode().strip()

    def test_exact_git_registration_and_scope(self):
        self.assertEqual(p.public_registration(self.context, self.repo), self.bindings)
        for field in self.bindings:
            with self.subTest(field=field):
                self.registration['public_bindings'] = dict(self.bindings, **{field: 'foreign'})
                with self.assertRaisesRegex(ValueError, 'registered public reader/scope differs'):
                    p.public_registration(self.context, self.repo)

    def test_identical_disk_but_foreign_git_blob_refused(self):
        self.file.write_bytes(self.current + b'\n# foreign synthetic snapshot\n')
        foreign = self.commit('Foreign synthetic source head')
        self.file.write_bytes(self.current)
        self.assertEqual(self.file.read_bytes(), Path(p.__file__).read_bytes())
        self.assertNotEqual(p.custody.git_bytes(self.repo, foreign, p.PUBLIC_FILE), self.current)
        self.registration['readback_head'] = foreign
        with self.assertRaisesRegex(ValueError, 'public reader differs from registered actual Git W code'):
            p.public_registration(self.context, self.repo)


class PublicAssessmentContract(unittest.TestCase):
    def setUp(self):
        baseline = json.loads(gzip.decompress((HERE / 'windows-token-fields-test-protocol.json.gz').read_bytes()))['baseline_rows']
        self.baseline = baseline
        rows = [{**{key: copy.deepcopy(row[key]) for key in ('kind', 'coordinate', 'support_id') if key in row},
                 'hosts': {'windows': {'state': 'GAP', 'comparisons': [{'state': 'GAP', 'gap': 'SYNTHETIC_NO_NATIVE_OBSERVATIONS'}]}}}
                for row in baseline]
        self.identity = {'source_head': p.tokens.SOURCE, 'references': {'synthetic': {'sha256': 'a' * 64}}}
        self.c4 = {'kind': 'DETERMINISTIC_CURRENT_FIELD_ASSESSMENT', 'candidate_head': p.tokens.SOURCE,
                   'evaluation_protocol_ref': {'sha256': p.tokens.PROTOCOL}, 'rows': rows,
                   'host_bindings': {'windows': copy.deepcopy(self.identity)},
                   'qualified': False, 'qualification_credit': 0, 'R0_decision': None}
        self.context = {'manifest': {'hosts': {'windows': {}}}}
        self.calls = []
        self.recomputed = copy.deepcopy(self.c4)
        def run(manifest):
            self.calls.append(manifest)
            return self.recomputed
        self.a = types.SimpleNamespace(scope_protocol=lambda: {'baseline_rows': self.baseline}, run=run,
            final_join=types.SimpleNamespace(validate_host_epoch=lambda *args: ({}, self.identity)))

    def test_correct_identity_preserves_thirteen_assumed_gap_rows(self):
        result = p.evaluate_public(self.a, self.context, self.c4, {}, {})
        self.assertEqual(result['verdict'], 'WINDOWS_PUBLIC_FIELDS_GAP')
        self.assertEqual(len(result['rows']), 13)
        self.assertEqual(result['c4_rows_preserved'], p.selected(self.c4['rows']))
        self.assertEqual(p.selected(self.recomputed['rows']), result['rows'])
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(all(row['hosts']['windows']['state'] == 'GAP' for row in result['rows']))

    def test_foreign_identity_candidate_protocol_refused_before_run(self):
        original = copy.deepcopy(self.c4)
        for field in ('identity', 'candidate', 'protocol'):
            with self.subTest(field=field):
                self.c4 = copy.deepcopy(original)
                if field == 'identity': self.c4['host_bindings']['windows']['references']['synthetic']['sha256'] = 'foreign'
                if field == 'candidate': self.c4['candidate_head'] = '0' * 40
                if field == 'protocol': self.c4['evaluation_protocol_ref']['sha256'] = '0' * 64
                with self.assertRaisesRegex(ValueError, 'C4 '):
                    p.evaluate_public(self.a, self.context, self.c4, {}, {})
                self.assertEqual(self.calls, [])

    def test_complete_frozen_scope_required_before_and_after_run(self):
        original = copy.deepcopy(self.c4)
        for after in (False, True):
            with self.subTest(after=after):
                self.c4 = copy.deepcopy(original)
                self.recomputed = copy.deepcopy(original)
                target = self.recomputed if after else self.c4
                next(row for row in target['rows'] if row['kind'] == 'support')['support_id'] = 'foreign'
                with self.assertRaisesRegex(ValueError, 'C4 support identities differ'):
                    p.evaluate_public(self.a, self.context, self.c4, {}, {})
        self.c4 = copy.deepcopy(original)
        self.recomputed = copy.deepcopy(original)
        self.recomputed['host_bindings']['windows'] = {'foreign': True}
        with self.assertRaisesRegex(ValueError, 'supplementary host identity changed'):
            p.evaluate_public(self.a, self.context, self.c4, {}, {})


def configuration_regression():
    """Actual run/public_check, complete bounded synthetic dataset, all GAP.

    This characterizes configuration wiring, not C4/native field acceptance.
    No carrier helpers, configure functions or native observations are mocked.
    Only protocol/host/data/expected loaders belong to the synthetic fixture.
    """
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory).resolve()
        protocol = root / 'protocol.json'
        protocol.write_bytes(gzip.decompress((HERE / 'windows-token-fields-test-protocol.json.gz').read_bytes()))
        a, initial, _, _ = p.tokens.prepare(REPO, protocol, p.tokens.PROTOCOL, root / 'cache')
        class Paths:
            frame = staticmethod(lambda *args: (_ for _ in ()).throw(ValueError('NO_NATIVE_FIXTURE')))
            equal = staticmethod(p.same_path)
            argv = p.OwnedPaths.argv
            native_file = staticmethod(str)
        modules, functions, _ = p.prepare_variants(a, initial, Paths())
        env = dict(a.__dict__)
        calls, apis = [], []
        def api_factory():
            marker = object()
            def read(*args, **kwargs):
                calls.append(('read', marker, all(function.variant.__globals__['API'] is api for function in functions.values())))
                raise ValueError('SYNTHETIC_NO_NATIVE_OBSERVATIONS')
            def read_process(*args, **kwargs):
                calls.append(('read_process', marker, all(function.variant.__globals__['API'] is api for function in functions.values())))
                raise ValueError('SYNTHETIC_NO_NATIVE_OBSERVATIONS')
            api = types.SimpleNamespace(**{**initial.__dict__, 'read': read, 'read_process': read_process, 'marker': marker})
            apis.append(api)
            return api
        rows = []
        public_rows, plan_rows, invocations = [], [], []
        for index, kind in enumerate(('index-store', 'public-verify')):
            row_id = 'synthetic-' + kind
            op = {'sequence': 0, 'lifecycle_selector': True, 'invocation_key': row_id,
                  'prepared_projection': {'public_flow_kind': kind}, 'expected_origin': {'path': 'unused', 'pointer': ''}}
            rows.append({'kind': 'property', 'coordinate': {'obligation_index': index, 'property_index': 1},
                         'property': 'synthetic configuration only', 'consumer': 'synthetic',
                         'selected_original_and_corrected_comparisons': [],
                         'source_addenda_digest_selections': [{'selections': [{'family': 'public', 'id': row_id, 'operations': [op]}]}]})
            public_rows.append({'id': row_id, 'observations': [{'sequence': 0, 'status': 'GAP'}]})
            plan_rows.append({'id': row_id, 'operations': [op]})
            invocations.append({'key': row_id, 'prepared': {'public_flow_kind': kind}})
        projection = {'schemaVersion': 1, 'files': {}, 'compiler': {}, 'digest': 'synthetic'}
        recipes = [{'unit_id': 'P01-retained-source::base', 'requests': [{}]},
                   {'unit_id': 'P25-byte-identity-relocation::identity-relation-01', 'baseline_expected_identity': projection,
                    'legacy_identity_mode': 'relocation'}]
        support_recipes = []
        for index, sid in enumerate(p.SUPPORTS):
            rows.append({'kind': 'support', 'support_id': sid})
            support_recipes.append({'support_id': sid, 'source_pointer': '/support_units/' + str(index),
                                    'surface': 'identity_support_cli', 'frozen_identity_projection': projection})
        host = {'root': root, 'identity': {'synthetic': True}, 'recipes': {'recipes': recipes, 'support_recipes': support_recipes},
                'public': {'rows': public_rows}, 'plan': {'rows': plan_rows, 'invocations': invocations}, 'dispositions': {}}
        env.update(scope_protocol=lambda: {'baseline_rows': rows},
                   scopes=lambda: {(0, 1): {'review': {}}, (1, 1): {'review': {}}},
                   load_host=lambda *args: host, adapter_api=api_factory)
        assessor_source = p.tokens.git_source(REPO, p.tokens.PACKAGE + 'assess_final.py').decode()
        for name in ('public_check', 'run'):
            exec(compile(p.segment(assessor_source, name), '<unchanged-frozen-' + name + '>', 'exec'), env)
        originals = {(module, name): getattr(modules[module], name) for module, name in functions}
        with p.installed_variants(modules, functions):
            previous = initial
            for _ in range(2):
                api_start, read_start = len(apis), len(calls)
                result = env['run']({'hosts': {'windows': {}}, 'expected_source_head': p.tokens.SOURCE})
                evaluation_apis = apis[api_start:]
                assert len(evaluation_apis) == 5
                expected_reads = [('read', api.marker, True) for api in evaluation_apis[:4]]
                expected_reads.append(('read_process', evaluation_apis[4].marker, True))
                assert calls[read_start:] == expected_reads, 'Each public/identity branch must read through its exact freshly configured API'
                assert len(result['rows']) == 5
                assert all(row['hosts']['windows']['state'] == 'GAP' for row in result['rows'])
                current = apis[-1]
                assert current is not previous
                assert calls[-1] == ('read_process', current.marker, True)
                assert all(function.variant.__globals__['API'] is current for function in functions.values())
                assert functions[('remaining_carriers', 'public_base_binding')].variant.__globals__['native_process_binding'] is functions[('remaining_carriers', 'native_process_binding')]
                assert functions[('nonqualified_carriers', 'legacy')].variant.__globals__['legacy_one'] is functions[('nonqualified_carriers', 'legacy_one')]
                previous = current
        assert all(getattr(modules[module], name) is original for (module, name), original in originals.items())
        # Execute the complete unchanged native-binding assertions with a bounded
        # synthetic process frame: request/cwd separators are the only tolerance.
        modules['remaining_carriers'].configure(api_factory())
        q = modules['qualified_carriers']
        prepared = {'case_root': 'C:/owned/case', 'repository_root': 'C:/owned/repository'}
        native_host = {'fixture': {'artifact_path': 'C:\\probe.exe', 'sdk_path': 'C:\\sdk.json'}}
        payload = json.dumps({'synthetic_unqualified': True})
        outcome = {'stdout': payload, 'stderr': '', 'stdout_bytes': len(payload.encode()), 'stderr_bytes': 0,
                   'stdout_hash': p.sha(payload.encode()), 'stderr_hash': p.sha(b''), 'kind': 'success', 'exit_code': 0}
        native = functions[('remaining_carriers', 'native_process_binding')]
        for mode, sdk in ((None, True), ('--batch', True), ('--discover-qualified-repository', False)):
            argv = [native_host['fixture']['artifact_path']] + ([mode] if mode else [])
            argv += ['C:\\owned\\case\\analysis-request.json'] + ([native_host['fixture']['sdk_path']] if sdk else [])
            frame = {'argv': argv, 'cwd': 'C:\\owned\\repository', 'outcome': outcome}
            def invoke(value, receipt_override=None, mode=mode, sdk=sdk):
                receipt = {'path': 'C:\\owned\\analysis-process.json', 'native_c1': True,
                           'frame_id': q.digest(value), 'process_outcome_id': q.digest(value['outcome'])}
                if receipt_override:
                    receipt.update(receipt_override)
                return native(native_host, prepared, {'analysis-process.json': value}, [receipt], 'analysis', mode, sdk)
            assert invoke(frame) == {'synthetic_unqualified': True}
            for field in ('artifact', 'request', 'mode', 'cwd', 'extra', 'sdk'):
                if field == 'mode' and mode is None or field == 'sdk' and not sdk:
                    continue
                wrong = copy.deepcopy(frame)
                if field == 'artifact': wrong['argv'][0] = 'C:/probe.exe'
                if field == 'request': wrong['argv'][1 + int(mode is not None)] = 'C:/foreign/analysis-request.json'
                if field == 'mode': wrong['argv'][1] = '--other'
                if field == 'cwd': wrong['cwd'] = 'C:/foreign/repository'
                if field == 'extra': wrong['argv'].append('extra')
                if field == 'sdk': wrong['argv'][-1] = 'C:/sdk.json'
                with unittest.TestCase().assertRaises(ValueError):
                    invoke(wrong)
            for override in ({'frame_id': 'foreign'}, {'process_outcome_id': 'foreign'}, {'native_c1': False}):
                with unittest.TestCase().assertRaises(ValueError):
                    invoke(frame, override)
        # Actual byte-identical callers must reach their supplementary children.
        base_frame = {'argv': [native_host['fixture']['artifact_path'],
                              'C:\\owned\\case\\base-native-request.json', native_host['fixture']['sdk_path']],
                      'cwd': 'C:\\owned\\repository', 'outcome': outcome}
        base_receipt = {'path': 'C:\\owned\\base-native-process.json', 'native_c1': True,
                        'frame_id': q.digest(base_frame), 'process_outcome_id': q.digest(outcome)}
        def after_native(*args):
            raise ValueError('BYTE_IDENTICAL_PUBLIC_CALLER_REACHED_VARIANT_NATIVE')
        with unittest.TestCase().assertRaisesRegex(ValueError, 'BYTE_IDENTICAL_PUBLIC_CALLER_REACHED_VARIANT_NATIVE'):
            functions[('remaining_carriers', 'public_base_binding')](native_host, prepared,
                {'base-native-process.json': base_frame}, [base_receipt],
                {'base_request': {}, 'base_native': {}}, after_native)
        def legacy_read_process(*args, **kwargs):
            return ({'identity_scope': 'baseline_3e94997f_implementation_and_compiler_bytes', 'compiler_executed': False},
                    {'operation': 'baseline_analyzer_identity', 'repository_root': 'D:\\logical\\implementation-0',
                     'compiler_package_root': 'D:\\logical\\compiler-0'}, [])
        def after_legacy_suffix(*args):
            raise ValueError('BYTE_IDENTICAL_LEGACY_CALLER_REACHED_VARIANT_SUFFIX')
        legacy_api = types.SimpleNamespace(**{**initial.__dict__, 'read_process': legacy_read_process, 'read': after_legacy_suffix})
        modules['nonqualified_carriers'].configure(legacy_api)
        with unittest.TestCase().assertRaisesRegex(ValueError, 'BYTE_IDENTICAL_LEGACY_CALLER_REACHED_VARIANT_SUFFIX'):
            functions[('nonqualified_carriers', 'legacy')]({}, {'legacy_identity_mode': 'crlf-refusal'}, root, 0)
        print('ACTUAL_FROZEN_RUN_COMPLETED_TWICE_WITH_CURRENT_API')


if __name__ == '__main__':
    if '--configuration-child' in sys.argv:
        configuration_regression()
    else:
        unittest.main()
