import gzip
import hashlib
import io
import json
import os
import stat
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import capture_pack as p


class CapturePackTests(unittest.TestCase):
    def fixture(self, root):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w', format=tarfile.PAX_FORMAT) as archive:
            folder = tarfile.TarInfo('capture')
            folder.type = tarfile.DIRTYPE
            folder.mode, folder.uid, folder.gid = 0o755, 501, 20
            archive.addfile(folder)
            data = (b'unchanged SDK/source bytes\n' * 2500) + bytes(range(256))
            for name in ('capture/a.ts', 'capture/b.ts'):
                member = tarfile.TarInfo(name)
                member.size, member.mode, member.uid, member.gid = len(data), 0o640, 501, 20
                member.pax_headers = {'mtime': '1792644300.123456789', 'comment': 'PAX remains exact'}
                archive.addfile(member, io.BytesIO(data))
            link = tarfile.TarInfo('capture/link.ts')
            link.type, link.linkname, link.uid, link.gid = tarfile.SYMTYPE, 'a.ts', 501, 20
            archive.addfile(link)
        archive_path = root/'source.tar.gz'
        archive_path.write_bytes(gzip.compress(raw.getvalue(), mtime=123456))
        return archive_path, raw.getvalue()

    def packed(self, root):
        archive, tar = self.fixture(root)
        output = root/'packed'
        receipt = p.pack(archive, output, p.digest_file(archive), p.CHUNK)
        return archive, tar, output, receipt

    def test_lossless_tar_pax_links_and_deduplicated_payload(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            archive, raw, output, receipt = self.packed(root)
            self.assertEqual(receipt['tar']['sha256'], hashlib.sha256(raw).hexdigest())
            result = p.verify(output, receipt['manifest_sha256'], root/'restored.tar')
            self.assertEqual((root/'restored.tar').read_bytes(), raw)
            self.assertEqual(result['member_count'], 4)
            self.assertFalse(receipt['original_gzip_reconstructed'])
            self.assertEqual(archive.read_bytes(), gzip.compress(raw, mtime=123456))
            with gzip.open(output/'manifest.json.gz', 'rb') as stream:
                manifest = json.load(stream)
            payload = hashlib.sha256((b'unchanged SDK/source bytes\n'*2500)+bytes(range(256))).hexdigest()
            index = next(i for i, row in enumerate(manifest['blobs']) if row['sha256'] == payload)
            self.assertEqual(manifest['segments'].count(index), 2)

    def test_deterministic_pack_and_part_boundary(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            archive, _, first, receipt = self.packed(root)
            second = root/'second'
            p.pack(archive, second, p.digest_file(archive), p.CHUNK)
            self.assertEqual({x.name: x.read_bytes() for x in first.iterdir()},
                             {x.name: x.read_bytes() for x in second.iterdir()})
            self.assertTrue(all(row['bytes'] <= p.CHUNK for row in receipt['parts']))
            # Force a blob range to cross a part boundary with incompressible DEV bytes.
            random_data = b''.join(hashlib.sha256(str(i).encode()).digest() for i in range(40_000))
            raw = io.BytesIO()
            with tarfile.open(fileobj=raw, mode='w') as archive:
                member = tarfile.TarInfo('random.bin')
                member.size = len(random_data)
                archive.addfile(member, io.BytesIO(random_data))
            source = root/'cross.tar.gz'
            source.write_bytes(gzip.compress(raw.getvalue(), mtime=0))
            r = p.pack(source, root/'cross', p.digest_file(source), p.CHUNK)
            self.assertGreater(len(r['parts']), 1)
            p.verify(root/'cross', r['manifest_sha256'], root/'cross.tar')
            self.assertEqual((root/'cross.tar').read_bytes(), raw.getvalue())

    def test_missing_or_changed_part_refuses_before_output(self):
        for kind in ('missing', 'changed'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as name:
                root = Path(name)
                _, _, output, receipt = self.packed(root)
                part = output/receipt['parts'][0]['name']
                if kind == 'missing':
                    part.unlink()
                else:
                    part.write_bytes(b'foreign')
                with self.assertRaises((ValueError, FileNotFoundError)):
                    p.verify(output, receipt['manifest_sha256'], root/'forbidden.tar')
                self.assertFalse((root/'forbidden.tar').exists())

    def test_manifest_types_and_blob_range_refuse(self):
        for field in ('segment_bool', 'range_overlap', 'tar_size_bool', 'unknown_codec', 'foreign_blob', 'segment_order'):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as name:
                root = Path(name)
                _, _, output, _receipt = self.packed(root)
                path = output/'manifest.json.gz'
                manifest = json.loads(gzip.decompress(path.read_bytes()))
                if field == 'segment_bool':
                    manifest['segments'][0] = False
                elif field == 'range_overlap':
                    manifest['blobs'][0]['offset'] = 1
                elif field == 'tar_size_bool':
                    manifest['tar']['bytes'] = True
                elif field == 'unknown_codec':
                    manifest['blobs'][0]['codec'] = 'unknown'
                elif field == 'foreign_blob':
                    manifest['blobs'][0]['sha256'] = 'f'*64
                else:
                    manifest['segments'][0], manifest['segments'][1] = manifest['segments'][1], manifest['segments'][0]
                path.write_bytes(gzip.compress(json.dumps(manifest).encode(), mtime=0))
                with self.assertRaises(ValueError):
                    p.verify(output, p.digest_file(path), root/'forbidden.tar')
                self.assertFalse((root/'forbidden.tar').exists())

    def test_xz_codec_is_bounded_and_gzip_remains_supported(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            raw = io.BytesIO()
            data = b'large retained SDK bytes\n' * 20_000
            with tarfile.open(fileobj=raw, mode='w') as archive:
                member = tarfile.TarInfo('large.ts')
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            source = root/'source.tar.gz'
            source.write_bytes(gzip.compress(raw.getvalue(), mtime=0))
            for codec in ('gzip6', 'xz6'):
                receipt = p.pack(source, root/codec, p.digest_file(source), large_codec=codec)
                manifest = json.loads(gzip.decompress((root/codec/'manifest.json.gz').read_bytes()))
                self.assertIn(codec, {row['codec'] for row in manifest['blobs']})
                p.verify(root/codec, receipt['manifest_sha256'], root/(codec+'.tar'))
                self.assertEqual((root/(codec+'.tar')).read_bytes(), raw.getvalue())

    def test_unsafe_source_tar_never_produces_a_valid_pack(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            raw = io.BytesIO()
            with tarfile.open(fileobj=raw, mode='w') as archive:
                archive.addfile(tarfile.TarInfo('../outside'))
            source = root/'unsafe.tar.gz'
            source.write_bytes(gzip.compress(raw.getvalue(), mtime=0))
            with self.assertRaises(ValueError):
                p.pack(source, root/'rejected', p.digest_file(source))
            self.assertFalse((root/'rejected'/'manifest.json.gz').exists())

    def test_native_timestamp_precision_is_not_silently_rounded(self):
        member = tarfile.TarInfo('a')
        member.pax_headers = {'mtime': '1792644300.123456789'}
        self.assertEqual(p.native_mtime_ns(member), 1792644300123456789)
        member.pax_headers['mtime'] = '1792644300.1234567891'
        with self.assertRaises(ValueError):
            p.validate_members([member])

    def test_unsafe_link_fixture_headers_are_data_but_tree_restore_refuses(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            raw = io.BytesIO()
            with tarfile.open(fileobj=raw, mode='w', format=tarfile.PAX_FORMAT) as archive:
                link = tarfile.TarInfo('refused-link')
                link.type, link.linkname, link.mode = tarfile.SYMTYPE, '/outside/never-open', 0o777
                archive.addfile(link)
            source = root/'unsafe-link-fixture.tar.gz'
            source.write_bytes(gzip.compress(raw.getvalue(), mtime=0))
            receipt = p.pack(source, root/'pack', p.digest_file(source))
            self.assertFalse(receipt['tree_restoration_policy']['structural_metadata_preflight'])
            self.assertTrue(receipt['tree_restoration_policy']['exact_tar_restore_only'])
            p.verify(root/'pack', receipt['manifest_sha256'], root/'exact.tar')
            self.assertEqual((root/'exact.tar').read_bytes(), raw.getvalue())
            with self.assertRaises(ValueError):
                p.validate_members([link])

    def test_link_target_cannot_traverse_another_captured_link_before_dotdot(self):
        def symlink(name, target):
            member = tarfile.TarInfo(name)
            member.type, member.linkname, member.mode = tarfile.SYMTYPE, target, 0o777
            return member

        alias = symlink('alias', '.')
        self.assertEqual(set(p.validate_members([alias])), {'alias'})
        directory = tarfile.TarInfo('dir')
        directory.type = tarfile.DIRTYPE
        target = tarfile.TarInfo('target')
        healthy = symlink('dir/safe', '../target')
        self.assertEqual(len(p.validate_members([directory, target, healthy])), 3)
        cases = [
            [alias, symlink('escape', 'alias/../outside')],
            [symlink('escape', 'alias/../outside'), alias],
            [alias, symlink('chained', 'alias')],
            [symlink('a', 'b'), symlink('b', 'a')],
            [directory, symlink('dir/alias', '..'), symlink('dir/escape', './alias/../outside')],
        ]
        for members in cases:
            with self.subTest(targets=[(m.name, m.linkname) for m in members if m.issym()]), \
                 self.assertRaisesRegex(ValueError, 'link target traverses a captured link'):
                p.validate_members(members)

    def test_link_chain_refusal_precedes_even_destination_probe_writes(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            source = root/'link-chain.tar'
            with tarfile.open(source, mode='w') as archive:
                for link_name, target in [('alias', '.'), ('escape', 'alias/../outside')]:
                    member = tarfile.TarInfo(link_name)
                    member.type, member.linkname, member.mode = tarfile.SYMTYPE, target, 0o777
                    archive.addfile(member)
            # Exercise the platform-independent preflight on this Windows host.
            # A filesystem probe or native write would make this control fail.
            with mock.patch.object(p.sys, 'platform', 'linux'), \
                 mock.patch.object(p.os, 'getuid', return_value=0, create=True), \
                 mock.patch.object(p.os, 'getgid', return_value=0, create=True), \
                 mock.patch.object(p.tempfile, 'TemporaryDirectory', side_effect=AssertionError('destination probe reached')), \
                 self.assertRaisesRegex(ValueError, 'link target traverses a captured link'):
                p.extract_native(source, root/'tree', p.digest_file(source))
            self.assertFalse((root/'tree').exists())

    def test_composed_link_headers_remain_exact_archive_data(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            raw = io.BytesIO()
            with tarfile.open(fileobj=raw, mode='w') as archive:
                for link_name, target in [('alias', '.'), ('escape', 'alias/../outside')]:
                    member = tarfile.TarInfo(link_name)
                    member.type, member.linkname, member.mode = tarfile.SYMTYPE, target, 0o777
                    archive.addfile(member)
            source = root/'source.tar.gz'
            source.write_bytes(gzip.compress(raw.getvalue(), mtime=0))
            receipt = p.pack(source, root/'pack', p.digest_file(source))
            self.assertEqual(receipt['tree_restoration_policy'].get('refusal'), 'link target traverses a captured link')
            self.assertTrue(receipt['tree_restoration_policy'].get('exact_tar_restore_only'))
            p.verify(root/'pack', receipt['manifest_sha256'], root/'restored.tar')
            self.assertEqual((root/'restored.tar').read_bytes(), raw.getvalue())

    def test_member_traversal_duplicate_symlink_parent_and_external_target_refuse(self):
        def file(name):
            return tarfile.TarInfo(name)
        for rows in ([file('../out')], [file('same'), file('same')],
                     [file('link/file')], [file('/absolute')]):
            with self.subTest(names=[m.name for m in rows]), self.assertRaises(ValueError):
                p.validate_members(rows)
        link = file('link')
        link.type, link.linkname = tarfile.SYMTYPE, '../outside'
        with self.assertRaises(ValueError):
            p.validate_members([link])
        link.linkname = 'inside'
        with self.assertRaises(ValueError):
            p.validate_members([link, file('link/child')])

    def test_windows_case_mode_links_and_privileged_modes_refuse(self):
        upper, lower = tarfile.TarInfo('A'), tarfile.TarInfo('a')
        upper.mode = lower.mode = 0o600
        self.assertEqual(len(p.validate_members([upper, lower])), 2)
        with self.assertRaises(ValueError):
            p.validate_members([upper, lower], windows=True)
        upper.mode = 0o755
        with self.assertRaises(ValueError):
            p.validate_members([upper], windows=True)
        upper.mode = 0o4755
        with self.assertRaises(ValueError):
            p.validate_members([upper])
        upper.mode, upper.type, upper.linkname = 0o600, tarfile.SYMTYPE, 'a'
        with self.assertRaises(ValueError):
            p.validate_members([upper], windows=True)

    @unittest.skipIf(sys.platform.startswith('linux'), 'This control applies to the non-Linux host')
    def test_non_linux_native_extraction_refuses_without_output(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            _archive, raw = self.fixture(root)
            source = root/'raw.tar'
            source.write_bytes(raw)
            with self.assertRaises(ValueError):
                p.extract_native(source, root/'tree', hashlib.sha256(raw).hexdigest())
            self.assertFalse((root/'tree').exists())

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Native mode/link/ns positive control requires Linux')
    def test_linux_directory_fd_restore_modes_nanoseconds_and_links(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            source = root/'native.tar'
            with tarfile.open(source, mode='w', format=tarfile.PAX_FORMAT) as archive:
                for name, kind, content, mode, target in [
                    ('capture', tarfile.DIRTYPE, b'', 0o750, ''),
                    ('capture/data', tarfile.REGTYPE, b'exact captured bytes\x00\xff', 0o640, ''),
                    ('capture/sym', tarfile.SYMTYPE, b'', 0o777, 'data'),
                    ('capture/hard', tarfile.LNKTYPE, b'', 0o640, 'capture/data'),
                ]:
                    member = tarfile.TarInfo(name)
                    member.type, member.mode, member.linkname = kind, mode, target
                    member.uid, member.gid = os.getuid(), os.getgid()
                    member.pax_headers = {'mtime': '1792644300.123456789'}
                    member.size = len(content)
                    archive.addfile(member, io.BytesIO(content) if content else None)
            result = p.extract_native(source, root/'tree', p.digest_file(source))
            tree = root/'tree'/'capture'
            self.assertEqual(result['regular_files_verified'], 1)
            self.assertEqual((tree/'data').read_bytes(), b'exact captured bytes\x00\xff')
            self.assertEqual((tree/'sym').readlink(), Path('data'))
            self.assertEqual((tree/'data').stat().st_ino, (tree/'hard').stat().st_ino)
            for relative, mode in [('', 0o750), ('data', 0o640), ('sym', 0o777), ('hard', 0o640)]:
                observed = (tree/relative).lstat()
                self.assertEqual(stat.S_IMODE(observed.st_mode), mode)
                self.assertEqual(observed.st_mtime_ns, 1792644300123456789)

    def test_existing_output_and_foreign_source_sha_refuse(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            archive, _, output, _ = self.packed(root)
            with self.assertRaises(ValueError):
                p.pack(archive, output, p.digest_file(archive))
            with self.assertRaises(ValueError):
                p.pack(archive, root/'foreign', '0'*64)
            self.assertFalse((root/'foreign').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
