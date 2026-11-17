"""Offline source-provenance controls; no Cargo, compiler or native query.

Use SEMCTX_TS_RUST_REPO for an explicit local checkout at the pinned revision.
Otherwise discover that checkout under CARGO_HOME. Missing or ambiguous local
inputs are a clear setup error, never skipped proof or a network request.
"""
import ast
import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
TOOL = HERE.parent
PATH_SOURCE = 'crates/ts_goport/src/frontend/tspath/path.rs'
SCANNERS = ('crates/ts_goport/src/frontend/scanner/scanner_p1.rs',
            'crates/ts_goport/src/frontend/scanner/t00_utf16_source_tests.rs')


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


collector = load('tested_native_compiler_identity', HERE/'native_compiler_identity.py')
sys.path.insert(0, str(HERE/'property_assessor'))
carrier = load('tested_compiler_carrier', HERE/'property_assessor/remaining_carriers.py')
carrier.API = types.SimpleNamespace(sha=lambda value: hashlib.sha256(value).hexdigest())


def git(repo, *args, input_bytes=None):
    return subprocess.check_output(['git', '-C', str(repo), *args], input=input_bytes)


def local_upstream():
    explicit = os.environ.get('SEMCTX_TS_RUST_REPO')
    if explicit:
        candidate = Path(explicit).resolve()
        if not candidate.is_dir() or git(candidate, 'rev-parse', 'HEAD').decode().strip() != collector.REVISION:
            raise RuntimeError('PROVENANCE_TEST_PREREQUISITE: SEMCTX_TS_RUST_REPO must be a local checkout at '+collector.REVISION)
        return candidate
    cargo = Path(os.environ.get('CARGO_HOME') or Path.home()/'.cargo')
    found = []
    for source in (cargo/'git/checkouts').glob('ts-rust-*/*/'+collector.SOURCE):
        checkout = source.parents[3]
        if git(checkout, 'rev-parse', 'HEAD').decode().strip() == collector.REVISION:
            found.append(checkout)
    if len(found) != 1:
        raise RuntimeError('PROVENANCE_TEST_PREREQUISITE: exactly one cached ts-rust '+collector.REVISION+
                           ' is required; prepare locked dependencies separately or set SEMCTX_TS_RUST_REPO')
    return found[0]


def git_inventory(repo):
    """Read the real commit graph and eight needed blobs once for the entire suite."""
    revision, scanner = collector.REVISION, collector.SCANNER_REVISION
    parent = git(repo, 'show', '-s', '--format=%P', revision).decode().strip()
    scanner_parent = git(repo, 'show', '-s', '--format=%P', scanner).decode().strip()
    if parent != scanner or scanner_parent != collector.UPSTREAM_BASE_REVISION:
        raise RuntimeError('PROVENANCE_TEST_PREREQUISITE: local commit ancestry differs from the frozen chain')
    changed = git(repo, 'diff', '--name-only', scanner, revision)
    if changed.decode().splitlines() != [PATH_SOURCE]:
        raise RuntimeError('PROVENANCE_TEST_PREREQUISITE: pinned upstream delta is not path.rs only')
    specifications = [revision+':'+collector.SOURCE, scanner+':'+collector.SOURCE,
                      scanner+':'+PATH_SOURCE, revision+':'+PATH_SOURCE]
    specifications += [rev+':'+name for name in SCANNERS for rev in (revision, scanner)]
    raw = git(repo, 'cat-file', '--batch', input_bytes=('\n'.join(specifications)+'\n').encode())
    blobs = {}
    offset = 0
    for identity in specifications:
        end = raw.index(b'\n', offset)
        header = raw[offset:end].decode().split()
        if len(header) != 3 or header[1] != 'blob':
            raise RuntimeError('PROVENANCE_TEST_PREREQUISITE: missing Git blob '+identity)
        size = int(header[2]); start = end+1
        data = raw[start:start+size]
        if len(data) != size or raw[start+size:start+size+1] != b'\n':
            raise RuntimeError('PROVENANCE_TEST_PREREQUISITE: incomplete Git batch output')
        blobs[identity] = (header[0], data)
        offset = start+size+1
    if offset != len(raw):
        raise RuntimeError('PROVENANCE_TEST_PREREQUISITE: extra Git batch output')
    replies = {('rev-parse', 'HEAD'): (revision+'\n').encode(),
               ('rev-parse', 'HEAD^'): (parent+'\n').encode(),
               ('rev-parse', scanner+'^'): (scanner_parent+'\n').encode(),
               ('diff', '--name-only', scanner, revision): changed}
    for path in (collector.SOURCE, PATH_SOURCE, *SCANNERS):
        blob, data = blobs[revision+':'+path]
        for name in ('HEAD:'+path, revision+':'+path):
            replies[('show', name)] = data
            replies[('rev-parse', name)] = (blob+'\n').encode()
        old_blob, old_data = blobs[scanner+':'+path]
        replies[('show', scanner+':'+path)] = old_data
        replies[('rev-parse', scanner+':'+path)] = (old_blob+'\n').encode()
    return replies


class NativeCompilerIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inventory = git_inventory(local_upstream())
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        cls.cache = cls.root/'cargo/git/checkouts/ts-rust-provenance/fixture'
        cls.cache.mkdir(parents=True)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.replies = dict(self.inventory)
        for path in (collector.SOURCE, PATH_SOURCE, *SCANNERS):
            target = self.cache/path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(self.replies[('show', 'HEAD:'+path)])
        self.output = Path(tempfile.mkdtemp(dir=self.root))
        self.env = dict(os.environ, CARGO_HOME=str(self.root/'cargo'))
        self.env.pop('GOPORT_BUILD_VERSION', None)

    def fixture_git(self, args, **_kwargs):
        self.assertEqual(args[:3], ['git', '-C', str(self.cache)])
        key = tuple(args[3:])
        self.assertIn(key, self.replies, 'Unexpected Git query outside frozen inventory')
        return self.replies[key]

    def collect(self):
        with patch.object(collector.subprocess, 'check_output', side_effect=self.fixture_git):
            return collector.record_native_compiler_source(self.output, self.env)

    def test_real_inventory_chain_and_frozen_scanner_provenance(self):
        source = self.collect()
        self.assertEqual(source['engine_source_revision'], collector.REVISION)
        self.assertEqual(source['engine_parent_revision'], collector.SCANNER_REVISION)
        self.assertEqual(source['scanner_parent_revision'], collector.UPSTREAM_BASE_REVISION)
        self.assertEqual(source['engine_delta_paths'], [PATH_SOURCE])
        self.assertEqual(len(source['fork_patch_source_bindings']), 2)
        carrier.validate_compiler_lineage(source)

    def test_wrong_immediate_parent_refuses(self):
        self.replies[('rev-parse', 'HEAD^')] = b'0'*40+b'\n'
        with self.assertRaisesRegex(ValueError, 'path correction parent differs'): self.collect()

    def test_wrong_scanner_parent_refuses(self):
        self.replies[('rev-parse', collector.SCANNER_REVISION+'^')] = b'0'*40+b'\n'
        with self.assertRaisesRegex(ValueError, 'scanner correction is not based'): self.collect()

    def test_extra_changed_path_refuses(self):
        self.replies[('diff', '--name-only', collector.SCANNER_REVISION, collector.REVISION)] += b'foreign.rs\n'
        with self.assertRaisesRegex(ValueError, 'changes files outside'): self.collect()

    def test_mutated_cached_path_source_refuses(self):
        with (self.cache/PATH_SOURCE).open('ab') as stream: stream.write(b'\n// changed\n')
        with self.assertRaisesRegex(ValueError, 'cached path correction differs'): self.collect()

    def test_mutated_scanner_source_refuses(self):
        with (self.cache/SCANNERS[0]).open('ab') as stream: stream.write(b'\n// changed\n')
        with self.assertRaisesRegex(ValueError, 'cached scanner correction differs'): self.collect()

    def test_mutated_core_source_refuses(self):
        with (self.cache/collector.SOURCE).open('ab') as stream: stream.write(b'\n// changed\n')
        with self.assertRaisesRegex(ValueError, 'cached upstream compiler source differs'): self.collect()

    def test_build_version_override_still_refuses(self):
        self.env['GOPORT_BUILD_VERSION'] = 'foreign'
        with self.assertRaisesRegex(ValueError, 'override must be absent'): self.collect()

    def test_assessor_rejects_wrong_chain_and_original_upstream_relabel(self):
        source = self.collect()
        for field, value in [('engine_source_revision', collector.SCANNER_REVISION),
                             ('engine_parent_revision', collector.UPSTREAM_BASE_REVISION),
                             ('scanner_revision', collector.REVISION),
                             ('scanner_parent_revision', collector.SCANNER_REVISION),
                             ('upstream_base_revision', collector.SCANNER_REVISION),
                             ('engine_delta_paths', [collector.SOURCE])]:
            with self.subTest(field=field):
                mutant = copy.deepcopy(source); mutant[field] = value
                with self.assertRaises(ValueError): carrier.validate_compiler_lineage(mutant)

    def test_assessor_rejects_each_path_byte_hash_blob_or_revision_mutation(self):
        source = self.collect()
        for field, value in [('path', 'foreign.rs'), ('base_revision', collector.UPSTREAM_BASE_REVISION),
                             ('revision', collector.SCANNER_REVISION), ('before_source', 'foreign'),
                             ('after_source', 'foreign'), ('before_sha256', '0'*64),
                             ('after_sha256', '0'*64), ('before_git_blob', '0'*40), ('after_git_blob', '0'*40)]:
            with self.subTest(field=field):
                mutant = copy.deepcopy(source); mutant['path_patch_binding'][field] = value
                with self.assertRaises(ValueError): carrier.validate_compiler_lineage(mutant)

    def test_final_consumer_calls_lineage_validator_and_pins_agree(self):
        tree = ast.parse((HERE/'property_assessor/remaining_carriers.py').read_text(encoding='utf-8'))
        compiler = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'compiler')
        calls = [node for node in ast.walk(compiler) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Name) and node.func.id == 'validate_compiler_lineage']
        self.assertEqual(len(calls), 1)
        manifest = tomllib.loads((TOOL/'Cargo.toml').read_text(encoding='utf-8'))
        lock = tomllib.loads((TOOL/'Cargo.lock').read_text(encoding='utf-8'))
        self.assertEqual(manifest['dependencies']['ts_goport']['rev'], collector.REVISION)
        packages = [p for p in lock['package'] if p['name'] in ('goport_core', 'goport_lsproto', 'goport_util', 'ts_goport')]
        self.assertEqual(len(packages), 4)
        self.assertTrue(all(p['source'].endswith('?rev='+collector.REVISION+'#'+collector.REVISION) for p in packages))
        identity = (TOOL/'src/identity.rs').read_text(encoding='utf-8')
        self.assertIn('ENGINE_REVISION: &str = "'+collector.REVISION+'"', identity)
        self.assertIn('ENGINE_UPSTREAM_REVISION: &str = "'+collector.UPSTREAM_BASE_REVISION+'"', identity)


if __name__ == '__main__':
    unittest.main(verbosity=2)
