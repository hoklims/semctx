"""Synthetic transport fixtures only; these never establish Windows qualification."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import tarfile
import unittest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('windows_adapter', HERE / 'adapt_windows_raw.py')
a = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(a)
REPO = HERE.parents[2]


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
        self.native = 'C:\\synthetic-only\\raw'
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
        self.save('sdk-input.json', {'synthetic_fixture': True})
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
        manifest = self.run_adapter()
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
        self.assertEqual(ledger['native_replays'], 0)
        self.assertEqual(len(ledger['derivations']), 5)
        for entry in ledger['origins']:
            self.assertEqual(a.digest(Path(entry['path']).read_bytes()), entry['sha256'])
            self.assertNotEqual(Path(entry['origin']).stat().st_ino, Path(entry['path']).stat().st_ino)

    def test_missing_required_evidence_rejected(self):
        (self.raw / 'supplement-evidence/token-guards/request.json').unlink()
        self.repin()
        with self.assertRaises(OSError):
            self.run_adapter()
        self.assertFalse(self.output.exists())

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


if __name__ == '__main__':
    unittest.main()
