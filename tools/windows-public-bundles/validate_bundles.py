"""Validate pinned public artifact bytes; this does not grant collection authority."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat
import sys

FILES = {
    'preparation': ('preflight.json', 'public-plan.json', 'source-snapshot.json'),
    'prior-native': ('REVIEW.json', 'review.events.jsonl', 'review.prompt.exact',
                     'review-catalog.json', 'review.stderr', 'NATIVE-REVIEW-RECEIPT.json',
                     'native-evidence.json'),
}


def regular(path, directory=False):
    for item in (path, *path.parents):
        metadata = item.lstat()
        if (stat.S_ISLNK(metadata.st_mode)
                or getattr(metadata, 'st_file_attributes', 0) & 0x400):
            raise ValueError('linked or nonregular bundle path')
        is_directory = directory or item != path
        if not (stat.S_ISDIR(metadata.st_mode) if is_directory else stat.S_ISREG(metadata.st_mode)):
            raise ValueError('linked or nonregular bundle path')


def unique_object(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise ValueError('duplicate manifest key')
        result[name] = value
    return result


def validate(root):
    root = Path(root).absolute()
    regular(root, directory=True)
    manifest = root / 'manifest.json'
    regular(manifest)
    raw = manifest.read_bytes()
    if len(raw) > 65536:
        raise ValueError('manifest exceeds size limit')
    data = json.loads(raw, object_pairs_hook=unique_object)
    expected = {f'{bundle}/{name}' for bundle, names in FILES.items() for name in names}
    if (not isinstance(data, dict) or set(data) != {'schema', 'files'}
            or type(data['schema']) is not int or data['schema'] != 1
            or not isinstance(data['files'], dict) or set(data['files']) != expected):
        raise ValueError('manifest file inventory differs')
    for bundle, names in FILES.items():
        folder = root / bundle
        regular(folder, directory=True)
        if {item.name for item in folder.iterdir()} != set(names):
            raise ValueError('bundle file inventory differs')
        for name in names:
            relative = f'{bundle}/{name}'
            path = root / relative
            regular(path)
            pin = data['files'][relative]
            if (not isinstance(pin, dict) or set(pin) != {'bytes', 'sha256'}
                    or type(pin['bytes']) is not int or not 0 <= pin['bytes'] <= 20000000
                    or not isinstance(pin['sha256'], str)
                    or re.fullmatch('[0-9a-f]{64}', pin['sha256']) is None):
                raise ValueError('invalid payload pin')
            if path.stat().st_size != pin['bytes']:
                raise ValueError('payload pin differs: ' + relative)
            payload = path.read_bytes()
            if len(payload) != pin['bytes'] or hashlib.sha256(payload).hexdigest() != pin['sha256']:
                raise ValueError('payload pin differs: ' + relative)
    return data['files']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    print(json.dumps({'files': validate(args.root), 'native_execution': False,
                      'source_admission_granted': False}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        print('PUBLIC_BUNDLES_REFUSED: ' + str(error), file=sys.stderr)
        raise SystemExit(2) from error
