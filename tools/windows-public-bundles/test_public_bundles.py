import json
import os
from pathlib import Path
import shutil
import shlex
import tempfile
import subprocess
import sys
import unittest

import validate_bundles as validator


ROOT = Path(__file__).resolve().parent


class Bundles(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve() / 'bundles'
        self.root.mkdir()
        for name in ('preparation', 'prior-native'):
            shutil.copytree(ROOT / name, self.root / name)
        shutil.copy2(ROOT / 'manifest.json', self.root / 'manifest.json')

    def test_exact_public_bundles_accept(self):
        expected = json.loads((ROOT / 'manifest.json').read_bytes())['files']
        self.assertEqual(validator.validate(self.root), expected)
        self.assertEqual(len(expected), 10)

    def test_changed_payload_refuses(self):
        path = self.root / 'prior-native/review.prompt.exact'
        payload = bytearray(path.read_bytes())
        payload[0] ^= 1
        path.write_bytes(payload)
        with self.assertRaisesRegex(ValueError, 'payload pin differs'):
            validator.validate(self.root)

    def test_missing_payload_refuses(self):
        (self.root / 'preparation/preflight.json').unlink()
        with self.assertRaisesRegex(ValueError, 'bundle file inventory differs'):
            validator.validate(self.root)

    def test_foreign_payload_refuses(self):
        (self.root / 'prior-native/unapproved.txt').write_bytes(b'foreign')
        with self.assertRaisesRegex(ValueError, 'bundle file inventory differs'):
            validator.validate(self.root)

    def test_hidden_entries_and_extra_directories_refuse(self):
        for bundle in validator.FILES:
            for name, directory in (('.hidden', False), ('unlisted-directory', True)):
                with self.subTest(bundle=bundle, name=name):
                    path = self.root / bundle / name
                    if directory:
                        path.mkdir()
                    else:
                        path.write_bytes(b'foreign')
                    try:
                        with self.assertRaisesRegex(ValueError, 'bundle file inventory differs'):
                            validator.validate(self.root)
                    finally:
                        path.rmdir() if directory else path.unlink()

    def test_root_and_ancestor_links_refuse(self):
        direct = self.root.parent / 'linked-bundles'
        direct.symlink_to(self.root, target_is_directory=True)
        parent = self.root.parent / 'linked-parent'
        parent.symlink_to(self.root.parent, target_is_directory=True)
        for root in (direct, parent / self.root.name):
            with self.subTest(root=str(root)):
                with self.assertRaisesRegex(ValueError, 'linked or nonregular'):
                    validator.validate(root)

    def test_default_cli_root_keeps_literal_directory_links_visible(self):
        shutil.copy2(ROOT / 'validate_bundles.py', self.root / 'validate_bundles.py')
        direct = self.root.parent / 'linked-bundles'
        direct.symlink_to(self.root, target_is_directory=True)
        parent = self.root.parent / 'linked-parent'
        parent.symlink_to(self.root.parent, target_is_directory=True)
        for root, code in ((self.root, 0), (direct, 2), (parent / self.root.name, 2)):
            with self.subTest(root=str(root)):
                result = subprocess.run([sys.executable, '-I', '-B', str(root / 'validate_bundles.py')],
                                        capture_output=True, check=False)
                self.assertEqual(result.returncode, code, result.stderr)
                if code:
                    self.assertIn(b'PUBLIC_BUNDLES_REFUSED: linked or nonregular', result.stderr)
                else:
                    self.assertEqual(len(json.loads(result.stdout)['files']), 10)

    def test_linked_payload_refuses_even_with_identical_bytes(self):
        file = self.root / 'prior-native/REVIEW.json'
        replacement = self.root / 'same-review'
        file.rename(replacement)
        file.symlink_to(replacement)
        with self.assertRaisesRegex(ValueError, 'linked or nonregular'):
            validator.validate(self.root)

    def test_cli_reports_identity_without_grant_or_payload_write(self):
        before = sorted(str(path.relative_to(self.root)) for path in self.root.rglob('*'))
        result = subprocess.run([sys.executable, '-I', '-B', str(ROOT / 'validate_bundles.py'),
                                 '--root', str(self.root)], capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)['source_admission_granted'])
        self.assertFalse(json.loads(result.stdout)['native_execution'])
        self.assertEqual(before, sorted(str(path.relative_to(self.root)) for path in self.root.rglob('*')))


