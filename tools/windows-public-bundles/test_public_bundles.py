import json
import os
from pathlib import Path
import shutil
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
        self.assertTrue(all(steps.index(step) > 2 for step in uploads))
        self.assertIn('${{ steps.preparation.outputs.artifact-id }}', steps[-1]['env'].values())
        self.assertIn('${{ steps.prior_native.outputs.artifact-id }}', steps[-1]['env'].values())

    def test_actual_bash_source_guard_rejects_other_or_malformed_identity(self):
        script = self.workflow['jobs']['publish']['steps'][0]['run']
        expected = 'a' * 40
        for source, head, workflow, code in ((expected, expected, expected, 0),
                                            ('main', expected, expected, 2),
                                            ('0' * 40, '0' * 40, '0' * 40, 2),
                                            (expected, 'b' * 40, expected, 2),
                                            (expected, expected, 'b' * 40, 2)):
            with self.subTest(source=source, head=head, workflow=workflow):
                result = subprocess.run(['bash', '-c', script], env=dict(os.environ, SOURCE_SHA=source,
                    GITHUB_SHA=head, GITHUB_WORKFLOW_SHA=workflow), capture_output=True, check=False)
                self.assertEqual(result.returncode, code, result.stderr)


if __name__ == '__main__':
    unittest.main()
