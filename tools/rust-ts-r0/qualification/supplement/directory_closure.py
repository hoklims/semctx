"""One frozen caller's empty Git boundary directory, omitted by file capture."""
import hashlib
import json
from pathlib import Path

MANIFEST = '923a03767cd5f675c66f4a35b458dcd6f38554fe3c41f90f5a83eebc7292ddc6'
SOURCE = 'v1-preserved/authority/packages/ts-analyzer/test/workspace-configuration-links.test.ts'
SOURCE_SHA = 'affa90a74bd0b547db5da4c8fb2e88e6a3183dc570894aa0df63d007e4687393'
VECTOR = 'public-vectors/workspace-boundaries-02.json'
VECTOR_SHA = 'cf3c0ec53d07b2773c770aa363a24846a3ddf0ec1324c1d9101f8c8fef9175f3'
ROW = 'workspace-boundaries-02'
FUNCTIONS = {2: 'inspectModuleConfiguration', 3: 'resolveTypeScriptModule'}


def sealed(path, expected):
    raw = Path(path).read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('DIRECTORY_SETUP_AUTHORITY_DIFFERS')
    return raw


def authority(root):
    root = Path(root).resolve()
    manifest = json.loads(sealed(root/'manifest-sha256.json', MANIFEST))
    entries = {row['path']: row for row in manifest['files']}
    if entries[SOURCE]['sha256'] != SOURCE_SHA or entries[VECTOR]['sha256'] != VECTOR_SHA:
        raise ValueError('DIRECTORY_SETUP_MANIFEST_MEMBER_DIFFERS')
    source = sealed(root/SOURCE, SOURCE_SHA).decode('utf-8')
    if 'mkdirSync(join(parent, "repo", ".git"));' not in source.splitlines()[131]:
        raise ValueError('DIRECTORY_SETUP_CALLER_DIFFERS')
    vector = json.loads(sealed(root/VECTOR, VECTOR_SHA))
    return {'manifest_path': str(root/'manifest-sha256.json'), 'manifest_sha256': MANIFEST,
            'source_path': str(root/SOURCE), 'source_sha256': SOURCE_SHA, 'source_line': 132,
            'vector_path': str(root/VECTOR), 'vector_sha256': VECTOR_SHA,
            'kind': 'frozen_caller_empty_directory', 'directory_listing_captured': False}, vector


def prepare(root, row_id, sequence, relocations):
    if row_id != ROW:
        return {}
    proof, vector = authority(root)
    if sequence not in FUNCTIONS or len(relocations) != 1:
        raise ValueError('DIRECTORY_SETUP_OPERATION_DIFFERS')
    original, relocated = relocations[0]
    if original != vector['pathNormalization']['roots'][0]['raw']:
        raise ValueError('DIRECTORY_SETUP_FIXTURE_ROOT_DIFFERS')
    operations = [o for o in vector['operations'] if o['sequence'] == sequence]
    if len(operations) != 1 or operations[0]['baselineFunction'] != FUNCTIONS[sequence]:
        raise ValueError('DIRECTORY_SETUP_OPERATION_DIFFERS')
    return {'physical_empty_directories': [relocated.rstrip('/')+'/repo/.git'],
            'directory_setup_authority': proof}


def attach_request(prepared):
    if prepared.get('row_id') == ROW and prepared['surface'] == 'configured_resolution_cli':
        request = prepared['request']
        request['directories'] = sorted(set(request['directories']) | set(prepared['physical_empty_directories']))


def validate(prepared):
    if prepared.get('row_id') != ROW:
        if prepared.get('physical_empty_directories') or prepared.get('directory_setup_authority'):
            raise ValueError('DIRECTORY_SETUP_OUTSIDE_EXACT_FROZEN_VECTOR')
        return []
    proof = prepared.get('directory_setup_authority')
    if not isinstance(proof, dict) or 'manifest_path' not in proof:
        raise ValueError('DIRECTORY_SETUP_AUTHORITY_MISSING')
    expected = prepare(Path(proof['manifest_path']).parent, ROW, prepared['sequence'], prepared['relocations'])
    if proof != expected['directory_setup_authority'] or prepared.get('physical_empty_directories') != expected['physical_empty_directories']:
        raise ValueError('DIRECTORY_SETUP_AUTHORITY_OR_PATH_DIFFERS')
    if prepared['baseline_function'] != FUNCTIONS[prepared['sequence']]:
        raise ValueError('DIRECTORY_SETUP_FUNCTION_DIFFERS')
    if any('symlink' in item for item in prepared['physical_setup']):
        raise ValueError('DIRECTORY_SETUP_UNEXPECTED_LINK')
    paths = expected['physical_empty_directories']
    if prepared['surface'] == 'configured_resolution_cli':
        expected_dirs = sorted({path.rsplit('/', 1)[0] for path in prepared['request']['files']} | set(paths))
        if prepared['request']['directories'] != expected_dirs:
            raise ValueError('DIRECTORY_SETUP_CAPTURED_DIRECTORIES_DIFFER')
    return paths


def materialize(prepared):
    paths = validate(prepared)
    destination = Path(prepared['case_root']).resolve()
    records = []
    for path in paths:
        target = Path(path)
        if not target.resolve().is_relative_to(destination) or target.resolve() == destination:
            raise ValueError('DIRECTORY_SETUP_ESCAPES_CASE')
        current = target.parent
        while current != destination:
            if current.is_symlink() or not current.is_dir():
                raise ValueError('DIRECTORY_SETUP_PARENT_NOT_OWNED_DIRECTORY')
            current = current.parent
        target.mkdir(parents=False, exist_ok=False)
        if target.is_symlink() or not target.is_dir() or list(target.iterdir()):
            raise ValueError('DIRECTORY_SETUP_NOT_FRESH_EMPTY_DIRECTORY')
        records.append({'path': str(target), 'kind': 'directory', 'empty': True,
                        'authority': prepared['directory_setup_authority']})
    return records
