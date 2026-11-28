"""Synthetic transport fixtures only; these never establish Windows qualification."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tarfile
import unittest
import unicodedata
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('windows_adapter', HERE / 'adapt_windows_raw.py')
a = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(a)
REPO = HERE.parents[2]
PUBLIC_READER = 'tools/rust-ts-r0/qualification/windows_public_fields.py'


def synthetic_code_checkout(destination):
    """Exact shipped bytes in a distinct temporary Git checkout, never admission."""
    destination.mkdir()
    subprocess.run(['git', 'init', '-q', str(destination)], check=True)
    for relative in (*a.READBACK_FILES.values(), PUBLIC_READER):
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((REPO / relative).read_bytes())
    subprocess.run(['git', '-C', str(destination), 'add', '.'], check=True)
    hooks = destination / '.git/empty-hooks'
    hooks.mkdir()
    subprocess.run(['git', '-C', str(destination), '-c', 'user.name=Synthetic',
                    '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false',
                    '-c', 'core.hooksPath=' + str(hooks), 'commit', '-qm', 'Synthetic shipped source fixture'], check=True)
    return destination


def frozen_reader_fixture(root):
    import gzip
    registered = synthetic_code_checkout(root / 'registered-W')
    executing = synthetic_code_checkout(root / 'executing-E')
    protocol = root / 'protocol.json'
    protocol.write_bytes(gzip.decompress((HERE / 'windows-token-fields-test-protocol.json.gz').read_bytes()))
    if a.digest(protocol.read_bytes()) != a.PROTOCOL:
        raise AssertionError('canonical protocol fixture differs')
    args = ['--repo', str(REPO), '--readback-repo', str(registered), '--protocol', str(protocol),
            '--protocol-sha256', a.PROTOCOL, '--freeze-only']
    return registered, executing, protocol, args


def actual_reader_command(reader, executing, args, helper=None, helper_adapter=None):
    """Actual CLI, optionally with independently loaded, byte-identical helper modules."""
    script = executing / 'tools/rust-ts-r0/qualification' / reader
    if helper is None:
        return [sys.executable, '-B', str(script), *args]
    loader = (
        "import importlib.util,runpy,sys;from pathlib import Path;"
        "e,h,k=map(Path,sys.argv[1:4]);args=sys.argv[4:];"
        "prefix=Path('tools/rust-ts-r0/qualification');"
        "exec(\"def load(name,path):\\n s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);sys.modules[name]=m;s.loader.exec_module(m);return m\");"
        "load('adapt_windows_raw',k/prefix/'adapt_windows_raw.py');"
        "load('windows_token_fields',h/prefix/'windows_token_fields.py');"
        "load('adapt_windows_raw',e/prefix/'adapt_windows_raw.py');"
        "sys.path.insert(0,str(e/prefix));sys.argv=[str(e/prefix/'windows_public_fields.py'),*args];"
        "runpy.run_path(sys.argv[0],run_name='__main__')")
    return [sys.executable, '-B', '-c', loader, str(executing), str(helper), str(helper_adapter or helper), *args]


def assert_reader_refuses_before_prepare(test, command, cache, output, owners):
    before = {str(owner): a.tree(owner) for owner in owners}
    result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    report = None
    if output.is_file():
        report = json.loads(output.read_bytes())
    print(json.dumps({'reader_boundary': 'actual-cli', 'exit_code': result.returncode,
                      'cache_created': cache.exists(), 'output_created': output.exists(),
                      'output_kind': report.get('kind') if report else None,
                      'output_verdict': report.get('verdict') if report else None}), flush=True)
    try:
        test.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        test.assertIn('overlaps', result.stderr)
        test.assertFalse(cache.exists(), 'reader preparation wrote a cache before ownership refusal')
        test.assertFalse(output.exists(), 'reader published output inside a shipped source owner')
        for owner in owners:
            test.assertEqual(a.tree(owner), before[str(owner)])
    finally:
        if cache.exists():
            shutil.rmtree(cache)
        if output.exists():
            output.unlink()
    return result


class LocalWriteBoundary(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()

    def test_real_case_alias_refused_before_cache_creation(self):
        source = self.root / 'producer'
        source.mkdir()
        sentinel = source / 'untouched.txt'
        sentinel.write_bytes(b'original input')
        alias = self.root / 'PRODUCER'
        available = alias.exists()
        same = available and os.path.samefile(source, alias)
        print(json.dumps({'boundary': 'case-alias', 'alias_exists': available, 'samefile': same}), flush=True)
        if available:
            self.assertTrue(same)
        cache = alias / 'new-cache'
        with self.assertRaisesRegex(ValueError, 'overlaps'):
            a.disjoint_writes([cache], [source])
            cache.mkdir(parents=True)
        self.assertFalse((source / 'new-cache').exists())
        self.assertEqual(sentinel.read_bytes(), b'original input')

    def test_unicode_alias_and_future_parent_prefixes_refused(self):
        source = self.root / unicodedata.normalize('NFC', 'Cafe\u0301')
        source.mkdir()
        alias = self.root / unicodedata.normalize('NFD', source.name)
        if alias.exists():
            self.assertTrue(os.path.samefile(source, alias))
        for writes, inputs in (([alias / 'cache'], [source]),
                               ([self.root / 'CAFÉ'], [source / 'input.json']),
                               ([source / 'Future'], [alias / 'future/result.json']),
                               ([source / 'Future', alias / 'future/result.json'], []),
                               ([self.root / 'Future-Café', self.root / 'future-Cafe\u0301/result.json'], []),
                               ([self.root / 'Result.', self.root / 'result /child'], [])):
            with self.subTest(writes=writes), self.assertRaisesRegex(ValueError, 'overlaps'):
                a.disjoint_writes(writes, inputs)
        self.assertEqual(list(source.iterdir()), [])

    def test_existing_identity_alias_parents_and_nonoverlap_unicode(self):
        source = self.root / 'producer'
        source.mkdir()
        alias = self.root / 'PRODUCER'
        if alias.exists():
            self.assertTrue(os.path.samefile(source, alias))
        with self.assertRaisesRegex(ValueError, 'overlaps'):
            a.disjoint_writes([source / 'Future', alias / 'future/result.json'], [])
        allowed = [self.root / 'résumé-cache', self.root / '日本語-result.json']
        self.assertEqual(a.disjoint_writes(allowed, [source, self.root / 'données']), allowed)
        self.assertTrue(all(not path.exists() for path in allowed))

    def test_existing_ancestor_identity_and_prospective_tail_recorded(self):
        parent = self.root / 'producer'
        parent.mkdir()
        info = parent.lstat()
        identity = (info.st_dev, info.st_ino)
        self.assertIn((identity, ('future', 'result.json')),
                      a.local_write_locations(parent / 'Future/result.json'))
        alias = self.root / 'PRODUCER'
        alias_available = alias.exists() and os.path.samefile(parent, alias)
        print(json.dumps({'boundary': 'existing-parent-identity', 'real_alias_available': alias_available}), flush=True)
        if alias_available:
            self.assertIn((identity, ('future', 'result.json')),
                          a.local_write_locations(alias / 'Future/result.json'))
        # The identity join also covers differently spelled existing parents;
        # the folded prospective tails still decide ancestor overlap.
        self.assertTrue(a.local_write_overlap([(identity, ('future',))],
                                             [(identity, ('future', 'result.json'))]))
        self.assertFalse(a.local_write_overlap([(identity, ('future-a',))],
                                              [(identity, ('future-b',))]))
        self.assertFalse(a.local_write_overlap([(identity, ('future',))],
                                              [((info.st_dev, info.st_ino + 1), ('future', 'result.json'))]))

    def test_adapter_cli_refuses_alias_before_output_write(self):
        source = self.root / 'producer'
        source.mkdir()
        export = self.root / 'export'
        export.mkdir()
        inventory = self.root / 'inventory.json'
        inventory.write_bytes(b'{}')
        output = self.root / 'PRODUCER/new-output'
        result = subprocess.run([sys.executable, '-B', str(HERE / 'adapt_windows_raw.py'),
            '--export-root', str(export), '--inventory', str(inventory), '--inventory-sha256', a.digest(b'{}'),
            '--source-repo', str(source), '--caller-repo', str(source), '--caller-head', '1' * 40,
            '--output', str(output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('overlaps', result.stderr)
        self.assertEqual(inventory.read_bytes(), b'{}')
        self.assertEqual(list(source.iterdir()), [])


class SyntheticTransport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source_tmp = tempfile.TemporaryDirectory(prefix='genuine-source3309-test-')
        cls.addClassCleanup(cls.source_tmp.cleanup)
        cls.source_tree = Path(cls.source_tmp.name).resolve()
        archive = subprocess.check_output(['git', '-C', str(REPO), 'archive', a.SOURCE])
        with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
            for item in bundle:
                if item.isfile():
                    path = cls.source_tree / item.name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(bundle.extractfile(item).read())
        cls.source_pins = {name: ref['sha256'] for name, ref in a.tree(cls.source_tree).items()}
        cls.selected_pins = {name: sha for name, sha in cls.source_pins.items()
                             if name.startswith(('tools/gates/', 'tools/rust-ts-r0/')) or name == 'rust-toolchain.toml'}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='synthetic-windows-transport-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.export = self.root / 'export'
        self.raw = self.export / 'raw'
        self.source = self.source_tree
        self.native = 'C:\\synthetic-only\\windows-raw\\campaign'
        self.caller_head = subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', 'HEAD']).decode().strip()
        self.caller_bytes = a.git_bytes(REPO, self.caller_head, a.CALLER)
        self.output = self.root / 'transport'
        self.inventory = self.root / 'inventory.json'
        self.build_fixture()
        self.repin()

    def save(self, name, value):
        path = self.raw / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) + '\n', encoding='utf-8')

    def load(self, name):
        return json.loads((self.raw / name).read_bytes())

    def captured(self, name):
        return self.native + '\\' + name.replace('/', '\\')

    def ref(self, name):
        raw = (self.raw / name).read_bytes()
        return {'path': self.captured(name), 'sha256': a.digest(raw), 'bytes': len(raw)}

    def build_fixture(self):
        self.save('original-evidence/report.json', {'units': [{}] * 354, 'supports': [{}] * 51, 'obligations': [{}] * 240})
        supplement = {'rows': [{}] * 67, 'digest_pairs': [{}] * 5, 'addenda': [{}] * 8, 'public': {'rows': [{}] * 25}}
        self.save('supplement-evidence/supplement-report.json', supplement)
        for name in sorted(a.REPORTS - {'original-evidence/report.json', 'supplement-evidence/supplement-report.json'}):
            self.save(name, {'synthetic_fixture': True})
        for name in ('supplement-evidence/token-guards/request.json', 'supplement-evidence/token-guards/process-invocation.json',
                     'supplement-evidence/token-guards/actual-token-observations.json', 'registry.enabled.json',
                     'addenda.enabled.json', 'public-plan.json', 'recipes/replay-recipes.json', 'token-family.enabled.json',
                     'legacy-identity-inputs.json', 'native-compiler-source-identity.json'):
            self.save(name, {'synthetic_fixture': True, 'captured': self.captured('unchanged')})
        self.save('additional/report.json', {'source_head': a.SOURCE, 'platform': 'windows', 'postflight_ok': True,
                  'attempts': 1, 'expected_candidate_phases': 2, 'candidate_phases_completed': 2, 'candidate_outcomes_recorded': 2,
                  'caller_invocations_attempted': ['legacy', 'retained'], 'contexts': [{'context': 'legacy'}, {'context': 'retained'}]})
        self.save('sdk-input.json', {'synthetic_fixture': True, 'version': '5.9.3'})
        (self.raw / 'upstream-compiler-core.rs').write_bytes(b'synthetic compiler source only')
        # Synthetic SDK bytes require an explicit test-only SDK pin; production SDK remains fixed.
        self.sdk = a.digest((self.raw / 'sdk-input.json').read_bytes())
        self.old_sdk = a.SDK
        a.SDK = self.sdk
        self.addCleanup(setattr, a, 'SDK', self.old_sdk)
        fixture = {'source_head': a.SOURCE, 'platform': 'windows', 'optimized_frozen': True}
        for key in ('artifact', 'helper', 'qualification_observer', 'transport_fixture'):
            path = self.raw / ('frozen-binaries/' + key + '.exe')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'synthetic nonexecutable bytes:' + key.encode())
            fixture[key + '_path'] = self.captured(path.relative_to(self.raw).as_posix())
            fixture[key + '_sha256'] = a.digest(path.read_bytes())
        for key, name in {'sdk': 'sdk-input.json', 'recipes': 'recipes/replay-recipes.json', 'token_family': 'token-family.enabled.json',
                          'legacy_identity_inputs': 'legacy-identity-inputs.json'}.items():
            fixture[key + '_path'], fixture[key + '_sha256'] = self.captured(name), self.ref(name)['sha256']
        builds = []
        for label in ('helper-build', 'observer-build', 'standalone-restore'):
            argv = ['synthetic-never-executed', 'C:\\captured\\Cargo.toml']
            self.save(label + '.receipt.json', {'exit_code': 0, 'timed_out': False, 'attempt': 1, 'argv': argv})
            for stream in ('stdout', 'stderr'):
                (self.raw / (label + '.' + stream)).write_bytes(b'synthetic stream\r\n')
            build = {'artifact_kind': {'helper-build': 'helper', 'observer-build': 'qualification_observer', 'standalone-restore': 'artifact'}[label],
                     'argv': argv, 'receipt': self.ref(label + '.receipt.json'),
                     'stdout': self.ref(label + '.stdout'), 'stderr': self.ref(label + '.stderr')}
            builds.append(build)
        builds.append(dict(copy.deepcopy(builds[0]), artifact_kind='transport_fixture'))
        self.save('build_environment.json', {'source_head': a.SOURCE, 'state': 'frozen', 'build_commands': 3, 'builds': builds,
                  'caller': {'path': 'C:\\synthetic-tooling\\' + a.CALLER.replace('/', '\\'), 'sha256': a.digest(self.caller_bytes)}})
        fixture['build_environment_path'] = self.captured('build_environment.json')
        fixture['build_environment_sha256'] = self.ref('build_environment.json')['sha256']
        self.save('fixture.enabled.json', fixture)
        self.save('original-evidence/freeze-manifest.json', fixture)
        self.save('supplement-evidence/token-guards/process-invocation.json', {
            'argv': [fixture['artifact_path'], self.captured('supplement-evidence/token-guards/request.json'), fixture['sdk_path']],
            'cwd': self.captured('supplement-evidence/token-guards/workspace'), 'native_queries': 1})
        report = self.load('original-evidence/report.json')
        report.update({key + '_sha256': fixture[key + '_sha256'] for key in ('artifact', 'helper')})
        self.save('original-evidence/report.json', report)
        snapshot = {'source_head': a.SOURCE, 'status': '', 'files': self.selected_pins,
                    'all_tracked_files': self.source_pins}
        for name in ('source-before.json', 'source-after.json', 'source-after-finally.json'):
            self.save(name, snapshot)
        summary = {'source_head': a.SOURCE, 'qualified': False, 'qualification_credit': 0, 'R0_decision': None,
                   'attempts': 1, 'original_exit_code': 0, 'supplement_exit_code': 0,
                   'reports': {name: self.ref(name)['sha256'] for name in sorted(a.REPORTS)},
                   'additional_as_expression_witness': {k: v for k, v in self.ref('additional/report.json').items() if k != 'bytes'}}
        self.save('acquisition-summary.json', summary)
        for label in ('original', 'supplement'):
            self.save(label + '-native.receipt.json', {'exit_code': 0, 'timed_out': False, 'attempt': 1, 'argv': ['synthetic-not-run']})
        control = self.export / 'control'
        control.mkdir()
        (control / 'acquisition-state.json').write_text(json.dumps({'state': 'RAW_ACQUIRED_UNADAPTED_REVIEW_PENDING',
            'source_head': a.SOURCE, 'protocol_sha256': a.PROTOCOL, 'tooling_head': self.caller_head,
            'qualified': False, 'qualification_credit': 0, 'R0_decision': None, 'attempt': 1, 'retries': 0,
            'collector_invocations': 1, 'collector_invocation_attempts': 1, 'allowed_collection_counts': a.COUNTS,
            'raw_shape': {'counts': a.COUNTS}, 'synthetic_fixture': True}))

    def repin(self):
        spec = {'schema_version': 1, 'kind': 'WINDOWS_R0_RAW_EXPORT_INVENTORY', 'complete': True,
                'source_head': a.SOURCE, 'protocol_sha256': a.PROTOCOL, 'sdk_sha256': a.SDK, 'caller_head': self.caller_head,
                'native_raw_root': self.native, 'counts': a.COUNTS,
                'files': [{'path': name, **ref} for name, ref in a.tree(self.export).items()]}
        self.inventory.write_text(json.dumps(spec))
        self.inventory_sha = a.digest(self.inventory.read_bytes())

    def run_adapter(self):
        return a.adapt(export_root=self.export, inventory=self.inventory, inventory_sha256=self.inventory_sha,
                       source_repo=self.source, caller_repo=REPO, caller_head=self.caller_head, output=self.output)

    def mutate_inventory(self, field, value):
        spec = json.loads(self.inventory.read_bytes())
        spec[field] = value
        self.inventory.write_text(json.dumps(spec))
        self.inventory_sha = a.digest(self.inventory.read_bytes())

    def test_byte_identical_transport_and_rename_only_sidecars(self):
        before = a.tree(self.export)
        with patch.object(a.subprocess, 'check_output', wraps=subprocess.check_output) as calls:
            manifest = self.run_adapter()
        self.assertTrue(calls.call_args_list)
        self.assertTrue(all(call.args[0][0] == 'git' for call in calls.call_args_list))
        self.assertEqual(a.tree(self.export), before)
        self.assertEqual(set(manifest['hosts']), {'windows'})
        self.assertIs(manifest['qualified'], False)
        host = manifest['hosts']['windows']
        self.assertEqual(Path(host['native_compiler_identity']['build_environment']['path']).read_bytes(), (self.raw / 'build_environment.json').read_bytes())
        for ref in host['build_receipts']:
            receipt = json.loads(Path(ref['path']).read_bytes())
            self.assertEqual(receipt['exitCode'], 0)
            self.assertNotIn('exit_code', receipt)
        self.assertEqual(json.loads(Path(host['source']['before']['path']).read_bytes())['head'], a.SOURCE)
        self.assertEqual((self.output / 'view/evidence/token-guards/request.json').read_bytes(),
                         (self.raw / 'supplement-evidence/token-guards/request.json').read_bytes())
        self.assertEqual((self.output / 'view/public-plan.json').read_bytes(), (self.raw / 'public-plan.json').read_bytes())
        ledger = json.loads((self.output / 'transport-ledger.json').read_bytes())
        self.assertEqual(len(ledger['derivations']), 5)
        for entry in ledger['derivations']:
            raw = json.loads(Path(entry['raw_path']).read_bytes())
            actual = json.loads(Path(entry['derived_path']).read_bytes())
            aliases = ({'source_head': 'head'} if Path(entry['raw_path']).name.startswith('source-')
                       else {'exit_code': 'exitCode', 'timed_out': 'timedOut'})
            wanted = copy.deepcopy(raw)
            for old, new in aliases.items():
                wanted[new] = wanted.pop(old)
            self.assertEqual(actual, wanted)
            self.assertEqual(entry['operation'], {'rename': aliases})
            self.assertEqual(entry['raw_sha256'], a.digest(Path(entry['raw_path']).read_bytes()))
            self.assertEqual(entry['derived_sha256'], a.digest(Path(entry['derived_path']).read_bytes()))
            self.assertEqual(entry['raw_keyset'], sorted(raw))
            self.assertEqual(entry['derived_keyset'], sorted(actual))
        expected_destinations = {}
        for name, ref in before.items():
            dest = self.output / 'view' / name[4:] if name.startswith('raw/') else self.output / name
            expected_destinations[str(dest)] = (str(self.export / name), name, ref)
            if name.startswith('raw/supplement-evidence/'):
                dest = self.output / 'view/evidence' / name.removeprefix('raw/supplement-evidence/')
                expected_destinations[str(dest)] = (str(self.export / name), name, ref)
        self.assertEqual({entry['path'] for entry in ledger['origins']}, set(expected_destinations))
        for entry in ledger['origins']:
            origin, name, ref = expected_destinations[entry['path']]
            self.assertEqual(entry, {'origin': origin, 'member': name, 'path': entry['path'], **ref})
            self.assertEqual(Path(entry['path']).read_bytes(), Path(origin).read_bytes())
            self.assertEqual(a.digest(Path(entry['path']).read_bytes()), entry['sha256'])
            self.assertNotEqual(Path(entry['origin']).stat().st_ino, Path(entry['path']).stat().st_ino)

    def test_missing_required_evidence_rejected(self):
        (self.raw / 'supplement-evidence/token-guards/request.json').unlink()
        self.repin()
        with self.assertRaises(OSError):
            self.run_adapter()
        self.assertFalse(self.output.exists())

    def test_native_references_reject_nonliteral_prefix_and_structure(self):
        original = self.load('fixture.enabled.json')
        captured = original['artifact_path']
        mutations = [captured.replace('C:', 'c:', 1),
                     captured.replace('synthetic-only', 'SYNTHETIC-ONLY', 1),
                     captured.replace('\\frozen-binaries', '\\.\\frozen-binaries', 1),
                     captured.replace('\\frozen-binaries', '\\\\frozen-binaries', 1)]
        for changed in mutations:
            with self.subTest(changed=changed):
                fixture = dict(original, artifact_path=changed)
                self.save('fixture.enabled.json', fixture)
                self.save('original-evidence/freeze-manifest.json', fixture)
                self.repin()
                try:
                    with self.assertRaisesRegex(ValueError, 'captured.*spelling'):
                        self.run_adapter()
                finally:
                    if self.output.exists():
                        shutil.rmtree(self.output)

    def test_native_root_rejects_dot_repeated_and_case_prefix(self):
        for root in (self.native + '\\.', self.native.replace('\\windows-raw', '\\\\windows-raw', 1),
                     self.native.replace('C:', 'c:', 1)):
            with self.subTest(root=root):
                self.repin()
                self.mutate_inventory('native_raw_root', root)
                try:
                    with self.assertRaisesRegex(ValueError, 'captured.*spelling'):
                        self.run_adapter()
                finally:
                    if self.output.exists():
                        shutil.rmtree(self.output)

    def test_literal_mixed_separators_are_preserved(self):
        fixture = self.load('fixture.enabled.json')
        mixed = fixture['artifact_path'].replace('\\windows-raw\\', '/windows-raw\\', 1)
        fixture['artifact_path'] = mixed
        self.save('fixture.enabled.json', fixture)
        self.save('original-evidence/freeze-manifest.json', fixture)
        self.repin()
        self.mutate_inventory('native_raw_root', self.native.replace('\\windows-raw\\', '/windows-raw\\', 1))
        manifest = self.run_adapter()
        actual = json.loads(Path(manifest['hosts']['windows']['supplement']['fixture']['path']).read_bytes())
        self.assertEqual(actual['artifact_path'], mixed)
        self.assertEqual((self.output / 'view/fixture.enabled.json').read_bytes(), (self.raw / 'fixture.enabled.json').read_bytes())

    def test_native_root_spelling_rejected_with_consistent_references(self):
        original = self.native
        for root in (original + '\\.', original.replace('\\windows-raw', '\\\\windows-raw', 1)):
            with self.subTest(root=root):
                shutil.rmtree(self.export)
                self.native = root
                self.build_fixture()
                self.repin()
                try:
                    with self.assertRaisesRegex(ValueError, 'captured.*spelling'):
                        self.run_adapter()
                finally:
                    if self.output.exists():
                        shutil.rmtree(self.output)

    def test_adapter_cli_protects_its_actual_executing_checkout(self):
        import run_windows_milestone as milestone
        restored = self.root / 'public-sdk'
        restored.mkdir()
        milestone.restore_public_inputs(REPO, restored)
        a.SDK = self.old_sdk
        (self.raw / 'sdk-input.json').write_bytes((restored / 'sdk-input.json').read_bytes())
        fixture = self.load('fixture.enabled.json')
        fixture['sdk_sha256'] = a.SDK
        self.save('fixture.enabled.json', fixture)
        self.save('original-evidence/freeze-manifest.json', fixture)
        self.repin()
        executing_repo = self.root / 'readback'
        script = executing_repo / 'tools/rust-ts-r0/qualification/adapt_windows_raw.py'
        script.parent.mkdir(parents=True)
        script.write_bytes((HERE / 'adapt_windows_raw.py').read_bytes())
        subprocess.run(['git', 'init', '-q', str(executing_repo)], check=True)
        caller = self.root / 'separate-caller'
        caller.mkdir()
        gitdir = subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', '--absolute-git-dir']).decode().strip()
        (caller / '.git').write_text('gitdir: ' + gitdir + '\n')
        standalone = self.root / 'standalone-adapter.py'
        standalone.write_bytes(script.read_bytes())
        misleading_git = dict(os.environ, GIT_DIR=gitdir, GIT_WORK_TREE=str(caller))
        for executable, owner, environment in ((script, executing_repo, None),
                                                (script, executing_repo, misleading_git),
                                                (standalone, self.root, None)):
            with self.subTest(executable=executable, misleading_git=environment is not None):
                output = owner / 'fresh-output'
                before = a.tree(owner)
                command = [sys.executable, '-B', str(executable), '--export-root', str(self.export),
                           '--inventory', str(self.inventory), '--inventory-sha256', self.inventory_sha,
                           '--source-repo', str(self.source), '--caller-repo', str(caller),
                           '--caller-head', self.caller_head, '--output', str(output)]
                result = subprocess.run(command, capture_output=True, text=True, env=environment)
                try:
                    self.assertEqual(result.returncode, 1, result.stderr)
                    self.assertIn('overlaps', result.stderr)
                    self.assertFalse(output.exists())
                    self.assertEqual(a.tree(owner), before)
                finally:
                    if output.exists():
                        shutil.rmtree(output)

    def test_changed_raw_hash_rejected(self):
        (self.raw / 'helper-build.stdout').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'inventory'):
            self.run_adapter()

    def test_coexisting_alias_failed_bool_missing_receipt_rejected(self):
        original = self.load('helper-build.receipt.json')
        for receipt in (dict(original, exitCode=0), dict(original, timedOut=False), dict(original, exit_code=True),
                        dict(original, exit_code=1), {k: v for k, v in original.items() if k != 'timed_out'}):
            with self.subTest(receipt=receipt):
                self.save('helper-build.receipt.json', receipt)
                self.repin()
                with self.assertRaises(ValueError):
                    self.run_adapter()
                self.assertFalse(self.output.exists())

    def test_pinned_source_protocol_sdk_caller_counts_complete_rejected(self):
        for field, value in [('source_head', 'a' * 40), ('protocol_sha256', 'b' * 64), ('sdk_sha256', 'c' * 64),
                             ('caller_head', 'd' * 40), ('counts', dict(a.COUNTS, as_expression=3)), ('complete', False)]:
            with self.subTest(field=field):
                self.repin()
                self.mutate_inventory(field, value)
                with self.assertRaises(ValueError):
                    self.run_adapter()

    def test_collision_foreign_output_and_inventory_traversal_rejected(self):
        self.output.mkdir()
        with self.assertRaisesRegex(ValueError, 'collision'):
            self.run_adapter()
        self.output.rmdir()
        self.output = self.source / 'child'
        with self.assertRaisesRegex(ValueError, 'overlaps'):
            self.run_adapter()
        self.output = self.root / 'transport'
        spec = json.loads(self.inventory.read_bytes())
        spec['files'][0]['path'] = 'raw/../escape'
        self.mutate_inventory('files', spec['files'])
        with self.assertRaisesRegex(ValueError, 'unsafe'):
            self.run_adapter()

    def test_lexical_archive_metadata_preserved_without_restoring_links(self):
        path = self.export / 'ARCHIVE-LINKS.json'
        path.write_text(json.dumps({'schema_version': 1, 'representation': 'lexical_links', 'targets_read': False,
            'native_links_in_zip': False, 'links': [{'archive_path': 'raw/supplement-evidence/public/invocations/example/input',
            'native_path': self.captured('supplement-evidence/public/invocations/example/input'),
            'target': 'C:\\captured\\fixture', 'link_type': 'junction', 'capture_stable': True,
            'stat': {key: 0 for key in ('mode', 'device', 'inode', 'size', 'mtime_ns', 'ctime_ns', 'file_attributes', 'reparse_tag')}}]}))
        self.repin()
        self.run_adapter()
        self.assertEqual(path.read_bytes(), (self.output / 'ARCHIVE-LINKS.json').read_bytes())
        self.assertFalse((self.output / 'view/supplement-evidence/public/invocations/example/input').exists())

    def test_duplicate_json_and_symlink_hardlink_rejected(self):
        self.inventory.write_bytes(b'{"complete":true,"complete":true}')
        self.inventory_sha = a.digest(self.inventory.read_bytes())
        with self.assertRaisesRegex(ValueError, 'duplicate JSON'):
            self.run_adapter()
        self.repin()
        os.symlink(self.raw / 'sdk-input.json', self.raw / 'foreign-link')
        with self.assertRaisesRegex(ValueError, 'link'):
            self.run_adapter()
        (self.raw / 'foreign-link').unlink()
        os.link(self.raw / 'sdk-input.json', self.root / 'hardlink')
        with self.assertRaisesRegex(ValueError, 'hardlink'):
            self.run_adapter()

    def test_provided_source_subset_cannot_replace_complete_git_tree(self):
        for name in ('source-before.json', 'source-after.json', 'source-after-finally.json'):
            snapshot = self.load(name)
            snapshot['all_tracked_files'] = {'rust-toolchain.toml': self.source_pins['rust-toolchain.toml']}
            snapshot['files'] = dict(snapshot['all_tracked_files'])
            self.save(name, snapshot)
        self.repin()
        with self.assertRaisesRegex(ValueError, 'trusted Git tree'):
            self.run_adapter()
        self.assertFalse(self.output.exists())

    def test_lexical_links_cannot_shadow_regular_windows_casefolded_member(self):
        path = self.export / 'ARCHIVE-LINKS.json'
        path.write_text(json.dumps({'schema_version': 1, 'representation': 'lexical_links', 'targets_read': False,
            'native_links_in_zip': False, 'links': [{'archive_path': 'raw/SDK-INPUT.JSON',
            'native_path': self.captured('SDK-INPUT.JSON'), 'target': 'C:\\captured\\fixture',
            'link_type': 'junction', 'capture_stable': True,
            'stat': {key: 0 for key in ('mode', 'device', 'inode', 'size', 'mtime_ns', 'ctime_ns', 'file_attributes', 'reparse_tag')}}]}))
        self.repin()
        with self.assertRaisesRegex(ValueError, 'lexical link metadata'):
            self.run_adapter()
        self.assertFalse(self.output.exists())

    def test_source_alias_and_raw_caller_sha_drift_rejected(self):
        for name in ('source-before.json', 'source-after.json', 'source-after-finally.json'):
            snapshot = self.load(name)
            snapshot['head'] = a.SOURCE
            self.save(name, snapshot)
        self.repin()
        with self.assertRaisesRegex(ValueError, 'source epoch/aliases'):
            self.run_adapter()
        for name in ('source-before.json', 'source-after.json', 'source-after-finally.json'):
            snapshot = self.load(name)
            del snapshot['head']
            self.save(name, snapshot)
        environment = self.load('build_environment.json')
        environment['caller']['sha256'] = 'e' * 64
        self.save('build_environment.json', environment)
        fixture = self.load('fixture.enabled.json')
        fixture['build_environment_sha256'] = self.ref('build_environment.json')['sha256']
        self.save('fixture.enabled.json', fixture)
        self.repin()
        with self.assertRaisesRegex(ValueError, 'raw caller differs'):
            self.run_adapter()
        self.assertFalse(self.output.exists())

    def test_captured_foreign_path_and_source_drift_rejected(self):
        fixture = self.load('fixture.enabled.json')
        fixture['artifact_path'] = 'C:\\foreign\\artifact.exe'
        self.save('fixture.enabled.json', fixture)
        self.save('original-evidence/freeze-manifest.json', fixture)
        report = self.load('original-evidence/report.json')
        report.update({key + '_sha256': fixture[key + '_sha256'] for key in ('artifact', 'helper')})
        self.save('original-evidence/report.json', report)
        self.repin()
        with self.assertRaisesRegex(ValueError, 'outside raw'):
            self.run_adapter()
        changed = self.source / 'rust-toolchain.toml'
        original = changed.read_bytes()
        self.addCleanup(changed.write_bytes, original)
        changed.write_bytes(b'changed local source')
        with self.assertRaisesRegex(ValueError, 'source snapshot'):
            self.run_adapter()


    def test_windows_namespace_component_collisions_and_names(self):
        for name in ('raw/CON', 'raw/nul.txt', 'raw/COM1.json', 'raw/trailing.', 'raw/trailing ', 'raw/bad\x01', 'raw/a?b'):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'unsafe'):
                a.member(name)
        self.assertEqual(str(a.member('raw/élève/日本語.json')), 'raw/élève/日本語.json')
        for names in (['raw/Foo/a', 'raw/foo/b'], ['raw/a', 'raw/a/b']):
            with self.subTest(names=names), self.assertRaisesRegex(ValueError, 'namespace'):
                a.namespace(names)

    def registration_fixture(self, include_public=False):
        """Temporary synthetic W Git authority, never a production admission."""
        self.wrepo = self.root / 'synthetic-W'
        self.wrepo.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.wrepo)], check=True)
        relatives = list(a.READBACK_FILES.values()) + ([PUBLIC_READER] if include_public else [])
        for relative in relatives:
            target = self.wrepo / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((REPO / relative).read_bytes())
        subprocess.run(['git', '-C', str(self.wrepo), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.wrepo), '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
                        '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic unqualified test only'], check=True)
        head = subprocess.check_output(['git', '-C', str(self.wrepo), 'rev-parse', 'HEAD']).decode().strip()
        reg = {'readback_head': head, 'source_head': a.SOURCE, 'protocol_sha256': a.PROTOCOL, 'sdk_sha256': a.SDK,
               'caller_head': self.caller_head, 'coordinates': [[232, 1], [234, 1], [238, 1]],
               'expected_request_relative': 'supplement-evidence/token-guards/request.json', 'output_relative': 'windows-raw/campaign',
               **{field: a.digest((self.wrepo / relative).read_bytes()) for field, relative in a.READBACK_FILES.items()}}
        if include_public:
            import windows_public_fields as public
            reg['public_bindings'] = {
                'public_reader_sha256': a.digest((self.wrepo / PUBLIC_READER).read_bytes()),
                'public_coordinates': json.dumps([list(c) for c in public.COORDINATES], separators=(',', ':')),
                'public_support_ids': json.dumps(list(public.SUPPORTS), separators=(',', ':'))}
        self.regpath = self.root / 'registration.json'
        self.regpath.write_text(json.dumps(reg))
        return reg

    def verify(self, **overrides):
        def pin(path): return {'path': str(path), 'sha256': a.digest(path.read_bytes())}
        args = dict(manifest=pin(self.output / 'manifest.json'), ledger=pin(self.output / 'transport-ledger.json'),
                    inventory=pin(self.inventory), registration=pin(self.regpath), export_root=self.export,
                    source_repo=self.source, caller_repo=REPO, readback_repo=self.wrepo,
                    cache=self.root / 'cache', output=self.root / 'result.json')
        args.update(overrides)
        return a.verify_transport(**args)

    def test_verified_custody_rejects_changed_view_sidecar_and_ledger(self):
        self.run_adapter()
        self.registration_fixture()
        self.assertEqual(self.verify()['manifest']['hosts']['windows']['raw_root'], str(self.output / 'view'))
        paths = [self.output / 'view/evidence/token-guards/request.json',
                 self.output / 'derived/helper-build.receipt.json', self.output / 'transport-ledger.json']
        for path in paths:
            with self.subTest(path=path):
                original = path.read_bytes()
                value = json.loads(original)
                value['nonrenamed_value'] = 'tampered'
                path.write_text(json.dumps(value))
                with self.assertRaisesRegex(ValueError, 'transport'):
                    self.verify()
                path.write_bytes(original)

    def test_verified_custody_rejects_T_W_binding_and_cache_overlap(self):
        self.run_adapter()
        reg = self.registration_fixture()
        for field in ('caller_head', 'adapter_sha256', 'verifier_sha256', 'readback_head'):
            with self.subTest(field=field):
                faulty = dict(reg, **{field: '0' * len(reg[field])})
                self.regpath.write_text(json.dumps(faulty))
                with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                    self.verify()
        self.regpath.write_text(json.dumps(reg))
        for cache, output in ((self.output / 'view/cache', self.root / 'result.json'),
                              (self.root / 'cache', self.root / 'cache/result.json')):
            with self.subTest(cache=cache), self.assertRaisesRegex(ValueError, 'overlaps'):
                self.verify(cache=cache, output=output)


    def reader_cli_fixture(self, include_public=False):
        import gzip
        import run_windows_milestone as milestone
        compressed = (HERE / 'windows-token-fields-test-protocol.json.gz').read_bytes()
        self.assertEqual(a.digest(compressed), 'b13db48ed19fcf97fa951f63b12b0945c0340257e0539c4fcf6fbfc25a507cbe')
        protocol_raw = gzip.decompress(compressed)
        self.assertEqual(a.digest(protocol_raw), a.PROTOCOL)
        protocol = self.root / 'protocol.json'
        protocol.write_bytes(protocol_raw)
        restored = self.root / 'public-inputs'
        restored.mkdir()
        restored_receipt = milestone.restore_public_inputs(REPO, restored)
        self.assertEqual(restored_receipt['sdk_sha256'], self.old_sdk)
        sdk_raw = (restored / 'sdk-input.json').read_bytes()
        a.SDK = self.old_sdk
        self.assertEqual(a.digest(sdk_raw), a.SDK)
        (self.raw / 'sdk-input.json').write_bytes(sdk_raw)
        fixture = self.load('fixture.enabled.json')
        fixture['sdk_sha256'] = a.SDK
        self.save('fixture.enabled.json', fixture)
        self.save('original-evidence/freeze-manifest.json', fixture)
        self.repin()
        raw_before = a.tree(self.export)
        manifest = self.run_adapter()
        self.registration_fixture(include_public=include_public)
        context = self.verify()
        self.assertEqual(context['manifest'], manifest)
        # Only Git-object resolution uses this pointer; authored Git33 bytes stay unchanged.
        gitdir = subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', '--absolute-git-dir']).decode().strip()
        gitfile = self.source / '.git'
        gitfile.write_text('gitdir: ' + gitdir + '\n')
        self.addCleanup(gitfile.unlink)
        spec = importlib.util.spec_from_file_location('synthetic_final_join', HERE / 'property_assessor/final_join.py')
        join = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(join)
        _, identity = join.validate_host_epoch(manifest['hosts']['windows'], a.SOURCE, 'windows')
        baseline = json.loads(protocol_raw)['baseline_rows']
        rows = []
        for original in baseline:
            row = {key: copy.deepcopy(original[key]) for key in ('kind', 'coordinate', 'support_id') if key in original}
            row['hosts'] = {'windows': {'state': 'GAP', 'gap': 'SYNTHETIC_NO_NATIVE_OBSERVATIONS'}}
            rows.append(row)
        c4 = {'kind': 'DETERMINISTIC_CURRENT_FIELD_ASSESSMENT', 'candidate_head': a.SOURCE,
              'rows': rows, 'host_bindings': {'windows': identity}, 'qualified': False,
              'qualification_credit': 0, 'R0_decision': None, 'evaluation_protocol_ref': {'sha256': a.PROTOCOL}}
        c4path = self.root / 'c4.json'
        c4path.write_text(json.dumps(c4))
        args = ['--repo', str(self.source), '--readback-repo', str(self.wrepo), '--caller-repo', str(REPO),
                '--export-root', str(self.export), '--protocol', str(protocol), '--protocol-sha256', a.PROTOCOL,
                '--cache', str(self.root / 'cache'), '--output', str(self.root / 'result.json')]
        for name, path in [('manifest', self.output / 'manifest.json'), ('ledger', self.output / 'transport-ledger.json'),
                           ('registration', self.regpath), ('inventory', self.inventory), ('c4-assessment', c4path)]:
            args += ['--' + name, str(path), '--' + name + '-sha256', a.digest(path.read_bytes())]
        return args, raw_before, c4, c4path

    def test_complete_synthetic_adapter_custody_reader_cli(self):
        args, raw_before, c4, c4path = self.reader_cli_fixture()
        command = [sys.executable, '-B', str(self.wrepo / a.READBACK_FILES['verifier_sha256']), *args]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertTrue((self.root / 'result.json').is_file(), result.stderr)
        answer = json.loads((self.root / 'result.json').read_bytes())
        self.assertEqual(answer['verdict'], 'WINDOWS_TOKEN_FIELDS_GAP')
        self.assertEqual(answer['gap'], "'execution_enabled'")
        self.assertFalse(answer['qualified'])
        self.assertEqual(answer['qualification_credit'], 0)
        self.assertIsNone(answer['R0_decision'])
        self.assertEqual(answer['freeze']['verifier_sha256'], a.digest((self.wrepo / a.READBACK_FILES['verifier_sha256']).read_bytes()))
        self.assertEqual(len(answer['freeze']['source_joins']), 139)
        self.assertEqual(a.tree(self.export), raw_before)

        self.assertEqual(answer['request_path_comparison']['raw'], self.captured('supplement-evidence/token-guards/request.json'))
        # A different C4 campaign must never be joined by source/protocol alone.
        c4['host_bindings']['windows']['references']['supplement.fixture']['sha256'] = 'foreign'
        c4path.write_text(json.dumps(c4))
        bad_command = list(command)
        bad_command[bad_command.index('--c4-assessment-sha256') + 1] = a.digest(c4path.read_bytes())
        bad_command[bad_command.index('--cache') + 1] = str(self.root / 'foreign-cache')
        bad_command[bad_command.index('--output') + 1] = str(self.root / 'foreign-result.json')
        bad = subprocess.run(bad_command, capture_output=True, text=True)
        self.assertEqual(bad.returncode, 1, bad.stderr)
        foreign = json.loads((self.root / 'foreign-result.json').read_bytes())
        self.assertEqual(foreign['gap'], 'C4 host binding differs')
        self.assertEqual(a.tree(self.export), raw_before)


    def test_full_reader_clis_protect_actual_executing_checkout(self):
        args, raw_before, _, _ = self.reader_cli_fixture(include_public=True)
        executing = synthetic_code_checkout(self.root / 'actual-executing-E')
        for reader, kind in (('windows_token_fields.py', 'SUPPLEMENTARY_WINDOWS_TOKEN_FIELDS'),
                             ('windows_public_fields.py', 'SUPPLEMENTARY_WINDOWS_PUBLIC_FIELDS')):
            cache, output = self.root / 'external-full-cache', self.root / 'external-full-result.json'
            current = list(args)
            current[current.index('--cache') + 1] = str(cache)
            current[current.index('--output') + 1] = str(output)
            result = subprocess.run(actual_reader_command(reader, executing, current), capture_output=True,
                                    text=True, timeout=60)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertTrue(output.is_file(), result.stderr)
            answer = json.loads(output.read_bytes())
            self.assertEqual(answer['kind'], kind)
            self.assertTrue(answer['verdict'].endswith('_GAP'))
            self.assertFalse(answer['qualified'])
            self.assertEqual(answer['qualification_credit'], 0)
            self.assertIsNone(answer['R0_decision'])
            shutil.rmtree(cache)
            output.unlink()
            for cache, output in ((executing / 'full-cache', self.root / 'full-result.json'),
                                  (self.root / 'full-cache', executing / 'full-result.json')):
                with self.subTest(reader=reader, cache=cache, output=output):
                    current = list(args)
                    current[current.index('--cache') + 1] = str(cache)
                    current[current.index('--output') + 1] = str(output)
                    assert_reader_refuses_before_prepare(self, actual_reader_command(reader, executing, current),
                                                         cache, output, [executing])
            self.assertEqual(a.tree(self.export), raw_before)

    def test_verify_transport_protects_its_actual_helper_checkout(self):
        self.reader_cli_fixture()
        executing = synthetic_code_checkout(self.root / 'actual-adapter-E')
        def pin(path):
            return {'path': str(path), 'sha256': a.digest(path.read_bytes())}
        arguments = dict(manifest=pin(self.output / 'manifest.json'), ledger=pin(self.output / 'transport-ledger.json'),
                         inventory=pin(self.inventory), registration=pin(self.regpath), export_root=str(self.export),
                         source_repo=str(self.source), caller_repo=str(REPO), readback_repo=str(self.wrepo))
        launcher = ("import json,sys;sys.path.insert(0,sys.argv[1]);import adapt_windows_raw as a;"
                    "a.verify_transport(**json.loads(sys.argv[2]));print('ACTUAL_TRANSPORT_VERIFIED')")
        def command(cache, output):
            return [sys.executable, '-B', '-c', launcher, str(executing / 'tools/rust-ts-r0/qualification'),
                    json.dumps(dict(arguments, cache=str(cache), output=str(output)))]
        cache, output = self.root / 'external-cache', self.root / 'external-result.json'
        positive = subprocess.run(command(cache, output), capture_output=True, text=True, timeout=60)
        self.assertEqual(positive.returncode, 0, positive.stderr)
        self.assertIn('ACTUAL_TRANSPORT_VERIFIED', positive.stdout)
        for cache, output in ((executing / 'new-cache', self.root / 'result.json'),
                              (self.root / 'new-cache', executing / 'new-output.json')):
            with self.subTest(cache=cache):
                assert_reader_refuses_before_prepare(self, command(cache, output), cache, output, [executing])


    def test_verified_input_links_hardlinks_extra_files_refused(self):
        self.run_adapter()
        self.registration_fixture()
        target = self.output / 'view/evidence/token-guards/request.json'
        original = target.read_bytes()
        external = self.root / 'external.json'
        external.write_bytes(original)
        target.unlink()
        os.symlink(external, target)
        with self.assertRaisesRegex(ValueError, 'link'):
            self.verify()
        target.unlink()
        os.link(external, target)
        with self.assertRaisesRegex(ValueError, 'hardlink'):
            self.verify()
        target.unlink()
        target.write_bytes(original)
        extra = self.output / 'view/extra.json'
        extra.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'file set'):
            self.verify()


    def test_lexical_link_view_alias_component_collision_refused(self):
        link = {'archive_path': 'raw/evidence/TOKEN-GUARDS/foreign',
                'native_path': self.captured('evidence/TOKEN-GUARDS/foreign'), 'target': 'C:\\captured\\fixture',
                'link_type': 'junction', 'capture_stable': True,
                'stat': {key: 0 for key in ('mode', 'device', 'inode', 'size', 'mtime_ns', 'ctime_ns', 'file_attributes', 'reparse_tag')}}
        (self.export / 'ARCHIVE-LINKS.json').write_text(json.dumps({'schema_version': 1,
            'representation': 'lexical_links', 'targets_read': False, 'native_links_in_zip': False, 'links': [link]}))
        self.repin()
        with self.assertRaisesRegex(ValueError, 'namespace'):
            self.run_adapter()
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
