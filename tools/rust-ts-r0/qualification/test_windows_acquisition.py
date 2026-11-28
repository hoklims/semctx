"""Source-proof fixtures only; no native C1/SDK acquisition executes."""
import copy
import builtins
import contextlib
import csv
import gzip
import importlib.util
import io
import json
import os
import stat
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import zipfile

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('acquire_windows_raw', HERE / 'acquire_windows_raw.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class WindowsAcquisitionTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.tooling, self.producer, self.inputs = [self.root / name for name in ['tooling', 'producer', 'inputs']]
        for path in [self.tooling, self.producer, self.inputs]:
            path.mkdir()
        self.folder = self.inputs / m.BUNDLE
        self.folder.mkdir(parents=True)
        self.protocol = b'PUBLIC SOURCE-PROOF FIXTURE ONLY, NOT C1 EVIDENCE\n'
        patched = mock.patch.object(m, 'PROTOCOL', m.digest(self.protocol))
        patched.start()
        self.addCleanup(patched.stop)
        self.context = {'tooling': '1' * 40, 'manifest': '', 'campaign': 'source-proof', 'run_id': '123'}
        self.review = {'schema_version': 1, 'kind': 'OWNER_REVIEWED_NATIVE_PREREQUISITES', 'source_head': m.SOURCE,
            'protocol_sha256': m.PROTOCOL, 'authority': 'owner-root', 'decision': 'AUTHORIZE_WINDOWS_RAW_ACQUISITION',
            'hosts': {name: {'source_head': m.SOURCE, 'protocol_sha256': m.PROTOCOL, 'evidence_sha256': value * 64, 'reviewed': True}
                      for name, value in [('macos', 'a'), ('linux', 'b')]}, 'qualified': False, 'qualification_credit': 0}
        self.envelope = {'schema_version': 1, 'kind': 'WINDOWS_R0_EXECUTION_ENVELOPE', 'source_head': m.SOURCE,
            'protocol_sha256': m.PROTOCOL, 'sdk_sha256': m.SDK, 'tooling_head': self.context['tooling'],
            'campaign_id': self.context['campaign'], 'platform': 'windows', 'output_relative': 'windows-raw/source-proof',
            'run_attempt': 1, 'root_authority': m.AUTHORITY, 'prior_native_review_sha256': '', 'counts': dict(m.COUNTS),
            'retries': 0, 'execution_authorized': True, 'reserved_cases_authorized': False, 'new_spend_authorized': False,
            'timeout_seconds': 60}
        self.args = SimpleNamespace(workspace=self.root, tooling=self.tooling, producer=self.producer, inputs=self.inputs,
                                    input_commit='2' * 40, campaign_id='source-proof', node=self.root / 'node.exe')
        self.seal()

    def seal(self, protocol=None):
        (self.folder / 'protocol.json.gz').write_bytes(gzip.compress(self.protocol if protocol is None else protocol, mtime=0))
        m.save(self.folder / 'native-review.json', self.review)
        self.envelope['prior_native_review_sha256'] = m.sha(self.folder / 'native-review.json')
        m.save(self.folder / 'windows-envelope.json', self.envelope)
        manifest = {'schema_version': 1, 'kind': 'WINDOWS_R0_PUBLIC_INPUT_BUNDLE', 'source_head': m.SOURCE,
                    'tooling_head': self.context['tooling'], 'campaign_id': 'source-proof',
                    'files': {name: m.sha(self.folder / name) for name in m.FILES - {'manifest.json'}}}
        m.save(self.folder / 'manifest.json', manifest)
        self.context['manifest'] = m.sha(self.folder / 'manifest.json')

    def plan(self):
        return {'workspace': self.root, 'tooling': self.tooling, 'producer': self.producer, 'inputs': self.inputs,
                'folder': self.folder, 'before': {'source-proof': True}, **m.validate_bundle(self.folder, self.context)}

    def no_collector(self, message):
        with mock.patch.object(m, 'run_process', side_effect=AssertionError('collector must never be invoked')) as call:
            with self.assertRaisesRegex(ValueError, message):
                m.validate_bundle(self.folder, self.context)
            call.assert_not_called()

    def test_duplicate_nested_json_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / 'input.json'
            path.write_text('{"hosts":{"macos":1,"macos":2}}')
            with self.assertRaisesRegex(ValueError, 'duplicate JSON field'):
                m.load_object(path)

    def test_exact_bundle_preserves_four_collection_counts_and_zero_credit(self):
        result = m.validate_bundle(self.folder, self.context)
        self.assertEqual(result['protocol'], self.protocol)
        self.assertEqual(result['envelope']['counts'], {'original': 1, 'supplement': 1, 'as_expression': 2})
        self.assertFalse(self.review['qualified'])

    def test_external_manifest_enrollment_cannot_be_replaced_by_self_consistent_bundle(self):
        self.seal()
        self.context['manifest'] = 'f' * 64
        self.no_collector('enrolled input manifest differs')

    def test_wrong_source_protocol_review_or_tooling_cannot_invoke_collector(self):
        original = copy.deepcopy(self.envelope)
        for field, value in [('source_head', '3' * 40), ('protocol_sha256', '3' * 64), ('sdk_sha256', '3' * 64), ('tooling_head', '3' * 40)]:
            with self.subTest(field=field):
                self.envelope = {**original, field: value}
                self.seal()
                self.no_collector('envelope source/protocol/SDK/tooling')
        self.envelope = original
        self.review['hosts']['linux']['evidence_sha256'] = '0' * 64
        self.seal()
        self.no_collector('native host review incomplete')

    def test_current_manifest_cannot_authorize_wrong_decompressed_protocol(self):
        self.seal(protocol=b'foreign protocol')
        self.no_collector('protocol bytes differ')

    def test_missing_grant_extra_query_boolean_or_retry_is_refused(self):
        original = copy.deepcopy(self.envelope)
        for field, value in [('execution_authorized', False), ('reserved_cases_authorized', True), ('new_spend_authorized', True),
                             ('counts', {'original': 1, 'supplement': 1, 'as_expression': 3}), ('retries', 1), ('retries', False), ('run_attempt', 2)]:
            with self.subTest(field=field, value=value):
                self.envelope = {**original, field: value}
                self.seal()
                self.no_collector('grant|counts|retries')

    def test_unknown_schema_foreign_output_and_extra_files_are_refused(self):
        self.envelope['schema_version'] = 2
        self.seal()
        self.no_collector('unsupported schema')
        self.envelope['schema_version'] = 1
        self.envelope['output_relative'] = '../escape'
        self.seal()
        self.no_collector('output differs')
        self.envelope['output_relative'] = 'windows-raw/source-proof'
        self.seal()
        (self.folder / '.extra').write_text('not an input')
        self.no_collector('file set differs')

    def test_tampered_file_cannot_reuse_enrolled_manifest(self):
        (self.folder / 'native-review.json').write_text('{}')
        self.no_collector('file pin differs')

    def test_hardlinked_input_is_refused(self):
        path = self.folder / 'native-review.json'
        alias = self.root / 'alias'
        os.link(path, alias)
        self.no_collector('unlinked file required')

    def test_reparse_attribute_is_refused_without_following_it(self):
        with mock.patch.object(m.Path, 'lstat', return_value=SimpleNamespace(st_file_attributes=0x400, st_mode=stat.S_IFDIR)):
            with self.assertRaisesRegex(ValueError, 'link/reparse'):
                m.no_links(self.root)

    def test_manual_exact_repository_and_tooling_context_is_required(self):
        environment = {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REPOSITORY': m.REPOSITORY,
            'GITHUB_REPOSITORY_ID': m.REPOSITORY_ID, 'WINDOWS_R0_REPOSITORY_PRIVATE': 'false', 'GITHUB_RUN_ATTEMPT': '1',
            'WINDOWS_R0_TOOLING_SHA': '1' * 40, 'WINDOWS_R0_INPUT_MANIFEST_SHA256': 'a' * 64,
            'WINDOWS_R0_WORKFLOW_SHA': '1' * 40, 'GITHUB_RUN_ID': '123'}
        self.assertEqual(m.run_context(environment, 'source-proof')['tooling'], '1' * 40)
        for key, value in [('GITHUB_EVENT_NAME', 'pull_request'), ('GITHUB_RUN_ATTEMPT', '2'),
                           ('WINDOWS_R0_WORKFLOW_SHA', '2' * 40), ('GITHUB_REPOSITORY_ID', '42'),
                           ('WINDOWS_R0_INPUT_MANIFEST_SHA256', '0' * 64), ('WINDOWS_R0_REPOSITORY_PRIVATE', 'true')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                m.run_context({**environment, key: value}, 'source-proof')
        for campaign in ['../escape', 'a;Write-Host bad', 'A', 'a' * 65]:
            with self.subTest(campaign=campaign), self.assertRaises(ValueError):
                m.run_context(environment, campaign)

    def test_history_paginates_and_rejects_prior_campaign(self):
        first = [{'id': i + 1000, 'head_sha': '9' * 40, 'display_title': 'other'} for i in range(100)]
        current = {'id': 123, 'head_sha': self.context['tooling'], 'display_title': 'Windows RAW source-proof'}
        pages = {1: {'workflow_runs': first}, 2: {'workflow_runs': [current]}}
        self.assertEqual(m.check_dispatch_history(self.context, pages.__getitem__)['pages'], 2)
        pages[2]['workflow_runs'].append({**current, 'id': 124})
        with self.assertRaisesRegex(ValueError, 'already dispatched'):
            m.check_dispatch_history(self.context, pages.__getitem__)
        with self.assertRaisesRegex(ValueError, 'current dispatch absent'):
            m.check_dispatch_history(self.context, lambda page: {'workflow_runs': []})
        with self.assertRaisesRegex(ValueError, 'unknown Actions history'):
            m.check_dispatch_history(self.context, lambda page: {})

    def test_history_cannot_silently_repeat_or_skip_a_page(self):
        repeated = [{'id': i + 1000, 'head_sha': '9' * 40, 'display_title': 'other'} for i in range(100)]
        with self.assertRaisesRegex(ValueError, 'unstable Actions history'):
            m.check_dispatch_history(self.context, lambda page: {'workflow_runs': repeated})

    def test_history_rejects_same_campaign_under_different_tooling(self):
        current = {'id': 123, 'head_sha': self.context['tooling'], 'display_title': 'Windows RAW source-proof'}
        prior = {**current, 'id': 124, 'head_sha': '9' * 40}
        with self.assertRaisesRegex(ValueError, 'already dispatched'):
            m.check_dispatch_history(self.context, lambda page: {'workflow_runs': [current, prior]})

    def test_history_refuses_unknown_item_title_or_head(self):
        current = {'id': 123, 'head_sha': self.context['tooling'], 'display_title': 'Windows RAW source-proof'}
        for field, values in [('display_title', [None, '', ' ', 1, False, []]), ('head_sha', [None, '', 'a'*39, 'z'*40, 123, []])]:
            for value in values:
                prior = {**current, 'id': 124, 'display_title': 'other', field: value}
                with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, 'unknown Actions run metadata'):
                    m.check_dispatch_history(self.context, lambda page, prior=prior: {'workflow_runs': [current, prior]})
            prior = {**current, 'id': 124, 'display_title': 'other'}
            del prior[field]
            with self.subTest(missing=field), self.assertRaisesRegex(ValueError, 'unknown Actions run metadata'):
                m.check_dispatch_history(self.context, lambda page, prior=prior: {'workflow_runs': [current, prior]})

    def test_collector_environment_excludes_all_actions_secrets(self):
        value = m.collector_environment({'PATH': '/tools', 'SystemRoot': 'C:/Windows', 'GITHUB_TOKEN': 'secret',
            'GH_TOKEN': 'secret', 'ACTIONS_RUNTIME_TOKEN': 'secret', 'UNRELATED_SECRET': 'secret'})
        self.assertFalse(any('TOKEN' in key or 'SECRET' in key for key in value))
        self.assertEqual(value['CARGO_NET_OFFLINE'], 'true')
        for key in ['GIT_CONFIG_GLOBAL', 'GOPORT_BUILD_VERSION', 'CARGO_TARGET_DIR', 'RUSTC_WRAPPER', 'NODE_OPTIONS', 'NODE_PATH']:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'unsafe native environment'):
                m.collector_environment({key: 'forbidden'})

    def acquisition_patches(self):
        for name in ['check_dispatch_history', 'runtime_metadata', 'protocol_check', 'isolated', 'postflight']:
            value = {'check_dispatch_history': {}, 'runtime_metadata': {}, 'protocol_check': {'exit_code': 0},
                     'isolated': ['source-proof-only-stub'], 'postflight': {'source-proof': True}}[name]
            patch = mock.patch.object(m, name, return_value=value)
            patch.start()
            self.addCleanup(patch.stop)
        environment = {k: v for k, v in os.environ.items() if k not in ['GIT_CONFIG_GLOBAL', 'GOPORT_BUILD_VERSION', 'CARGO_TARGET_DIR', 'RUSTC_WRAPPER', 'NODE_OPTIONS', 'NODE_PATH']}
        patch = mock.patch.dict(os.environ, environment, clear=True)
        patch.start()
        self.addCleanup(patch.stop)

    def stub(self, status=23, timeout=False):
        def run(argv, cwd, env, directory, label, seconds):
            self.assertFalse(any(name in env for name in ['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN']))
            code = 'import sys,time;sys.stdout.buffer.write(("fixture stdout"+chr(10)).encode());sys.stdout.flush();sys.stderr.buffer.write(("fixture stderr"+chr(10)).encode());sys.stderr.flush();' + ('time.sleep(60)' if timeout else 'sys.exit(' + str(status) + ')')
            return m.run_process([sys.executable, '-I', '-S', '-B', '-c', code], cwd, env, directory, label, 0.1 if timeout else 10)
        return run

    def test_failed_real_stub_preserves_status_and_raw_streams(self):
        self.acquisition_patches()
        code, result = m.acquire(self.args, self.context, self.plan(), process_runner=self.stub(23))
        self.assertEqual(code, 23)
        self.assertEqual(result['collector_invocations'], 1)
        self.assertEqual(result['collector']['exit_code'], 23)
        self.assertFalse(result['qualified'])
        self.assertEqual(result['state'], 'ACQUISITION_FAILED', result)
        with zipfile.ZipFile(result['archive']['path']) as archive:
            self.assertEqual(archive.read('control/collector.stdout'), b'fixture stdout\n')
            self.assertEqual(archive.read('control/collector.stderr'), b'fixture stderr\n')

    def test_timeout_real_stub_preserves_124_and_raw(self):
        self.acquisition_patches()
        code, result = m.acquire(self.args, self.context, self.plan(), process_runner=self.stub(timeout=True))
        self.assertEqual(code, 124)
        self.assertTrue(result['collector']['timed_out'])
        self.assertTrue(Path(result['archive']['path']).is_file())

    def test_timeout_status_survives_cleanup_wait_failure_with_real_owned_process(self):
        original_popen = subprocess.Popen
        for failure in ['timeout', 'error']:
            with self.subTest(cleanup=failure):
                directory = self.root / failure
                directory.mkdir()
                marker = directory / 'descendant.pid'
                code = 'import pathlib,subprocess,sys,time;p=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"]);pathlib.Path(sys.argv[1]).write_text(str(p.pid));time.sleep(60)'
                owned = []
                def spawn(*args, marker=marker, owned=owned, failure=failure, **kwargs):
                    process = original_popen(*args, **kwargs)
                    if args[0][0] == sys.executable and str(args[0][-1]) == str(marker):
                        owned.append(process)
                        wait = process.wait
                        calls = [0]
                        def fail_cleanup_wait(timeout=None):
                            calls[0] += 1
                            if calls[0] == 2:
                                if failure == 'timeout':
                                    raise subprocess.TimeoutExpired(process.args, timeout)
                                raise OSError('simulated cleanup wait failure')
                            return wait(timeout=timeout)
                        process.wait = fail_cleanup_wait
                    return process
                try:
                    with mock.patch.object(m.subprocess, 'Popen', side_effect=spawn):
                        result = m.run_process([sys.executable, '-I', '-S', '-B', '-c', code, str(marker)], self.root,
                                              m.collector_environment({k: v for k, v in os.environ.items() if k not in ['GIT_CONFIG_GLOBAL', 'GOPORT_BUILD_VERSION', 'CARGO_TARGET_DIR', 'RUSTC_WRAPPER', 'NODE_OPTIONS', 'NODE_PATH']}),
                                              directory, 'cleanup-failure', 1)
                    self.assertTrue(marker.is_file(), 'owned descendant did not become ready')
                    self.assertTrue(result['timed_out'])
                    self.assertEqual(result['exit_code'], 124, 'cleanup failure replaced original timeout status')
                    self.assertTrue(result['error'], 'cleanup error must remain visible')
                    pid = marker.read_text()
                    if os.name == 'nt':
                        listing = subprocess.check_output(['tasklist', '/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH']).decode()
                        self.assertFalse(any(len(row) > 1 and row[1] == pid for row in csv.reader(io.StringIO(listing))), 'owned descendant survived fixture')
                    else:
                        listing = subprocess.run(['/bin/ps', '-p', pid, '-o', 'stat='], capture_output=True, text=True, check=False)
                        self.assertFalse(any(line.strip() and not line.strip().startswith('Z') for line in listing.stdout.splitlines()), 'owned descendant survived fixture')
                finally:
                    for process in owned:
                        if os.name == 'nt':
                            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                        else:
                            try:
                                os.killpg(process.pid, 9)
                            except ProcessLookupError:
                                pass
                        process.wait(timeout=10)

    def test_timeout_receipt_records_nonzero_taskkill_with_real_owned_process(self):
        real_popen = subprocess.Popen
        owned = []
        def start(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            owned.append(process)
            return process
        def cleanup(*args, **kwargs):
            self.assertEqual(args[0], ['taskkill', '/PID', str(owned[0].pid), '/T', '/F'])
            self.assertEqual(kwargs.get('timeout'), 30)
            owned[0].kill()
            return subprocess.CompletedProcess(args[0], 9, b'controlled cleanup stdout', b'controlled cleanup stderr')
        try:
            with mock.patch.object(m, 'os', SimpleNamespace(name='nt')), \
                 mock.patch.object(m.subprocess, 'CREATE_NEW_PROCESS_GROUP', 0, create=True), \
                 mock.patch.object(m.subprocess, 'Popen', side_effect=start), \
                 mock.patch.object(m.subprocess, 'run', side_effect=cleanup):
                result = m.run_process([sys.executable, '-I', '-S', '-B', '-c',
                    'import time; print("owned stub", flush=True); time.sleep(30)'], self.root,
                    os.environ.copy(), self.root, 'nonzero-cleanup', 1)
            self.assertEqual(result['exit_code'], 124)
            self.assertTrue(result['timed_out'])
            self.assertEqual(result['error'], 'taskkill exit code: 9')
            self.assertEqual(json.loads((self.root/'nonzero-cleanup.receipt.json').read_text()), result)
            self.assertIn(b'owned stub', (self.root/'nonzero-cleanup.stdout').read_bytes())
            self.assertEqual((self.root/'nonzero-cleanup.taskkill.stdout').read_bytes(), b'controlled cleanup stdout')
            self.assertEqual((self.root/'nonzero-cleanup.taskkill.stderr').read_bytes(), b'controlled cleanup stderr')
        finally:
            for process in owned:
                if process.poll() is None:
                    process.kill()
                real_popen.wait(process, timeout=5)

    def test_postflight_drift_cannot_report_success(self):
        self.acquisition_patches()
        with mock.patch.object(m, 'complete_raw', return_value={'counts': m.COUNTS}), \
             mock.patch.object(m, 'postflight', side_effect=ValueError('tracked Git blob differs')):
            code, result = m.acquire(self.args, self.context, self.plan(), process_runner=self.stub(0))
        self.assertEqual(code, 1)
        self.assertEqual(result['state'], 'ACQUISITION_FAILED_POSTFLIGHT', result)
        self.assertEqual(result['collector']['exit_code'], 0)

    def test_postflight_compares_all_three_actual_snapshot_results(self):
        plan = self.plan()
        before = {'tooling': {'files': {'wrapper': 'a'}}, 'producer': {'files': {'producer': 'b'}}, 'inputs': {'files': {'manifest': 'c'}}}
        plan['before'] = before
        for changed in ['tooling', 'producer', 'inputs']:
            after = copy.deepcopy(before)
            after[changed]['files']['drift'] = 'd'
            with self.subTest(changed=changed), mock.patch.object(m, 'snapshot', side_effect=[after['tooling'], after['producer'], after['inputs']]):
                with self.assertRaisesRegex(ValueError, 'checkout drift'):
                    m.postflight(plan, self.args, self.context)

    def test_main_rejects_wrong_enrolled_data_before_any_collector_call(self):
        environment = {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REPOSITORY': m.REPOSITORY,
            'GITHUB_REPOSITORY_ID': m.REPOSITORY_ID, 'WINDOWS_R0_REPOSITORY_PRIVATE': 'false', 'GITHUB_RUN_ATTEMPT': '1',
            'WINDOWS_R0_TOOLING_SHA': self.context['tooling'], 'WINDOWS_R0_INPUT_MANIFEST_SHA256': self.context['manifest'],
            'WINDOWS_R0_WORKFLOW_SHA': self.context['tooling'], 'GITHUB_RUN_ID': '123'}
        argv = ['--tooling', str(self.tooling), '--producer', str(self.producer), '--inputs', str(self.inputs),
                '--workspace', str(self.root), '--input-commit', self.args.input_commit, '--campaign-id', self.args.campaign_id, '--node', str(self.args.node)]
        original = copy.deepcopy(self.envelope)
        for field, value in [('source_head', '3' * 40), ('protocol_sha256', '3' * 64), ('tooling_head', '3' * 40)]:
            self.envelope = {**original, field: value}
            self.seal()
            environment['WINDOWS_R0_INPUT_MANIFEST_SHA256'] = self.context['manifest']
            with self.subTest(field=field), mock.patch.dict(os.environ, environment, clear=True), \
                 mock.patch.object(m, '__file__', str(self.tooling / m.QUALIFICATION / 'acquire_windows_raw.py')), \
                 mock.patch.object(m, 'acquire', return_value=(0, {})) as collector, \
                 contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(m.main(argv), 1)
                collector.assert_not_called()

    def test_existing_output_or_control_refuses_before_collector(self):
        plan = self.plan()
        output = self.root / 'windows-raw/source-proof'
        output.mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'existing output/attempt'):
            m.acquire(self.args, self.context, plan, process_runner=mock.Mock(side_effect=AssertionError('must not call')))

    def test_archive_cap_marks_omissions_without_truncating_stored_files(self):
        control, output = self.root / 'control', self.root / 'raw'
        control.mkdir()
        output.mkdir()
        (control / 'small.log').write_bytes(b'complete log')
        (output / 'large.raw').write_bytes(os.urandom(32000))
        result = m.archive_raw(control, output, self.root / 'bundle.zip', limit=4096)
        self.assertFalse(result['complete'])
        self.assertLessEqual(result['bytes'], 4096)
        self.assertGreater(result['omitted_files'], 0)
        with zipfile.ZipFile(result['path']) as archive:
            self.assertEqual(archive.read('control/small.log'), b'complete log')
            self.assertIn('ARCHIVE-INCOMPLETE.json', archive.namelist())

    def test_archive_keeps_raw_and_nested_result_json_exact_bytes(self):
        control, output = self.root/'result-control', self.root/'result-raw'
        expected = {'raw/result.json': b'original raw result', 'raw/nested/result.json': b'nested raw result',
                    'control/nested/result.json': b'nested control result'}
        for name, data in expected.items():
            path = (output if name.startswith('raw/') else control)/name.split('/', 1)[1]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        (control/'result.json').write_bytes(b'final receipt excluded')
        result = m.archive_raw(control, output, self.root/'results.zip')
        self.assertTrue(result['complete'], result)
        with zipfile.ZipFile(result['path']) as archive:
            self.assertNotIn('control/result.json', archive.namelist())
            for name, data in expected.items():
                self.assertIn(name, archive.namelist())
                self.assertEqual(m.digest(archive.read(name)), m.digest(data))

    def test_archive_windows_handle_and_path_stat_surfaces_keep_exact_bytes(self):
        control, output = self.root/'stat-control', self.root/'stat-raw'
        control.mkdir(); output.mkdir()
        path = output/'result.cmd'
        raw = b'complete raw bytes\x00\xff\r\n'
        path.write_bytes(raw)
        original_lstat, original_fstat = Path.lstat, os.fstat
        def path_stat(candidate, *args, **kwargs):
            value = original_lstat(candidate, *args, **kwargs)
            if candidate == path:
                fields = {name: getattr(value, name) for name in ['st_mode', 'st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink']}
                fields.update(st_mode=value.st_mode | 0o111, st_ctime_ns=100,
                              st_file_attributes=getattr(value, 'st_file_attributes', 0), st_reparse_tag=0)
                return SimpleNamespace(**fields)
            return value
        def handle_stat(fd):
            value = original_fstat(fd)
            fields = {name: getattr(value, name) for name in ['st_mode', 'st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink']}
            fields.update(st_mode=value.st_mode & ~0o111, st_ctime_ns=200,
                          st_file_attributes=getattr(value, 'st_file_attributes', 0), st_reparse_tag=0)
            return SimpleNamespace(**fields)
        # CPython 3.13.16: path ctime is birthtime and .cmd adds execute bits;
        # fstat ctime is ChangeTime and permissions come only from attributes.
        with mock.patch.object(m.sys, 'platform', 'win32'), mock.patch.object(Path, 'lstat', path_stat), mock.patch.object(m.os, 'fstat', side_effect=handle_stat):
            result = m.archive_raw(control, output, self.root/'stat.zip')
        self.assertTrue(result['complete'], result)
        with zipfile.ZipFile(result['path']) as archive:
            self.assertEqual(archive.read('raw/result.cmd'), raw)

    def test_archive_stat_surface_normalization_still_rejects_identity_and_stability_faults(self):
        path = self.root/'fault.cmd'
        path.write_bytes(b'complete public fixture')
        original_lstat, original_fstat = Path.lstat, os.fstat
        def fields(value):
            return {name: getattr(value, name, 0) for name in ['st_mode', 'st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink', 'st_file_attributes', 'st_reparse_tag']}
        baseline = fields(original_lstat(path))
        baseline.update(st_mode=baseline['st_mode'] | 0o111, st_ctime_ns=100)
        expected = SimpleNamespace(**baseline)
        faults = [('handle', 1, key, baseline[key] + 1) for key in ['st_dev', 'st_ino', 'st_size', 'st_mtime_ns']]
        faults += [('handle', 1, 'st_mode', stat.S_IFIFO | 0o666),
                   ('handle', 1, 'st_mode', stat.S_IFREG | 0o444),
                   ('handle', 1, 'st_file_attributes', baseline['st_file_attributes'] | 0x400),
                   ('handle', 1, 'st_nlink', 2), ('handle', 2, 'st_nlink', 2),
                   ('handle', 2, 'st_ctime_ns', 201),
                   ('path', 2, 'st_ctime_ns', 101), ('path', 3, 'st_ctime_ns', 101),
                   ('path', 3, 'st_mode', baseline['st_mode'] & ~0o111),
                   ('path', 3, 'st_file_attributes', baseline['st_file_attributes'] ^ 0x20),
                   ('path', 3, 'st_nlink', 2)]
        for index, (surface, phase, key, changed) in enumerate(faults):
            with self.subTest(surface=surface, phase=phase, field=key):
                calls = {'path': 0, 'handle': 0}
                def observed(kind, calls=calls, surface=surface, phase=phase, key=key, changed=changed):
                    calls[kind] += 1
                    result = dict(baseline)
                    if kind == 'handle':
                        result.update(st_mode=result['st_mode'] & ~0o111, st_ctime_ns=200)
                    if kind == surface and calls[kind] >= phase:
                        result[key] = changed
                    return SimpleNamespace(**result)
                def path_stat(candidate, *args, **kwargs):
                    return observed('path') if candidate == path else original_lstat(candidate, *args, **kwargs)
                def handle_stat(fd):
                    original_fstat(fd)
                    return observed('handle')
                with zipfile.ZipFile(self.root/f'fault-{index}.zip', 'w') as archive:
                    with mock.patch.object(m.sys, 'platform', 'win32'), mock.patch.object(Path, 'lstat', path_stat), mock.patch.object(m.os, 'fstat', side_effect=handle_stat):
                        with self.assertRaisesRegex(ValueError, 'archive file (exchanged before|changed during) read'):
                            m.archive_file(archive, path, 'raw/fault.cmd', expected)

    def test_archive_records_lexical_links_without_reading_or_traversing_targets(self):
        control, output, outside = [self.root/name for name in ['link-control', 'link-raw', 'forbidden-target']]
        for path in [control, output, outside]:
            path.mkdir()
        (outside/'secret').write_bytes(b'TARGET MUST NEVER BE READ')
        (output/'ordinary.log').write_bytes(b'owned raw bytes')
        links = {output/'file-link': outside/'secret', output/'directory-link': outside, output/'dangling-link': outside/'absent'}
        for path, target in links.items():
            path.symlink_to(target, target_is_directory=path.name == 'directory-link')
        original_open, original_path_open, original_iterdir, original_os_open = builtins.open, Path.open, Path.iterdir, os.open
        def guarded_open(file, *args, **kwargs):
            if not isinstance(file, int):
                path = Path(file)
                self.assertFalse(path in links or path == outside or outside in path.parents, 'archive attempted to read a link target')
            return original_open(file, *args, **kwargs)
        def guarded_os_open(path, *args, **kwargs):
            self.assertFalse(Path(path) in links or Path(path) == outside or outside in Path(path).parents, 'archive opened a link target')
            return original_os_open(path, *args, **kwargs)
        def guarded_path_open(path, *args, **kwargs):
            self.assertFalse(path in links or path == outside or outside in path.parents, 'archive attempted to read a link target')
            return original_path_open(path, *args, **kwargs)
        def guarded_iterdir(path):
            self.assertFalse(path in links or path == outside or outside in path.parents, 'archive traversed a directory-link target')
            return original_iterdir(path)
        with mock.patch('builtins.open', side_effect=guarded_open), mock.patch.object(Path, 'open', guarded_path_open), mock.patch.object(Path, 'iterdir', guarded_iterdir), mock.patch.object(m.os, 'open', side_effect=guarded_os_open):
            result = m.archive_raw(control, output, self.root/'links.zip')
        self.assertTrue(result['complete'], 'known fixture links must be represented lexically')
        self.assertEqual(result['lexical_links'], 3)
        with zipfile.ZipFile(result['path']) as archive:
            self.assertIn('ARCHIVE-LINKS.json', archive.namelist())
            metadata = json.loads(archive.read('ARCHIVE-LINKS.json'))
            self.assertEqual(metadata['representation'], 'lexical_links')
            self.assertFalse(metadata['targets_read'])
            self.assertFalse(metadata['native_links_in_zip'])
            self.assertEqual({row['archive_path']: row['target'] for row in metadata['links']},
                             {'raw/'+p.name: os.readlink(p) for p in links})
            self.assertTrue(all(row['capture_stable'] for row in metadata['links']))
            self.assertFalse(any('raw/'+p.name in archive.namelist() for p in links))
            self.assertEqual(archive.read('raw/ordinary.log'), b'owned raw bytes')
        self.assertEqual(len(m.regular_tree(output)[1]), 3, 'strict input/source walker was loosened')
        review = self.folder/'native-review.json'
        review.unlink(); review.symlink_to(outside/'secret')
        with self.assertRaisesRegex(ValueError, 'link/reparse'):
            m.validate_bundle(self.folder, self.context)

    def test_archive_link_exchange_is_incomplete_not_target_data(self):
        control, output = self.root/'exchange-control', self.root/'exchange-raw'
        control.mkdir(); output.mkdir()
        link = output/'changed-link'
        link.symlink_to('initial-missing-target')
        original = os.readlink
        exchanged = []
        def exchange(path, *args, **kwargs):
            value = original(path, *args, **kwargs)
            if Path(path) == link and not exchanged:
                exchanged.append(True); link.unlink(); link.symlink_to('different-missing-target')
            return value
        with mock.patch.object(m.os, 'readlink', side_effect=exchange):
            result = m.archive_raw(control, output, self.root/'exchange.zip')
        self.assertFalse(result['complete'])
        self.assertTrue(result['input_errors'])

    def test_archive_fallback_keeps_lexical_link_metadata(self):
        control, output = self.root/'fallback-control', self.root/'fallback-raw'
        control.mkdir(); output.mkdir()
        (output/'large.raw').write_bytes(os.urandom(32000))
        (output/'dangling').symlink_to('missing-target')
        result = m.archive_raw(control, output, self.root/'fallback-links.zip', limit=4096)
        self.assertFalse(result['complete'])
        self.assertLessEqual(result['bytes'], 4096)
        with zipfile.ZipFile(result['path']) as archive:
            self.assertIn('ARCHIVE-LINKS.json', archive.namelist())
            self.assertEqual(json.loads(archive.read('ARCHIVE-LINKS.json'))['links'][0]['target'], 'missing-target')

    def test_archive_hardlinks_remain_incomplete(self):
        control, output = self.root/'hard-control', self.root/'hard-raw'
        control.mkdir(); output.mkdir()
        (output/'one').write_text('public fixture')
        os.link(output/'one', output/'two')
        result = m.archive_raw(control, output, self.root/'hardlinks.zip')
        self.assertFalse(result['complete'])
        self.assertEqual(len(result['input_errors']), 2)

    def test_archive_hardlinked_symlink_metadata_remains_incomplete(self):
        control, output = self.root/'hybrid-control', self.root/'hybrid-raw'
        control.mkdir(); output.mkdir()
        link = output/'link'
        link.symlink_to('missing-target')
        original = Path.lstat
        def linked_stat(path, *args, **kwargs):
            value = original(path, *args, **kwargs)
            if path == link:
                fields = ['st_mode', 'st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns']
                return SimpleNamespace(**{key: getattr(value, key) for key in fields}, st_nlink=2,
                                       st_file_attributes=getattr(value, 'st_file_attributes', 0),
                                       st_reparse_tag=getattr(value, 'st_reparse_tag', 0))
            return value
        with mock.patch.object(Path, 'lstat', linked_stat):
            result = m.archive_raw(control, output, self.root/'hybrid.zip')
        self.assertFalse(result['complete'], 'hardlinked symlink metadata accepted')
        self.assertEqual(len(result['input_errors']), 1)

    def test_archive_unknown_reparse_is_incomplete_without_target_read(self):
        control, output = self.root/'reparse-control', self.root/'reparse-raw'
        control.mkdir(); output.mkdir()
        path = output/'unknown'
        path.write_bytes(b'opaque')
        original = Path.lstat
        def unknown_reparse(candidate):
            value = original(candidate)
            if candidate == path:
                fields = {name: getattr(value, name) for name in ['st_mode', 'st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink']}
                return SimpleNamespace(**fields, st_file_attributes=0x400, st_reparse_tag=0x80000042)
            return value
        with mock.patch.object(Path, 'lstat', unknown_reparse), mock.patch.object(m.os, 'readlink', side_effect=AssertionError('unknown target must not be read')):
            result = m.archive_raw(control, output, self.root/'unknown-reparse.zip')
        self.assertFalse(result['complete'])
        self.assertIn('unknown archive reparse', result['input_errors'][0]['error'])

    @unittest.skipUnless(os.name == 'nt', 'Native Windows junction metadata is exercised by workflow verification')
    def test_windows_junction_is_lexical_metadata_not_traversed(self):
        control, output, target = self.root/'junction-control', self.root/'junction-raw', self.root/'junction-target'
        for path in [control, output, target]:path.mkdir()
        junction = output/'junction'
        made = subprocess.run(['cmd', '/c', 'mklink', '/J', str(junction), str(target)], capture_output=True)
        self.assertEqual(made.returncode, 0, made.stderr)
        result = m.archive_raw(control, output, self.root/'junction.zip')
        self.assertTrue(result['complete'])
        with zipfile.ZipFile(result['path']) as archive:
            row = json.loads(archive.read('ARCHIVE-LINKS.json'))['links'][0]
            self.assertEqual(row['link_type'], 'junction')
            self.assertEqual(row['target'], os.readlink(junction))
            self.assertEqual(row['stat']['reparse_tag'], 0xA0000003)

    def test_raw_completeness_requires_all_reports_and_exact_two_additional_queries(self):
        output = self.root / 'raw-fixture'
        output.mkdir()
        reports = {}
        for name in m.RAW_REPORTS:
            path = output / name
            path.parent.mkdir(exist_ok=True, parents=True)
            path.write_bytes(b'{}\n')
            reports[name] = m.sha(path)
        for name in ['original', 'supplement']:
            m.save(output / (name + '-native.receipt.json'), {'exit_code': 0, 'timed_out': False, 'attempt': 1})
        additional = output / 'additional.json'
        additional_data = {'source_head': m.SOURCE, 'platform': 'windows', 'postflight_ok': True, 'expected_candidate_phases': 2,
            'candidate_phases_completed': 2, 'caller_invocations_attempted': ['legacy', 'retained'], 'candidate_outcomes_recorded': 2, 'attempts': 1,
            'contexts': [{'context': 'legacy'}, {'context': 'retained'}]}
        m.save(additional, additional_data)
        review = 'a' * 64
        summary = {'source_head': m.SOURCE, 'qualified': False, 'qualification_credit': 0, 'attempts': 1,
            'root_prior_review_reference_sha256': review, 'original_exit_code': 0, 'supplement_exit_code': 0,
            'reports': reports, 'additional_as_expression_witness': {'path': str(additional), 'sha256': m.sha(additional)}}
        m.save(output / 'acquisition-summary.json', summary)
        self.assertEqual(m.complete_raw(output, review)['counts'], m.COUNTS)
        additional_data['caller_invocations_attempted'].append('extra')
        m.save(additional, additional_data)
        summary['additional_as_expression_witness']['sha256'] = m.sha(additional)
        m.save(output / 'acquisition-summary.json', summary)
        with self.assertRaisesRegex(ValueError, 'exact two'):
            m.complete_raw(output, review)
        additional_data['caller_invocations_attempted'] = ['legacy', 'retained']
        additional_data['contexts'].append(None)
        m.save(additional, additional_data)
        summary['additional_as_expression_witness']['sha256'] = m.sha(additional)
        m.save(output / 'acquisition-summary.json', summary)
        with self.assertRaisesRegex(ValueError, 'attempts/contexts'):
            m.complete_raw(output, review)
        additional_data['contexts'].pop()
        m.save(additional, additional_data)
        summary['additional_as_expression_witness']['sha256'] = m.sha(additional)
        summary['reports'].pop(next(iter(m.RAW_REPORTS)))
        m.save(output / 'acquisition-summary.json', summary)
        with self.assertRaisesRegex(ValueError, 'raw reports incomplete'):
            m.complete_raw(output, review)

    def test_bootstrap_uses_producer_helpers_and_tooling_collector(self):
        source, tooling = self.root / 'source-helpers', self.root / 'tooling-script'
        source.mkdir()
        tooling.mkdir()
        (source / 'example_helper.py').write_text('VALUE="verified producer"\n')
        (tooling / 'example_helper.py').write_text('raise RuntimeError("foreign tooling helper imported")\n')
        script = tooling / 'collector.py'
        script.write_text('import example_helper;print(example_helper.VALUE)\n')
        value = subprocess.run([sys.executable, '-I', '-S', '-B', '-c', m.BOOTSTRAP, str(source), str(script)], capture_output=True)
        self.assertEqual(value.returncode, 0, value.stderr)
        self.assertEqual(value.stdout.strip(), b'verified producer')

    @unittest.skipUnless(os.name == 'nt', 'Native Windows owned-tree timeout fixture runs in the workflow verification job')
    def test_native_windows_timeout_kills_owned_descendant_before_acquisition(self):
        marker = self.root / 'child.pid'
        code = 'import pathlib,subprocess,sys,time;p=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"]);pathlib.Path(sys.argv[1]).write_text(str(p.pid));time.sleep(60)'
        env = m.collector_environment({k: v for k, v in os.environ.items() if k not in ['GIT_CONFIG_GLOBAL', 'GOPORT_BUILD_VERSION', 'CARGO_TARGET_DIR', 'RUSTC_WRAPPER', 'NODE_OPTIONS', 'NODE_PATH']})
        result = m.run_process([sys.executable, '-I', '-S', '-B', '-c', code, str(marker)], self.root, env, self.root, 'owned-tree', 2)
        self.assertTrue(marker.is_file(), 'owned descendant did not become ready')
        pid = marker.read_text()
        self.assertTrue(result['timed_out'])
        listing = subprocess.check_output(['tasklist', '/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH']).decode()
        self.assertFalse(any(len(row) > 1 and row[1] == pid for row in csv.reader(io.StringIO(listing))), 'owned descendant survived taskkill tree timeout')


