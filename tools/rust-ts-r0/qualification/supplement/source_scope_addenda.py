"""Consumer recipe preparation only; never starts the candidate or derives facts."""
import copy
import json
from pathlib import Path
from source_adapter import (MANIFEST_SHA, TS_OPTIONS, DTO_OPTIONS, digest, load,
                            reference, resolve, verify_frozen)

ADDENDA = {
    'sdk-assignment': ('supplement-sdk-assignment-20261021', 'a302eb10889e2c14f38f5736894a44d817b7fc14362fa569100a8fb3c820db1d', 6),
    'coercion': ('supplement-coercion-20261021', 'e77a81336bc225645f4a89c41ab47abda6d87c1b6ca5bf8750e9641428d0e0e6', 2),
}
SCOPE_IDS = {'reference-unretained', 'reference-retained', 'reference-outside',
             'optional-opaque', 'excluded-parse', 'excluded-computed', 'excluded-unresolved'}


def source_scope_recipe(row, frozen, indexed):
    """Exact observe.ts source50 scope input; actual Program roots stay authoritative."""
    name = row['id'].removeprefix('source::')
    if name not in SCOPE_IDS:
        raise ValueError('outside exact seven source scope witnesses')
    expected = row['expected_refs'][0]
    baseline = resolve(frozen, indexed, expected)
    if baseline['id'] != name or baseline['group'] != 'scope' or 'scope' not in baseline:
        raise ValueError('scope authority mismatch')
    template = copy.deepcopy(row['template'])
    if set(template['files']) != set(baseline['inputFiles']):
        raise ValueError('scope consumed snapshot closure mismatch')
    scope_ref = dict(expected, pointer=expected['pointer'] + '/scope')
    # These are input constants in frozen observe.ts, not values copied from output.
    return {
        'unit_id': row['id'], 'case_id': row['id'], 'surface': 'source_scope_cli',
        'public_flow_kind': 'retained-scope', 'requests': [template],
        'source_scope_origin': MANIFEST_SHA, 'allow_unborn_head': True,
        'include': ['main.ts'], 'exclude': [],
        'physical_files': copy.deepcopy(template['files']),
        'physical_current_files': copy.deepcopy(template['files']),
        'git_setup': [['git', 'init', '-q']], 'git_after_current': [],
        'scope_input': {'graph': {'nodes': [], 'edges': []},
                        'expectedInputHash': 'retained-witness',
                        'consumed_digest': 'retained-witness',
                        'retainedCompilerInputs': None, 'checkChanged': False},
        'broad_discovery_request': {'repositoryRoot': '$WORKSPACE', 'config': {
            'version': 2, 'include': ['**/*'], 'exclude': [],
            'languages': {'typescript': 'on', 'python': 'on', 'markdown': 'on', 'sql': 'on'},
            'migrationsDirs': ['migrations']}},
        'expected_scope': resolve(frozen, indexed, scope_ref), 'expected_scope_ref': scope_ref,
        'checks': [], 'gaps': [], 'relations': [],
        'input_authority': reference(indexed, 'v1-preserved/observe.ts'),
        'actual_program_refs': row['actual_program_refs'],
    }


def attach_source_scopes(document, frozen):
    """Call AFTER ordinary source recipes exist; leaves the 67/25 denominators intact."""
    indexed = verify_frozen(frozen)
    found = set()
    for row in document['rows']:
        name = row['id'].removeprefix('source::')
        if row.get('kind') != 'source' or name not in SCOPE_IDS:
            continue
        recipe = source_scope_recipe(row, frozen, indexed)
        row['recipes'].append(recipe)
        row['operation_mappings'].append({'baseline_operation': 'inspectRetainedQualifiedScope',
            'entrypoint': 'source_scope_cli', 'selector': [], 'expected_ref': recipe['expected_scope_ref']})
        row['gaps'] = [g for g in row['gaps'] if g != 'UNKNOWN_NATIVE_LIFECYCLE_MAPPING']
        row['unmapped_expected_fields'] = [g for g in row['unmapped_expected_fields']
            if g != 'scope: whole inspectRetainedQualifiedScope result, not syntax-only observation']
        row['recipes'][0]['supplement_unmapped_properties'] = row['gaps'] + row['unmapped_expected_fields']
        found.add(name)
    if found != SCOPE_IDS:
        raise ValueError('seven source scope mapping incomplete')
    return document


