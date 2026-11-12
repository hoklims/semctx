"""Store the reviewed public payload with lossless gzip for six large JSON files."""
import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil

ASSEMBLER_SHA = '8c562fc9283671e1dbcaf73ed69f6400f800eba6040d2c2b34040b91c06881e4'
MANIFEST_SHA = '10271ca308c1037dcdea005f88cb1aea9d2415693d2b35af0e9dbd20e45881ce'
COMPRESSED = {
    'macos-custody/complete-export-receipt.json',
    'linux-custody/complete-export-receipt.json',
    'macos-custody/assessment-macos.native.json',
    'linux-custody/assessment-linux.native.json',
    'source-selection/current-source-mechanisms.original.json',
    'draft-ledger/current-96-draft-v1.original.json',
}


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--source-root', required=True, type=Path)
    p.add_argument('--assembler', required=True, type=Path)
    p.add_argument('--manifest', required=True, type=Path)
    p.add_argument('--output', required=True, type=Path)
    p.add_argument('--validate-only', action='store_true')
    args = p.parse_args()
    assert sha(args.assembler) == ASSEMBLER_SHA
    spec = importlib.util.spec_from_file_location('reviewed_public_assembly', args.assembler)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ROOT = args.source_root.absolute()
    module.no_alias(module.ROOT)
    output, raw_manifest, rows = module.prepare(args.manifest, MANIFEST_SHA, args.output)
    assert COMPRESSED <= {r['destination'] for r in rows}
    if args.validate_only:
        print(json.dumps({'status': 'VALIDATED_NO_WRITE', 'files': len(rows), 'gzip_json_files': len(COMPRESSED)}))
        return
    output.mkdir(exist_ok=False)
    assets = []
    for row in rows:
        source = module.ROOT / row['source_path']
        logical = row['destination']
        stored = logical + '.gz' if logical in COMPRESSED else logical
        if logical in {'README.md', 'assemble.py'}:
            stored = 'assembly-preparation/' + logical
        target = output / stored
        target.parent.mkdir(parents=True, exist_ok=True)
        with source.open('rb') as incoming, target.open('xb') as outgoing:
            if logical in COMPRESSED:
                with gzip.GzipFile(filename='', fileobj=outgoing, mode='wb', compresslevel=6, mtime=0) as encoded:
                    shutil.copyfileobj(incoming, encoded, 1024 * 1024)
            else:
                shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
        assert sha(source) == row['sha256'] and source.stat().st_size == row['bytes']
        if logical in COMPRESSED:
            with gzip.open(target, 'rb') as decoded:
                decoded_sha = hashlib.file_digest(decoded, 'sha256').hexdigest()
            assert decoded_sha == row['sha256']
        else:
            assert sha(target) == row['sha256'] and target.stat().st_size == row['bytes']
        assets.append({'logical_path': logical, 'stored_path': stored,
                       'codec': 'gzip' if logical in COMPRESSED else 'identity',
                       'stored_sha256': sha(target), 'stored_bytes': target.stat().st_size,
                       'decoded_sha256': row['sha256'], 'decoded_bytes': row['bytes'],
                       'source_path': row['source_path']})
    (output / 'assembly-manifest.original.json').write_bytes(raw_manifest)
    publisher = output / 'publication' / 'publish.py'
    publisher.parent.mkdir()
    shutil.copyfile(Path(__file__), publisher)
    index = {'schema_version': 1, 'kind': 'PUBLIC_LOSSLESS_STORAGE_INDEX',
             'source_head': '96fedbbe14e8585ae1c89e2656604bf5ecabf2c3',
             'original_assembly_manifest_sha256': MANIFEST_SHA,
             'publisher_sha256': sha(publisher), 'assets': assets,
             'original_payload_bytes': sum(r['bytes'] for r in rows),
             'stored_payload_bytes': sum(r['stored_bytes'] for r in assets),
             'decoded_values_changed': False, 'native_queries': 0,
             'qualification_credit': 0, 'R0_decision': None,
             'limits': ['Storage conversion only; all decoded original bytes were read back and SHA-checked.',
                        'Original raw process and assessment identities remain source-96 identities.',
                        'No gzip archive reconstruction, native extraction, reassessment or qualification.']}
    (output / 'publication-storage-index.json').write_text(json.dumps(index, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': 'PUBLISHED_LOCAL_EXACT_DECODED_PUBLIC_BYTES',
                      'files': len(assets), 'gzip_json_files': len(COMPRESSED),
                      'original_payload_bytes': index['original_payload_bytes'],
                      'stored_payload_bytes': index['stored_payload_bytes'],
                      'storage_index_sha256': sha(output / 'publication-storage-index.json')}))


if __name__ == '__main__':
    main()
