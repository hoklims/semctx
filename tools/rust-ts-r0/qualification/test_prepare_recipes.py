import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest


class RecipeOutputTest(unittest.TestCase):
    def invoke(self, *arguments):
        return subprocess.run(
            [sys.executable, str(pathlib.Path(__file__).with_name('prepare_recipes.py')), *arguments],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )

    def test_prepares_recipes_in_the_requested_fresh_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / 'requested'
            result = self.invoke('--output', str(output))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((output / 'replay-recipes.json').is_file())
            self.assertTrue((output / 'support-mapping-plan.json').is_file())
            recipes = json.loads((output / 'replay-recipes.json').read_text(encoding='utf-8'))['recipes']
            for unit_id in [
                'V2-F01-empty-config-no-input-diagnostic::base',
                'V2-C03-object-literal-caller-unmodeled::base',
            ]:
                recipe = next(row for row in recipes if row['unit_id'] == unit_id)
                self.assertEqual(recipe['gaps'], [])
                self.assertEqual(recipe['prepared_state'], 'MAPPED_REQUIRES_PASS2_DTO_FREEZE_AND_REVIEW')

    def test_missing_output_is_refused(self):
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)

    def test_preparation_uses_relocated_repository_inputs(self):
        source = pathlib.Path(__file__).resolve().parent
        root = source.parents[2]
        forbidden = [entry['path'] for entry in json.loads(
            (source / 'reason-routing-audit.json').read_text(encoding='utf-8'),
        )['input_digests']]
        with tempfile.TemporaryDirectory() as directory:
            relocated = pathlib.Path(directory) / 'clone'
            observer = relocated / 'tools/rust-ts-r0/qualification'
            observer.mkdir(parents=True)
            for name in ['prepare_recipes.py', 'reason-routing-audit.json', 'coupled-mapping-scope.json']:
                shutil.copyfile(source / name, observer / name)
            shutil.copytree(
                root / 'docs/research/rust-ts-r0/cases',
                relocated / 'docs/research/rust-ts-r0/cases',
                ignore=shutil.ignore_patterns('reserved'),
            )
            reproduction = pathlib.Path('docs/research/rust-ts-r0/qualification/reproduction')
            (relocated / reproduction).mkdir(parents=True)
            name = 'qualifier-reproduction.tar.gz.b64'
            shutil.copyfile(root / reproduction / name, relocated / reproduction / name)
            script = (
                'import runpy, sys\n'
                f'forbidden = {forbidden!r}\n'
                'def deny_historical_reads(event, args):\n'
                '    if event == "open" and args[0] in forbidden:\n'
                '        raise PermissionError("historical author path accessed")\n'
                'sys.addaudithook(deny_historical_reads)\n'
                'script = sys.argv.pop(1)\n'
                'runpy.run_path(script, run_name="__main__")\n'
            )
            result = subprocess.run(
                [sys.executable, '-c', script, str(observer / 'prepare_recipes.py'),
                 '--output', str(pathlib.Path(directory) / 'output')],
                capture_output=True, text=True, timeout=20, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_existing_output_is_refused_without_replacing_its_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory)
            marker = output / 'preserved.txt'
            marker.write_text('preserved', encoding='utf-8')
            result = self.invoke('--output', str(output))
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(marker.read_text(encoding='utf-8'), 'preserved')
            self.assertEqual(list(output.iterdir()), [marker])

    def test_dangling_output_symlink_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory) / 'new-target'
            output = pathlib.Path(directory) / 'existing-link'
            output.symlink_to(target, target_is_directory=True)
            result = self.invoke('--output', str(output))
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(output.is_symlink())
            self.assertFalse(target.exists())

    def test_file_parent_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = pathlib.Path(directory) / 'file'
            parent.write_text('preserved', encoding='utf-8')
            result = self.invoke('--output', str(parent / 'child'))
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(parent.read_text(encoding='utf-8'), 'preserved')

    def test_unknown_option_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / 'requested'
            result = self.invoke('--output', str(output), '--unknown-option')
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