def sealed_addendum(root, seal):
    raw = (root / 'manifest.json').read_bytes()
    if digest(raw) != seal:
        raise ValueError('foreign addendum manifest')
    indexed = {}
    for entry in json.loads(raw)['files']:
        name = entry['path']
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or '\\' in name or name in indexed:
            raise ValueError('unsafe/duplicate addendum entry')
        target = root / path
        if root.is_symlink() or any(root.joinpath(*path.parts[:n]).is_symlink() for n in range(1, len(path.parts)+1)):
            raise ValueError('symlink addendum entry')
        data = target.read_bytes()
        if len(data) != entry['size'] or digest(data) != entry['sha256']:
            raise ValueError('addendum entry bytes differ: ' + name)
        indexed[name] = entry
    return indexed


def prepare_addenda(cases_root):
    """Separate eight-row document; original354/51 and source67/public25 are untouched."""
    rows = []
    seals = {}
    for family, (directory, seal, count) in ADDENDA.items():
        root = cases_root / directory
        indexed = sealed_addendum(root, seal)
        seals[family] = seal
        expected = load(root, 'expected.json')
        cases = load(root, 'cases.json')
        if len(expected) != count or [x['id'] for x in expected] != [x['id'] for x in cases]:
            raise ValueError('addendum denominator/identity differs')
        for index, baseline in enumerate(expected):
            case = cases[index]
            text = (root / case['path']).read_bytes().decode('utf-8')
            source = baseline['request']['semantic']['source']
            snapshot = baseline['request']['semantic']['snapshot']
            config = baseline['request']['configuration']
            if source['text'] != text or source['languageVersion'] != 99 or source['setParentNodes'] is not True:
                raise ValueError('addendum supplied SourceFile differs')
            if snapshot != [[source['path'], text]] or config['compilerInputs'] != snapshot or config['path'] != source['path']:
                raise ValueError('addendum retained input differs')
            if config['source'] != {'$undefined': True} or config['workspaceLinks'] != {'$undefined': True}:
                raise ValueError('addendum configuration invocation differs')
            programs = baseline['actualProgramRecords']
            if len(programs) != 2:
                raise ValueError('both actual semantic Program use sites required')
            for program in programs:
                if (program['options'] != TS_OPTIONS or program['compilerVersion'] != '5.9.3'
                        or program['rootNames'] != [source['path']] or program['retained'] != snapshot):
                    raise ValueError('actual Program contract differs; no substitution allowed')
            identity = 'addendum::' + family + '-' + case['id']
            origin = {'manifest_sha256': seal, 'path': str(root / 'expected.json'),
                      'sha256': indexed['expected.json']['sha256'], 'pointer': '/' + str(index)}
            checks = []
            for component, field, operation in [(['subjects', {'path': 'main.ts'}, 'semanticObservation'], 'semantic', 'inspectSemanticDependencies'),
                    (['subjects', {'path': 'main.ts'}, 'moduleConfigurationObservations', 'retainedWithoutSource'], 'configuration', 'inspectModuleConfiguration')]:
                authority = dict(origin, pointer=origin['pointer'] + '/response/' + field)
                target = component + ['reasons']
                checks.append({'target': target, 'mode': 'eq', 'actual_transform': 'none',
                    'expected': baseline['response'][field], 'expected_origin': authority,
                    'operation_binding': {'status': 'VERIFIED_SOURCE_OPERATION', 'target': target,
                        'baseline_operation': operation, 'authority': authority}})
                checks.extend({'target': component + [key], 'mode': 'eq', 'actual_transform': 'none',
                    'expected': value, 'expected_origin': 'adapter component completeness guard'}
                    for key, value in [('executed', True), ('unsupported', [])])
            template = {'id': identity, 'files': {'main.ts': text}, 'roots': ['main.ts'],
                'options': DTO_OPTIONS.copy(), 'retained': True, 'qualified': False,
                'sdk_directory': '/sdk/lib', 'roles': {}, 'selection': {}, 'disabled': [],
                'raw_files': {}, 'utf16_files': {}}
            rows.append({'id': identity, 'kind': 'addendum', 'execution_enabled': False,
                'expected_ref': origin, 'actual_program_refs': [dict(origin, pointer=origin['pointer'] + '/actualProgramRecords/' + str(i)) for i in range(2)],
                'recipes': [{'unit_id': identity, 'case_id': identity, 'surface': 'raw_cli',
                    'requests': [template], 'checks': checks, 'relations': [], 'gaps': [],
                    'physical_live_after_capture': {}, 'supplement_unmapped_properties': []}],
                'gaps': [], 'qualification_credit': 0})
    if len(rows) != 8 or len({row['id'] for row in rows}) != 8:
        raise ValueError('eight independent addendum rows required')
    return {'schema_version': 1, 'status': 'DISABLED_ADDENDA_CONSUMER_RECIPES',
            'execution_enabled': False, 'candidate_execution_authorized': False,
            'manifest_sha256_by_family': seals, 'counts': {'addenda': 8}, 'rows': rows,
            'qualification_credit': 0}