class GitSnapshotTest(unittest.TestCase):
    def test_tracked_bytes_must_match_actual_git_blob(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=root)
            git('init', '-q')
            git('config', 'user.email', 'source-proof@example.invalid')
            git('config', 'user.name', 'Source proof fixture')
            git('config', 'core.autocrlf', 'false')
            path = root/'file.txt'
            path.write_bytes(b'public fixture\n')
            git('add', 'file.txt')
            git('commit', '-qm', 'synthetic source-proof fixture, never a candidate')
            head = git('rev-parse', 'HEAD').decode().strip()
            self.assertFalse(git('status', '--porcelain=v1', '--untracked-files=all').strip())
            read_bytes = Path.read_bytes
            reads = []
            def changed_bytes(candidate):
                if candidate == path:
                    reads.append(candidate)
                    return b'foreign bytes returned after clean status\n'
                return read_bytes(candidate)
            with mock.patch.object(Path, 'read_bytes', changed_bytes), self.assertRaisesRegex(ValueError, 'tracked Git blob differs'):
                m.snapshot(root, head)
            self.assertEqual(reads, [path], 'fixture must reach the tracked-byte comparison')

    def test_actual_git_blob_and_hidden_index_flags_are_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=root)
            git('init', '-q')
            git('config', 'user.email', 'source-proof@example.invalid')
            git('config', 'user.name', 'Source proof fixture')
            git('config', 'core.autocrlf', 'false')
            (root / 'file.txt').write_bytes(b'public fixture\n')
            git('add', 'file.txt')
            git('commit', '-qm', 'synthetic source-proof fixture, never a candidate')
            head = git('rev-parse', 'HEAD').decode().strip()
            self.assertIn('file.txt', m.snapshot(root, head)['files'])
            git('update-index', '--assume-unchanged', 'file.txt')
            with self.assertRaisesRegex(ValueError, 'hidden index flags'):
                m.snapshot(root, head)
            git('update-index', '--no-assume-unchanged', 'file.txt')
            git('update-index', '--skip-worktree', 'file.txt')
            with self.assertRaisesRegex(ValueError, 'hidden index flags'):
                m.snapshot(root, head)
            git('update-index', '--no-skip-worktree', 'file.txt')
            with self.assertRaisesRegex(ValueError, 'HEAD differs'):
                m.snapshot(root, 'f' * 40)

    def test_ignored_untracked_python_cannot_enter_collector_import_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            qualification = root / m.QUALIFICATION
            qualification.mkdir(parents=True)
            (qualification / 'run_windows_milestone.py').write_text('# synthetic fixture only\n')
            (root / '.gitignore').write_text('ignored.py\n')
            subprocess.run(['git', 'init', '-q'], cwd=root, check=True)
            subprocess.run(['git', 'add', '.'], cwd=root, check=True)
            (qualification / 'ignored.py').write_text('raise RuntimeError("not trusted source")\n')
            with self.assertRaisesRegex(ValueError, 'untracked Python import surface'):
                m.isolated(root, 'run_windows_milestone.py', [])


if __name__ == '__main__':
    unittest.main()
