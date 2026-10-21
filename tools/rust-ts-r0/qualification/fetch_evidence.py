import argparse
import base64
import hashlib
import io
import json
import os
import pathlib
import re
import stat
import sys
import tempfile


def verify_archive_bytes(source, entry, destination=None, encoded=False):
    if not source.is_file():
        raise ValueError('custody archive is missing or not a regular file: ' + entry['id'])
    digest = hashlib.sha256()
    size = 0
    with source.open('rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('custody archive is not a regular file: ' + entry['id'])
        if encoded:
            stream = io.BytesIO(base64.b64decode(b''.join(stream.read().split()), validate=True))
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            if size > entry['size_bytes']:
                raise ValueError('archive exceeds indexed size: ' + entry['id'])
            digest.update(chunk)
            if destination is not None:
                destination.write(chunk)
    if size != entry['size_bytes'] or digest.hexdigest() != entry['sha256']:
        raise ValueError('archive size or SHA256 mismatch: ' + entry['id'])
    return size


def verify_or_restore_archives(index_path, source_directory, output, requested):
    index = json.loads(index_path.read_text(encoding='utf-8'))
    entries = index.get('entries') if isinstance(index, dict) else None
    if not isinstance(entries, list) or not entries:
        raise ValueError('archive index has no entries')
    by_id = {}
    paths = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError('invalid archive index entry')
        archive_id = entry.get('id')
        path = entry.get('path')
        size = entry.get('size_bytes')
        digest = entry.get('sha256')
        if (not isinstance(archive_id, str) or re.fullmatch(r'[a-z0-9][a-z0-9_-]*', archive_id) is None
                or path != archive_id + '.tar.gz'
                or type(size) is not int or size < 0
                or not isinstance(digest, str) or re.fullmatch(r'[0-9a-f]{64}', digest) is None):
            raise ValueError('invalid archive identity, path, size or SHA256')
        if archive_id in by_id or path in paths:
            raise ValueError('duplicate archive identity or path')
        by_id[archive_id] = entry
        paths.add(path)
    selected = requested if requested is not None else list(by_id)
    if not selected or len(set(selected)) != len(selected) or any(key not in by_id for key in selected):
        raise ValueError('empty, duplicate or unknown archive selection')
    repository_source = source_directory is None
    repository_root = pathlib.Path(__file__).resolve().parents[3]
    if repository_source:
        for key in selected:
            path = by_id[key].get('repository_path')
            if (not isinstance(path, str)
                    or not path.startswith('docs/research/rust-ts-r0/')
                    or not path.endswith('.tar.gz.b64')
                    or '\\' in path
                    or '..' in pathlib.PurePosixPath(path).parts):
                raise ValueError('missing or invalid repository archive path: ' + key)
        source_directory = repository_root
    if not source_directory:
        raise ValueError('archive source directory is empty')
    source_directory = pathlib.Path(source_directory).expanduser().resolve(strict=True)
    if not source_directory.is_dir():
        raise ValueError('custody source must be a local directory')
    if output is not None:
        output.mkdir(mode=0o700)
    for key in selected:
        entry = by_id[key]
        source = source_directory / entry['repository_path' if repository_source else 'path']
        if output is None:
            size = verify_archive_bytes(source, entry, encoded=repository_source)
            print('verified', key, entry['sha256'], size)
            continue
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=output, prefix='.restore-', delete=False) as stream:
                temporary = pathlib.Path(stream.name)
                size = verify_archive_bytes(source, entry, stream, encoded=repository_source)
                stream.flush()
                os.fsync(stream.fileno())
                verified_identity = os.fstat(stream.fileno())
            if not os.path.samestat(verified_identity, temporary.lstat()):
                raise ValueError('verified temporary archive was replaced: ' + key)
            destination = output / entry['path']
            os.link(temporary, destination)
            if not os.path.samestat(verified_identity, destination.lstat()):
                destination.unlink()
                raise ValueError('published archive differs from verified file: ' + key)
            print('verified', key, entry['sha256'], size)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description='Verify or copy repository T00 archives; optionally use decoded local copies.')
    parser.add_argument('--index', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[3]
                        / 'docs/research/rust-ts-r0/evidence/archive-index.json')
    parser.add_argument('--source-dir', default=os.environ.get('SEMCTX_T00_EVIDENCE_DIRECTORY') or None)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--verify', action='store_true')
    action.add_argument('--output', type=pathlib.Path)
    parser.add_argument('--archive', action='append')
    args = parser.parse_args()
    try:
        output = args.output.expanduser() if args.output is not None else None
        verify_or_restore_archives(args.index, args.source_dir, output, args.archive)
    except (OSError, ValueError) as error:
        print('T00 local archive operation refused:', error, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
