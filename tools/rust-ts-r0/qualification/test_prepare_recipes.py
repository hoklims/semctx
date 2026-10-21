import base64
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest


class LocalEvidenceArchiveTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.source = self.root / 'custody'
        self.source.mkdir()
        (self.source / 'sample.tar.gz').write_bytes(b'abc')
        self.output = self.root / 'output'
        self.index = self.root / 'index.json'
        self.entry = {
            'id': 'sample', 'path': 'sample.tar.gz', 'size_bytes': 3,
            'sha256': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        }
        self.save_index([self.entry])

    def save_index(self, entries):
        self.index.write_text(json.dumps({'entries': entries}), encoding='utf-8')

    def invoke(self, *arguments, source_environment=None, replace_temporary=False):
        script = str(pathlib.Path(__file__).with_name('fetch_evidence.py'))
        command = [sys.executable, script]
        if replace_temporary:
            hook = (
                'import pathlib, runpy, sys\n'
                f'output = pathlib.Path({str(self.output)!r})\n'
                'def replace(event, args):\n'
                '    if event == "open" and pathlib.Path(str(args[0])).name == "sample.tar.gz":\n'
                '        for temporary in output.glob(".restore-*"):\n'
                '            temporary.unlink()\n'
                '            temporary.write_bytes(b"UNVERIFIED")\n'
                'sys.addaudithook(replace)\n'
                'script = sys.argv.pop(1)\n'
                'runpy.run_path(script, run_name="__main__")\n'
            )
            command = [sys.executable, '-c', hook, script]
        environment = dict(os.environ)
        environment.pop('SEMCTX_T00_EVIDENCE_DIRECTORY', None)
        if source_environment is not None:
            environment['SEMCTX_T00_EVIDENCE_DIRECTORY'] = source_environment
        return subprocess.run(
            [*command, '--index', str(self.index), *arguments],
            capture_output=True, text=True, timeout=10, check=False, env=environment,
        )

    def restore(self, *arguments, **options):
        return self.invoke('--source-dir', str(self.source), '--output', str(self.output),
                           *arguments, **options)

    def test_verifies_local_custody_without_creating_a_work_directory(self):
        result = self.invoke('--source-dir', str(self.source), '--verify')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.output.exists())
        self.assertEqual((self.source / 'sample.tar.gz').read_bytes(), b'abc')
        self.assertEqual(list(self.source.iterdir()), [self.source / 'sample.tar.gz'])

    def test_restores_exact_bytes_without_changing_custody(self):
        result = self.restore()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.output / 'sample.tar.gz').read_bytes(), b'abc')
        self.assertEqual((self.source / 'sample.tar.gz').read_bytes(), b'abc')

    def test_environment_source_is_supported_and_explicit_argument_has_precedence(self):
        result = self.invoke('--verify', source_environment=str(self.source))
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.invoke('--source-dir', str(self.source), '--verify', source_environment='/missing')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_repository_archive_is_verified_and_restored_without_a_private_directory(self):
        self.entry['repository_path'] = 'docs/research/rust-ts-r0/evidence/sample.tar.gz.b64'
        self.save_index([self.entry])
        checkout = self.root / 'checkout'
        script = checkout / 'tools/rust-ts-r0/qualification/fetch_evidence.py'
        script.parent.mkdir(parents=True)
        shutil.copyfile(pathlib.Path(__file__).with_name('fetch_evidence.py'), script)
        archive = checkout / self.entry['repository_path']
        archive.parent.mkdir(parents=True)
        archive.write_bytes(base64.encodebytes(b'abc'))
        for content, succeeds in [(base64.encodebytes(b'abc'), True),
                                  (b'YWJj!\n', False), (base64.encodebytes(b'abd'), False),
                                  (base64.encodebytes(b'abcd'), False), (None, False)]:
            if content is None:
                archive.unlink()
            else:
                archive.write_bytes(content)
            for action in [('--verify',), ('--output', str(self.output))]:
                with self.subTest(content=content, action=action):
                    environment = dict(os.environ)
                    environment.pop('SEMCTX_T00_EVIDENCE_DIRECTORY', None)
                    result = subprocess.run(
                        [sys.executable, str(script), '--index', str(self.index), *action],
                        capture_output=True, text=True, timeout=10, check=False, env=environment,
                    )
                    self.assertEqual(result.returncode == 0, succeeds, result.stderr)
                    if self.output.exists():
                        if succeeds:
                            self.assertEqual((self.output / 'sample.tar.gz').read_bytes(), b'abc')
                        else:
                            self.assertEqual(list(self.output.iterdir()), [])
                        shutil.rmtree(self.output)

    def test_repository_path_cannot_escape_the_evidence_tree(self):
        for path in [None, '/tmp/sample.tar.gz.b64', '../sample.tar.gz.b64',
                     'docs/research/rust-ts-r0/../../../sample.tar.gz.b64',
                     'docs/research/rust-ts-r0/..\\sample.tar.gz.b64',
                     'docs/research/rust-ts-r0/sample.tar.gz']:
            self.entry['repository_path'] = path
            self.save_index([self.entry])
            result = self.invoke('--output', str(self.output))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("invalid repository archive path", result.stderr)
            self.assertFalse(self.output.exists())

    def test_invalid_source_or_action_is_refused(self):
        for arguments in [('--source-dir', '', '--verify'),
                          ('--source-dir', 'https://example.test', '--verify'),
                          ('--source-dir', str(self.source)),
                          ('--source-dir', str(self.source), '--verify', '--output', str(self.output)),
                          ('--base-url', 'https://example.test', '--verify')]:
            with self.subTest(arguments=arguments):
                result = self.invoke(*arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.output.exists())

    def test_corruption_or_incorrect_size_is_refused_in_both_modes(self):
        for body in [b'abd', b'ab', b'abcd']:
            (self.source / 'sample.tar.gz').write_bytes(body)
            for action in [('--verify',), ('--output', str(self.output))]:
                with self.subTest(body=body, action=action):
                    result = self.invoke('--source-dir', str(self.source), *action)
                    self.assertNotEqual(result.returncode, 0)
                    if self.output.exists():
                        self.assertEqual(list(self.output.iterdir()), [])
                        self.output.rmdir()
                    self.assertEqual((self.source / 'sample.tar.gz').read_bytes(), body)

    def test_missing_or_nonregular_custody_file_is_refused(self):
        archive = self.source / 'sample.tar.gz'
        archive.unlink()
        for directory in [False, True]:
            if directory:
                archive.mkdir()
            result = self.invoke('--source-dir', str(self.source), '--verify')
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(self.output.exists())

    def test_existing_destination_is_preserved(self):
        self.output.mkdir()
        target = self.output / 'sample.tar.gz'
        target.write_bytes(b'prior')
        result = self.restore()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_bytes(), b'prior')

    def test_replaced_temporary_cannot_restore_unverified_bytes(self):
        result = self.restore(replace_temporary=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_malformed_manifest_and_selection_are_refused_before_output(self):
        invalid = [[], [self.entry, self.entry], [{**self.entry, 'path': '../outside.tar.gz'}],
                   [{**self.entry, 'path': '/outside.tar.gz'}], [{**self.entry, 'sha256': 'bad'}],
                   [{**self.entry, 'size_bytes': True}], [{**self.entry, 'size_bytes': -1}],
                   [{**self.entry, 'id': '../outside'}], [self.entry, {**self.entry, 'id': 'other'}]]
        for entries in invalid:
            with self.subTest(entries=entries):
                self.save_index(entries)
                result = self.restore()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.output.exists())
        self.save_index([self.entry])
        for arguments in [('--archive', 'unknown'), ('--archive', 'sample', '--archive', 'sample')]:
            result = self.restore(*arguments)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(self.output.exists())

    def test_missing_or_malformed_index_is_refused_before_output(self):
        for content in [None, '{broken', '[]', '{}']:
            if self.index.exists():
                self.index.unlink()
            if content is not None:
                self.index.write_text(content, encoding='utf-8')
            result = self.restore()
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(self.output.exists())

    def test_selected_archive_only_is_copied(self):
        self.save_index([self.entry, {**self.entry, 'id': 'other', 'path': 'other.tar.gz'}])
        result = self.restore('--archive', 'sample')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(self.output.iterdir()), [self.output / 'sample.tar.gz'])


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

    def test_dynamic_import_variants_preserve_the_declared_qualified_capture_context(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / 'recipes'
            result = self.invoke('--output', str(output))
            self.assertEqual(result.returncode, 0, result.stderr)
            recipes = json.loads((output / 'replay-recipes.json').read_text(encoding='utf-8'))['recipes']
            for case_id, extension in [
                ('QDYN-02-one-literal-dynamic-refusal::base', 'ts'),
                ('QDYN-02-one-literal-dynamic-refusal::mjs-variant', 'mjs'),
                ('QDYN-03-nonliteral-scan-control-scope-refusal::base', 'ts'),
                ('QDYN-04-two-arguments-scan-control-scope-refusal::base', 'ts'),
                ('QDYN-05-unresolved-literal-target::base', 'ts'),
            ]:
                with self.subTest(case_id=case_id):
                    recipe = next(row for row in recipes if row['unit_id'] == case_id)
                    request = recipe['requests'][0]
                    self.assertTrue(request['retained'])
                    self.assertTrue(request['qualified'])
                    self.assertEqual(request['roles'], {
                        f'src/target.{extension}': 'source',
                        f'src/target.test.{extension}': 'test',
                    })
                    self.assertEqual(recipe['gaps'], [])
                    if extension == 'mjs':
                        self.assertIn(['src/target.test.mjs:1:./target.mjs'], [
                            row['expected'] for row in recipe['checks']
                            if row['target'] == ['test_dynamic_import_keys']
                        ])

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
