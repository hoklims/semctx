"""Pure receipt-binding controls. Synthetic executor is not native Cargo evidence."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import native_build_identity as n


class NativeBuildIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repo, self.out = self.root/'repo', self.root/'evidence'
        self.repo.mkdir(); self.out.mkdir()
        source = self.repo/'tools/rust-ts-r0/src/lib.rs'
        source.parent.mkdir(parents=True); source.write_text('pub const DEV: u8 = 1;\n')
        helper = self.repo/'tools/rust-ts-r0/qualification/native_compiler_identity.py'
        helper.parent.mkdir(parents=True); helper.write_text('# DEV source helper\n')
        self.caller = self.repo/'caller.py'; self.caller.write_text('# DEV caller\n')
        self.env = dict(__import__('os').environ)
        for key in ['GOPORT_BUILD_VERSION', 'GIT_CONFIG_GLOBAL', 'CARGO_TARGET_DIR']: self.env.pop(key, None)
        self.env.update(RUSTUP_TOOLCHAIN='1.95.0', RUST_TEST_THREADS='1', CARGO_BUILD_JOBS='2',
                        CARGO_NET_OFFLINE='true', GOPORT_LIB_PARSE_SNAPSHOT='0', GOPORT_LIB_SNAPSHOT='0')
        def git(*args): return subprocess.check_output(['git', '-C', str(self.repo), *args], env=self.env)
        git('init', '-q'); git('add', '.')
        git('-c', 'user.name=DEV', '-c', 'user.email=dev@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'DEV')
        self.head = git('rev-parse', 'HEAD').decode().strip()
        (self.out/'upstream-compiler-core.rs').write_bytes(b'DEV VERSION SOURCE ONLY')
        (self.out/'native-compiler-source-identity.json').write_text(json.dumps({
            'source_sha256': n.sha(self.out/'upstream-compiler-core.rs'),
            'GOPORT_BUILD_VERSION_present_in_build_environment': False}))

    def tearDown(self): self.temporary.cleanup()

    def begin(self): return n.NativeBuildIdentity(self.repo, self.out, self.env, self.head, self.caller)

    def argv(self, label):
        if label == 'helper-build': return ['cargo', 'build', '--locked', '--offline', '--release', '--bins', '--manifest-path', 'tools/gates/Cargo.toml']
        if label == 'observer-build': return ['cargo', 'test', '--locked', '--offline', '--release', '--features', 'qualification-observer', '--test', 'qualification_replay', '--no-run', '--message-format=json', '--manifest-path', 'tools/rust-ts-r0/Cargo.toml']
        return ['cargo', 'build', '--locked', '--offline', '--release', '--bin', 'semctx-r0-probe', '--manifest-path', 'tools/rust-ts-r0/Cargo.toml']

    def executor(self, label, argv, env):
        self.assertIs(env, self.env)
        receipt = {'argv': argv, 'exit_code': 0, 'timed_out': False}
        (self.out/(label+'.receipt.json')).write_text(json.dumps(receipt))
        stdout = json.dumps({'reason':'compiler-artifact', 'target':{'name':'qualification_replay'},
                             'executable':str(self.out/'qualification_observer')}) if label == 'observer-build' else 'DEV SYNTHETIC BUILD\n'
        (self.out/(label+'.stdout')).write_text(stdout); (self.out/(label+'.stderr')).write_bytes(b'')
        for kind in {'helper-build':['helper','transport_fixture'], 'observer-build':['qualification_observer'], 'standalone-restore':['artifact']}[label]:
            (self.out/kind).write_text('DEV artifact '+kind)
        return receipt

    def complete(self):
        identity = self.begin()
        for label, kinds in [('helper-build',['helper','transport_fixture']), ('observer-build',['qualification_observer']), ('standalone-restore',['artifact'])]:
            identity.run(label,self.argv(label),self.executor)
            for kind in kinds: identity.bind_artifact(kind,label,self.out/kind)
        fixture = {}
        for kind in ['artifact','helper','transport_fixture','qualification_observer']:
            target = self.out/('frozen-'+kind); shutil.copyfile(self.out/kind,target)
            fixture[kind+'_path'], fixture[kind+'_sha256'] = str(target), n.sha(target)
        return identity, fixture

    def test_complete_binding_joins_all_actual_receipts_and_frozen_bytes(self):
        identity, fixture = self.complete(); result = identity.finalize(fixture)
        document = json.loads(Path(result['path']).read_text())
        self.assertEqual(document['state'],'frozen')
        self.assertEqual(document['build_commands'],3)
        self.assertEqual(len(document['builds']),4)
        self.assertEqual(document['artifact_sha256'],fixture['artifact_sha256'])
        self.assertEqual(document['build_environment_before'],document['build_environment_after'])

    def test_empty_version_override_is_still_rejected_before_receipt(self):
        self.env['GOPORT_BUILD_VERSION']=''
        with self.assertRaisesRegex(ValueError,'override must be absent'): self.begin()
        self.assertFalse((self.out/'build_environment.json').exists())

    def test_unlisted_secret_is_never_exported(self):
        self.env['UNRELATED_API_SECRET']='SENSITIVE_NEVER_EXPORT_THIS'
        identity, fixture=self.complete(); identity.finalize(fixture)
        value=(self.out/'build_environment.json').read_text()
        self.assertNotIn('UNRELATED_API_SECRET',value); self.assertNotIn('SENSITIVE_NEVER_EXPORT_THIS',value)

    def test_passed_environment_drift_refuses_successful_build(self):
        identity=self.begin()
        def changed(label,argv,env):
            value=self.executor(label,argv,env);env['CARGO_BUILD_JOBS']='3';return value
        with self.assertRaisesRegex(ValueError,'environment changed'): identity.run('helper-build',self.argv('helper-build'),changed)

    def test_source_drift_refuses_successful_build(self):
        identity=self.begin()
        def changed(label,argv,env):
            value=self.executor(label,argv,env)
            (self.repo/'tools/rust-ts-r0/src/lib.rs').write_text('pub const DEV: u8 = 2;\n');return value
        with self.assertRaisesRegex(ValueError,'HEAD/status'): identity.run('helper-build',self.argv('helper-build'),changed)

    def test_wrong_build_receipt_argv_is_rejected(self):
        identity=self.begin()
        def changed(label,argv,env):
            value=self.executor(label,argv,env);value['argv']=['cargo','wrong'];(self.out/(label+'.receipt.json')).write_text(json.dumps(value));return value
        with self.assertRaisesRegex(ValueError,'receipt argv differs'): identity.run('helper-build',self.argv('helper-build'),changed)

    def test_frozen_artifact_mismatch_is_rejected(self):
        identity,fixture=self.complete();Path(fixture['artifact_path']).write_bytes(b'DRIFT')
        with self.assertRaisesRegex(ValueError,'frozen artifact/build mismatch'): identity.finalize(fixture)

    def test_changed_compiler_source_identity_is_rejected(self):
        identity=self.begin();(self.out/'upstream-compiler-core.rs').write_bytes(b'DRIFT')
        with self.assertRaisesRegex(ValueError,'source identity/core changed'): identity.run('helper-build',self.argv('helper-build'),self.executor)

    def test_failed_or_timed_out_build_never_gets_frozen(self):
        identity=self.begin()
        def changed(label,argv,env):
            value=self.executor(label,argv,env);value['timed_out']=True;(self.out/(label+'.receipt.json')).write_text(json.dumps(value));return value
        with self.assertRaisesRegex(ValueError,'failed or timed out'): identity.run('helper-build',self.argv('helper-build'),changed)

    def test_build_receipt_cannot_drift_after_success(self):
        identity,fixture=self.complete();(self.out/'observer-build.receipt.json').write_text('{}')
        with self.assertRaisesRegex(ValueError,'receipt changed'): identity.finalize(fixture)

    def test_native_readback_validates_then_rejects_environment_hash_poison(self):
        identity,fixture=self.complete();result=identity.finalize(fixture)
        document=n.validate_frozen_document(result['path'],fixture,self.head)
        self.assertEqual(document['state'],'frozen')
        document['builds'][0]['environment_sha256']='0'*64
        Path(result['path']).write_text(json.dumps(document))
        with self.assertRaisesRegex(ValueError,'environment hash differs'):
            n.validate_frozen_document(result['path'],fixture,self.head)

    def test_native_readback_rejects_boolean_exit_code_even_when_rehashed(self):
        identity,fixture=self.complete();result=identity.finalize(fixture)
        receipt=self.out/'standalone-restore.receipt.json'
        value=json.loads(receipt.read_text());value['exit_code']=False;receipt.write_text(json.dumps(value))
        document=json.loads(Path(result['path']).read_text())
        document['builds'][-1]['receipt']['sha256']=n.sha(receipt)
        Path(result['path']).write_text(json.dumps(document))
        with self.assertRaisesRegex(ValueError,'command receipt failed'):
            n.validate_frozen_document(result['path'],fixture,self.head)

    def test_native_readback_rejects_foreign_argv_even_when_receipt_matches(self):
        identity,fixture=self.complete();result=identity.finalize(fixture)
        receipt=self.out/'standalone-restore.receipt.json'
        value=json.loads(receipt.read_text());value['argv'][1]='clean';receipt.write_text(json.dumps(value))
        document=json.loads(Path(result['path']).read_text())
        document['builds'][-1]['receipt']['sha256']=n.sha(receipt)
        document['builds'][-1]['argv']=value['argv'];Path(result['path']).write_text(json.dumps(document))
        with self.assertRaisesRegex(ValueError,'argv differs'):
            n.validate_frozen_document(result['path'],fixture,self.head)


if __name__=='__main__': unittest.main()