class Workflow(unittest.TestCase):
    def setUp(self):
        path = ROOT.parents[1] / '.github/workflows/windows-public-bundles.yml'
        ruby = "require 'yaml';require 'json';d=YAML.load_file(ARGV[0]);d['on']=d.delete(true) unless d.key?('on');puts JSON.generate(d)"
        result = subprocess.run(['ruby', '-e', ruby, str(path)], capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.workflow = json.loads(result.stdout)

    def test_manual_exact_source_validation_precedes_two_flat_uploads(self):
        self.assertEqual(set(self.workflow['on']), {'workflow_dispatch'})
        self.assertEqual(self.workflow['permissions'], {'contents': 'read'})
        steps = self.workflow['jobs']['publish']['steps']
        self.assertIn('GITHUB_SHA', steps[0]['run'])
        self.assertIn('GITHUB_WORKFLOW_SHA', steps[0]['run'])
        self.assertEqual(steps[1]['with']['ref'], '${{ inputs.source_sha }}')
        self.assertFalse(steps[1]['with']['persist-credentials'])
        self.assertIn('validate_bundles.py', steps[2]['run'])
        self.assertIn('status --porcelain --untracked-files=all', steps[2]['run'])
        uploads = [step for step in steps if step.get('uses', '').startswith('actions/upload-artifact@')]
        self.assertEqual(len(uploads), 2)
        self.assertEqual({step['uses'] for step in uploads},
                         {'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9'})
        self.assertEqual({step['with']['path'] for step in uploads},
                         {'tools/windows-public-bundles/preparation/', 'tools/windows-public-bundles/prior-native/'})
        validation_argv = shlex.split(steps[2]['run'].splitlines()[-1])
        self.assertEqual(validation_argv[-2:], ['--root', 'tools/windows-public-bundles'])
        self.assertEqual({Path(step['with']['path']).parent.as_posix() for step in uploads},
                         {validation_argv[-1]})
        self.assertTrue(all(steps.index(step) > 2 for step in uploads))
        self.assertIn('${{ steps.preparation.outputs.artifact-id }}', steps[-1]['env'].values())
        self.assertIn('${{ steps.prior_native.outputs.artifact-id }}', steps[-1]['env'].values())

    def test_publisher_binds_authority_files_to_committed_physical_bytes(self):
        script = self.workflow['jobs']['publish']['steps'][2]['run']
        git = shutil.which('git')
        for changed, flag in ((None, None), ('validate_bundles.py', '--assume-unchanged'),
                              ('manifest.json', '--assume-unchanged'),
                              ('validate_bundles.py', '--skip-worktree'), ('manifest.json', '--skip-worktree')):
            with self.subTest(changed=changed, flag=flag), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve(); folder = root / 'tools/windows-public-bundles'
                folder.mkdir(parents=True)
                checker = folder / 'validate_bundles.py'; checker.write_text("print('VALIDATOR_EXECUTED')\n")
                (folder / 'manifest.json').write_text('{"schema":1}\n')
                env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1',
                           GITHUB_WORKSPACE=str(root))
                for args in (['init', '-q'], ['add', '.'], ['-c', 'user.name=Public Fixture',
                             '-c', 'user.email=public@example.invalid', 'commit', '-qm', 'public baseline']):
                    child = subprocess.run([git, *args], cwd=root, env=env, capture_output=True, check=False)
                    self.assertEqual(child.returncode, 0, child.stderr)
                env['SOURCE_SHA'] = subprocess.check_output([git, 'rev-parse', 'HEAD'], cwd=root,
                                                          env=env, text=True).strip()
                if changed:
                    relative = 'tools/windows-public-bundles/' + changed
                    subprocess.run([git, 'update-index', flag, relative], cwd=root, env=env,
                                   capture_output=True, check=True)
                    target = folder / changed
                    target.write_bytes(target.read_bytes() + b' # changed tracked authority bytes\n')
                    self.assertEqual(subprocess.check_output([git, 'status', '--porcelain'], cwd=root, env=env), b'')
                child = subprocess.run(['bash', '-c', script + '\nprintf PUBLISH_SENTINEL\n'],
                                       cwd=root, env=env, capture_output=True, check=False)
                self.assertEqual(child.returncode == 0, changed is None, child.stderr)
                self.assertEqual(b'PUBLISH_SENTINEL' in child.stdout, changed is None, child.stderr)
                if changed:
                    self.assertIn(b'publisher authority bytes differ', child.stderr)
                    self.assertNotIn(b'VALIDATOR_EXECUTED', child.stdout)

    def test_actual_bash_source_guard_rejects_other_or_malformed_identity(self):
        script = self.workflow['jobs']['publish']['steps'][0]['run']
        expected = 'a' * 40
        for source, head, workflow, approved, code in ((expected, expected, expected, expected, 0),
                                            (expected, expected, expected, 'b' * 40, 2),
                                            (expected, expected, expected, '', 2),
                                            ('main', expected, expected, expected, 2),
                                            ('0' * 40, '0' * 40, '0' * 40, '0' * 40, 2),
                                            (expected, 'b' * 40, expected, expected, 2),
                                            (expected, expected, 'b' * 40, expected, 2)):
            with self.subTest(source=source, head=head, workflow=workflow, approved=approved):
                result = subprocess.run(['bash', '-c', script+'\nprintf PUBLISH\n'], env=dict(os.environ, SOURCE_SHA=source,
                    GITHUB_SHA=head, GITHUB_WORKFLOW_SHA=workflow,WINDOWS_APPROVED_WORKFLOW_SHA=approved), capture_output=True, check=False)
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertEqual(b'PUBLISH' in result.stdout,code==0)


if __name__ == '__main__':
    unittest.main()
