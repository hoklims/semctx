"""Read-only ABI/fixture preflight. There is deliberately no run command."""
import argparse
import json
from pathlib import Path
import sys

from source_adapter import MANIFEST_SHA, digest, load, resolve, verify_frozen


def validate(registry, frozen, abi_freeze, fixture=None):
    indexed = verify_frozen(frozen)
    document = load(registry.parent, registry.name)
    abi = load(abi_freeze.parent, abi_freeze.name)
    if document.get('manifest_sha256') != MANIFEST_SHA or abi.get('manifest_sha256') != MANIFEST_SHA:
        raise ValueError('foreign ABI source manifest')
    if abi['files']['registry.json'] != digest(registry.read_bytes()):
        raise ValueError('ABI registry bytes differ from frozen draft')
    if document.get('execution_enabled') is not False or abi.get('execution_enabled') is not False:
        raise ValueError('this draft preflight accepts disabled ABI only')
    if document['counts']['original_units_unchanged'] != 354 or document['counts']['original_supports_unchanged'] != 51:
        raise ValueError('original denominator drift')
    sources = [row for row in document['rows'] if row['kind'] == 'source']
    if len(sources) != 67 or len({row['id'] for row in document['rows']}) != len(document['rows']):
        raise ValueError('supplement source denominator/identity drift')
    resolved = 0
    for row in sources:
        for check in row['checks']:
            resolve(frozen, indexed, check['expected_ref'])
            resolved += 1
        recipe = row['recipes'][0]
        if recipe['requests'] != [row['template']]:
            raise ValueError('request projection differs from frozen ABI row')
        expected_checks = [check for check in recipe['checks'] if isinstance(check['expected_origin'], dict)]
        if len(expected_checks) != len(row['checks']):
            raise ValueError('lost or invented frozen comparisons')
        for check in expected_checks:
            if check['expected'] != resolve(frozen, indexed, check['expected_origin']):
                raise ValueError('expected value differs from frozen reference')
        for extra in row['recipes'][1:]:
            if extra['surface']=='snapshot_boundary_cli':
                if extra['expected_nodes']!=resolve(frozen,indexed,extra['expected_nodes_ref']) or extra['expected_error']!=resolve(frozen,indexed,extra['expected_error_ref']) or extra['expected_error_code']!=extra['expected_error'].split(':',1)[0]:
                    raise ValueError('snapshot consumer expectation differs from frozen reference')
    fixture_state = 'NOT_SUPPLIED_NO_CANDIDATE_ACCESS'
    if fixture is not None:
        value = load(fixture.parent, fixture.name)
        for name in ('artifact', 'helper', 'sdk', 'qualification_observer', 'recipes'):
            if digest(Path(value[name+'_path']).read_bytes()) != value[name+'_sha256'].removeprefix('sha256:'):
                raise ValueError('fixture identity mismatch: '+name)
        sdk = json.loads(Path(value['sdk_path']).read_text(encoding='utf-8'))
        authority = load(frozen, 'v1-preserved/observed/typescript-sdk-manifest.json')
        libraries = [row for row in authority['files'] if row['path'].endswith('.d.ts')]
        if sdk['version'] != authority['version'] or len(sdk['files']) != len(libraries):
            raise ValueError('SDK version/library denominator differs')
        for row in libraries:
            text = sdk['files']['/sdk/lib/'+row['path']]
            if digest(text.encode('utf-8')) != row['sha256']:
                raise ValueError('SDK library bytes differ: '+row['path'])
        fixture_state = 'HASHES_AND_PUBLIC_SDK_BYTES_VERIFIED_NO_EXECUTION'
    return {'status': 'DRAFT_PREFLIGHT_ONLY', 'source_rows': len(sources), 'public_rows': len(document['rows'])-len(sources), 'expected_refs_resolved': resolved, 'fixture': fixture_state, 'execution_enabled': False, 'qualification_credit': 0}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--registry', type=Path, required=True)
    parser.add_argument('--frozen', type=Path, required=True)
    parser.add_argument('--abi-freeze', type=Path, required=True)
    parser.add_argument('--fixture', type=Path)
    args = parser.parse_args(argv)
    print(json.dumps(validate(args.registry, args.frozen, args.abi_freeze, args.fixture)))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, KeyError, ValueError) as error:
        print('SUPPLEMENT_PREFLIGHT_REFUSED: '+str(error), file=sys.stderr)
        sys.exit(2)
