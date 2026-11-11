import copy
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from _supplement_test_paths import FROZEN
import directory_closure
import public_runtime as runtime


def directory_alias(alias, real):
    """Reach `real` through `alias`: a junction on Windows, a symlink elsewhere."""
    if os.name == 'nt':
        import _winapi
        _winapi.CreateJunction(str(real), str(alias))
    else:
        os.symlink(real, alias, target_is_directory=True)


def remove_alias(alias):
    """Drop the link itself, never what it reaches."""
    (os.rmdir if os.name == 'nt' else os.unlink)(alias)


class RootGuardedPath(type(Path())):
    """Turn a parent walk that reaches the filesystem root into a failure, not a spin."""

    def guard(self):
        spelled = self.absolute()
        if spelled.parent == spelled:
            raise AssertionError('directory closure inspected the filesystem root: ' + str(self))

    def is_symlink(self):
        self.guard()
        return super().is_symlink()

    def is_dir(self, **kwargs):
        self.guard()
        return super().is_dir(**kwargs)

    def lstat(self):
        self.guard()
        return super().lstat()


class FrozenDirectoryClosureTests(unittest.TestCase):
    def setUp(self):
        # Every test in this class walks parents: a regression must fail here,
        # not spin until the CI job is cancelled.
        guard = mock.patch.object(directory_closure, 'Path', RootGuardedPath)
        guard.start()
        self.addCleanup(guard.stop)

    def prepare(self, sequence, destination):
        return runtime.prepare_operation(FROZEN, 'workspace-boundaries-02', sequence,
                                         str(destination).replace('\\', '/'), '/sdk/lib', True)

    def test_frozen_empty_directory_is_physical_and_captured_for_configured_query(self):
        for sequence in [2, 3]:
            with tempfile.TemporaryDirectory() as temporary:
                destination = Path(temporary)/'case'
                prepared = self.prepare(sequence, destination)
                self.assertIn('physical_empty_directories', prepared)
                expected = destination/'fixture-000/repo/.git'
                self.assertEqual(prepared['physical_empty_directories'], [str(expected).replace('\\', '/')])
                self.assertNotIn(str(expected).replace('\\', '/'), prepared['request']['files'])
                if sequence == 3:
                    self.assertIn(str(expected).replace('\\', '/'), prepared['request']['directories'])
                receipt = runtime.materialize_physical(prepared)
                self.assertTrue(expected.is_dir())
                self.assertEqual(list(expected.iterdir()), [])
                self.assertEqual(receipt['empty_directories'][0]['kind'], 'directory')
                self.assertFalse(receipt['empty_directories'][0]['authority']['directory_listing_captured'])

    def test_frozen_empty_directory_walk_stays_inside_an_aliased_case_root(self):
        # An aliased spelling (8.3 TEMP, junction, linked parent) never equals its
        # resolved form: the parent walk must stop at the case root, never above it.
        with tempfile.TemporaryDirectory() as temporary:
            real = Path(temporary)/'real'
            real.mkdir()
            alias = Path(temporary)/'alias'
            directory_alias(alias, real)
            try:
                destination = alias/'case'
                self.assertNotEqual(destination.resolve(), destination.absolute())
                owner = destination.absolute()

                class InsideCase(type(Path())):
                    def inspected(self):
                        if not self.absolute().is_relative_to(owner):
                            raise AssertionError('directory closure inspected a path above its case root: ' + str(self))

                    def is_symlink(self):
                        self.inspected()
                        return super().is_symlink()

                    def is_dir(self, **kwargs):
                        self.inspected()
                        return super().is_dir(**kwargs)

                    def lstat(self):
                        self.inspected()
                        return super().lstat()

                prepared = self.prepare(3, destination)
                expected = destination/'fixture-000/repo/.git'
                with mock.patch.object(directory_closure, 'Path', InsideCase):
                    receipt = runtime.materialize_physical(prepared)
                self.assertTrue(expected.is_dir())
                self.assertEqual(list(expected.iterdir()), [])
                self.assertEqual(receipt['empty_directories'][0]['kind'], 'directory')
            finally:
                remove_alias(alias)

    def test_frozen_empty_directory_refuses_a_linked_parent_inside_the_case(self):
        # pathlib does not report a junction as a symlink: only the reparse
        # attribute refuses a parent that is a link, even one that stays inside.
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary)/'case'
            prepared = self.prepare(3, destination)
            inner = destination/'inner'
            (inner/'repo').mkdir(parents=True)
            fixture = destination/'fixture-000'
            directory_alias(fixture, inner)
            try:
                with self.assertRaisesRegex(ValueError, 'DIRECTORY_SETUP_PARENT_NOT_OWNED_DIRECTORY'):
                    directory_closure.materialize(prepared)
                self.assertEqual(list((inner/'repo').iterdir()), [])
            finally:
                remove_alias(fixture)

    def test_frozen_empty_directory_refuses_a_linked_case_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary)/'case'
            prepared = self.prepare(3, destination)
            real = Path(temporary)/'real-case'
            (real/'fixture-000/repo').mkdir(parents=True)
            directory_alias(destination, real)
            try:
                with self.assertRaisesRegex(ValueError, 'DIRECTORY_SETUP_CASE_NOT_OWNED_DIRECTORY'):
                    directory_closure.materialize(prepared)
                self.assertEqual(list((real/'fixture-000/repo').iterdir()), [])
            finally:
                remove_alias(destination)

    def test_frozen_empty_directory_walk_refuses_a_target_spelled_outside_the_case_root(self):
        # Targets spelled through the real path, case root through an alias: the
        # walk must refuse at once, never climb toward the filesystem root.
        with tempfile.TemporaryDirectory() as temporary:
            real = Path(temporary)/'real'
            real.mkdir()
            alias = Path(temporary)/'alias'
            directory_alias(alias, real)
            try:
                prepared = self.prepare(3, real/'case')
                (real/'case/fixture-000/repo').mkdir(parents=True)
                prepared['case_root'] = str(alias/'case').replace('\\', '/')
                with self.assertRaisesRegex(ValueError, 'DIRECTORY_SETUP_PARENT_ESCAPES_CASE'):
                    directory_closure.materialize(prepared)
                self.assertEqual(list((real/'case/fixture-000/repo').iterdir()), [])
            finally:
                remove_alias(alias)

    def test_missing_foreign_authority_or_directory_refuses_before_writes(self):
        for poison in ['missing', 'hash', 'path', 'capture']:
            with tempfile.TemporaryDirectory() as temporary:
                destination = Path(temporary)/'case'
                prepared = self.prepare(3, destination)
                if poison == 'missing':
                    prepared.pop('directory_setup_authority')
                elif poison == 'hash':
                    prepared['directory_setup_authority']['source_sha256'] = '0'*64
                elif poison == 'path':
                    prepared['physical_empty_directories'] = [str(destination/'foreign/.git')]
                else:
                    prepared['request']['directories'].remove(prepared['physical_empty_directories'][0])
                with self.subTest(poison=poison), self.assertRaises(ValueError):
                    runtime.materialize_physical(prepared)
                self.assertFalse(destination.exists())

    def test_directory_authority_is_not_a_generic_physical_directory_api(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary)/'case'
            prepared = copy.deepcopy(self.prepare(3, destination))
            prepared['row_id'] = 'native-inert-01'
            with self.assertRaisesRegex(ValueError, 'OUTSIDE_EXACT_FROZEN_VECTOR'):
                runtime.materialize_physical(prepared)
            self.assertFalse(destination.exists())

    def test_absent_configured_boundary_is_explicit_and_only_for_the_live_call(self):
        with tempfile.TemporaryDirectory() as temporary:
            retained = self.prepare(2, Path(temporary)/'retained')
            live = self.prepare(3, Path(temporary)/'live')
            self.assertNotIn('repository_boundary', retained['request'])
            self.assertEqual(live['request']['repository_boundary'], {'mode': 'absent'})
            self.assertFalse(live['retained'])
            self.assertTrue(any(path.endswith('/pnpm-workspace.yaml') for path in live['request']['files']))


if __name__ == '__main__':
    unittest.main()
