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
    if row_id == ALIAS_ROW:
        return alias_prepare(root, sequence, relocations)
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
    alias_validate(prepared)
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
    # Walk the target's own spelling up to the case root's spelling: a resolved
    # root never equals an aliased lexical parent (e.g. an 8.3 or junction TEMP).
    owner = Path(prepared['case_root']).absolute()
    records = []
    for path in paths:
        target = Path(path)
        if not target.resolve().is_relative_to(destination) or target.resolve() == destination:
            raise ValueError('DIRECTORY_SETUP_ESCAPES_CASE')
        current = target.parent
        if owner.is_symlink() or not owner.is_dir() or getattr(owner.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('DIRECTORY_SETUP_CASE_NOT_OWNED_DIRECTORY')
        while current != owner:
            if not current.is_relative_to(owner):
                raise ValueError('DIRECTORY_SETUP_PARENT_ESCAPES_CASE')
            if current.is_symlink() or not current.is_dir() or getattr(current.lstat(), 'st_file_attributes', 0) & 0x400:
                raise ValueError('DIRECTORY_SETUP_PARENT_NOT_OWNED_DIRECTORY')
            current = current.parent
        target.mkdir(parents=False, exist_ok=False)
        if target.is_symlink() or not target.is_dir() or list(target.iterdir()):
            raise ValueError('DIRECTORY_SETUP_NOT_FRESH_EMPTY_DIRECTORY')
        records.append({'path': str(target), 'kind': 'directory', 'empty': True,
                        'authority': prepared['directory_setup_authority']})
    return records


# The recorder preserves both directory links, but not their empty target.
# This is a separate frozen setup kind, never a generic link/directory API.
ALIAS_ROW = 'directory-alias-03'
ALIAS_SOURCE = 'v1-preserved/authority/packages/ts-analyzer/test/discovery-missing-import-alias.test.ts'
ALIAS_SOURCE_SHA = '831a47b07d71525991bca471bbcff80c6b6de7545e1fe709f8989df58dd44212'
ALIAS_VECTOR = 'public-vectors/directory-alias-03.json'
ALIAS_VECTOR_SHA = '32eb0b6da710f9d6e40f399581b7dac9aa0be1f612fb121ef452c6c6bc635bb0'
CAPTURE_SHA = 'f35139003a1bf954dbfc151e68ece3a5fef7edb95a5dc3d925af6da2b8212e79'


def alias_authority(root):
    root = Path(root).resolve()
    manifest = json.loads(sealed(root/'manifest-sha256.json', MANIFEST))
    entries = {row['path']: row for row in manifest['files']}
    for relative, pin in [(ALIAS_SOURCE, ALIAS_SOURCE_SHA), (ALIAS_VECTOR, ALIAS_VECTOR_SHA), ('capture.ts', CAPTURE_SHA)]:
        if entries[relative]['sha256'] != pin:
            raise ValueError('PRELINK_DIRECTORY_MANIFEST_MEMBER_DIFFERS')
        sealed(root/relative, pin)
    source = sealed(root/ALIAS_SOURCE, ALIAS_SOURCE_SHA).decode('utf-8').splitlines()
    if source[36].strip() != 'const outside = join(parent, "outside"); mkdirSync(outside);' or 'symlinkSync(outside, join(physical, "external")' not in source[37]:
        raise ValueError('PRELINK_DIRECTORY_CALLER_DIFFERS')
    proof = {'kind': 'frozen_caller_empty_existing_symlink_target',
        'manifest_path': str(root/'manifest-sha256.json'), 'manifest_sha256': MANIFEST,
        'source_path': str(root/ALIAS_SOURCE), 'source_sha256': ALIAS_SOURCE_SHA,
        'source_lines': [37, 38], 'vector_path': str(root/ALIAS_VECTOR), 'vector_sha256': ALIAS_VECTOR_SHA,
        'capture_path': str(root/'capture.ts'), 'capture_sha256': CAPTURE_SHA,
        'directory_listing_captured': False, 'additional_symlinks_created': 0}
    return proof, json.loads(sealed(root/ALIAS_VECTOR, ALIAS_VECTOR_SHA))


def alias_prepare(root, sequence, relocations):
    proof, vector = alias_authority(root)
    if sequence != 8 or len(relocations) != 1 or relocations[0][0] != vector['pathNormalization']['roots'][0]['raw']:
        raise ValueError('PRELINK_DIRECTORY_OPERATION_OR_FIXTURE_DIFFERS')
    if len(vector['operations']) != 1 or vector['operations'][0]['sequence'] != 8 or vector['operations'][0]['baselineFunction'] != 'discoverRepository':
        raise ValueError('PRELINK_DIRECTORY_OPERATION_DIFFERS')
    relocated = relocations[0][1].rstrip('/')
    return {'physical_prelink_empty_directories': [relocated+'/outside'], 'prelink_directory_setup_authority': proof}


def alias_validate(prepared):
    if prepared.get('row_id') != ALIAS_ROW:
        if prepared.get('physical_prelink_empty_directories') or prepared.get('prelink_directory_setup_authority'):
            raise ValueError('PRELINK_DIRECTORY_OUTSIDE_EXACT_FROZEN_VECTOR')
        return []
    proof = prepared.get('prelink_directory_setup_authority')
    if not isinstance(proof, dict) or 'manifest_path' not in proof:
        raise ValueError('PRELINK_DIRECTORY_AUTHORITY_MISSING')
    root = Path(proof['manifest_path']).parent
    expected = alias_prepare(root, prepared['sequence'], prepared['relocations'])
    if proof != expected['prelink_directory_setup_authority'] or prepared.get('physical_prelink_empty_directories') != expected['physical_prelink_empty_directories']:
        raise ValueError('PRELINK_DIRECTORY_AUTHORITY_OR_PATH_DIFFERS')
    if prepared['baseline_function'] != 'discoverRepository' or prepared['surface'] != 'repository_discovery_cli':
        raise ValueError('PRELINK_DIRECTORY_FUNCTION_OR_SURFACE_DIFFERS')
    relocated = prepared['relocations'][0][1].rstrip('/')
    if relocated != prepared['case_root'].rstrip('/')+'/fixture-000':
        raise ValueError('PRELINK_DIRECTORY_FIXTURE_LAYOUT_DIFFERS')
    destination = Path(prepared['case_root']).resolve()
    if not Path(relocated).resolve().is_relative_to(destination) or Path(relocated).resolve() == destination:
        raise ValueError('PRELINK_DIRECTORY_ESCAPES_CASE')
    # Bind the already captured links and sole file exactly; do not add a link,
    # silently retarget one, or allow an extra file to precreate the empty target.
    _proof, vector = alias_authority(root)
    closure = vector['operations'][0]['request']['fixtureClosure']
    expected_physical = []
    for entry in closure:
        path = relocated+'/'+entry['path']
        if 'symlink' in entry:
            target = entry['symlink'].replace('\\', '/')
            original = prepared['relocations'][0][0]
            if not target.startswith(original+'/'):
                raise ValueError('PRELINK_DIRECTORY_FROZEN_LINK_UNBOUND')
            expected_physical.append({'path': path, 'symlink': relocated+target[len(original):]})
        else:
            expected_physical.append({'path': path, 'blob_ref': {'path': str(root/'public-vectors'/entry['materializedBlob']), 'sha256': entry['sha256']}, 'size': entry['size']})
    if prepared['physical_setup'] != expected_physical:
        raise ValueError('PRELINK_DIRECTORY_CAPTURED_CLOSURE_DIFFERS')
    return expected['physical_prelink_empty_directories']


def materialize_prelinks(prepared):
    paths = alias_validate(prepared)
    destination = Path(prepared['case_root']).resolve()
    owner = Path(prepared['case_root']).absolute()
    records = []
    for spelling in paths:
        target = Path(spelling)
        if not target.resolve().is_relative_to(destination) or target.resolve() == destination:
            raise ValueError('PRELINK_DIRECTORY_ESCAPES_CASE')
        current = target.parent
        if owner.is_symlink() or getattr(owner.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('PRELINK_DIRECTORY_CASE_NOT_OWNED_DIRECTORY')
        while current != owner:
            if not current.is_relative_to(owner):
                raise ValueError('PRELINK_DIRECTORY_PARENT_ESCAPES_CASE')
            metadata = current.lstat()
            if current.is_symlink() or getattr(metadata, 'st_file_attributes', 0) & 0x400 or not current.is_dir():
                raise ValueError('PRELINK_DIRECTORY_PARENT_NOT_OWNED_DIRECTORY')
            current = current.parent
        target.mkdir(parents=False, exist_ok=False)
        metadata = target.lstat()
        if target.is_symlink() or getattr(metadata, 'st_file_attributes', 0) & 0x400 or not target.is_dir() or list(target.iterdir()):
            raise ValueError('PRELINK_DIRECTORY_NOT_FRESH_EMPTY_DIRECTORY')
        records.append({'path': str(target), 'kind': 'directory', 'empty': True,
            'purpose': 'existing_captured_symlink_target', 'authority': prepared['prelink_directory_setup_authority']})
    return records
