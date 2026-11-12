"""Static supplement ABI preparation. Never imports or invokes the candidate."""
import hashlib
import json
from pathlib import Path

MANIFEST_SHA = '923a03767cd5f675c66f4a35b458dcd6f38554fe3c41f90f5a83eebc7292ddc6'
TS_OPTIONS = {'target': 9, 'module': 99, 'moduleResolution': 100, 'allowJs': True, 'jsx': 1, 'skipLibCheck': True, 'noEmit': True, 'strict': False}
DTO_OPTIONS = {'target': 'ES2022', 'module': 'ESNext', 'moduleResolution': 'Bundler', 'allowJs': True, 'jsx': 'Preserve', 'skipLibCheck': True, 'noEmit': True, 'strict': False}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load(root, path):
    return json.loads((root / path).read_text(encoding='utf-8'))


def verify_frozen(root):
    manifest_path = root / 'manifest-sha256.json'
    if digest(manifest_path.read_bytes()) != MANIFEST_SHA:
        raise ValueError('frozen manifest identity differs')
    manifest = load(root, 'manifest-sha256.json')
    indexed = {}
    for row in manifest['files']:
        path = Path(row['path'])
        if path.is_absolute() or '..' in path.parts or '\\' in row['path']:
            raise ValueError('unsafe manifest path')
        target = root / path
        if root.is_symlink() or any(root.joinpath(*path.parts[:index]).is_symlink() for index in range(1, len(path.parts)+1)):
            raise ValueError('symlink in frozen reference path: ' + row['path'])
        try:
            target.resolve().relative_to(root.resolve())
        except ValueError as error:
            raise ValueError('frozen path escapes root') from error
        if target.is_symlink() or not target.is_file():
            raise ValueError('frozen regular file missing: ' + row['path'])
        data = target.read_bytes()
        if len(data) != row['size'] or digest(data) != row['sha256']:
            raise ValueError('frozen file identity differs: ' + row['path'])
        if row['path'] in indexed:
            raise ValueError('duplicate manifest path')
        indexed[row['path']] = row
    return indexed


def reference(indexed, path, pointer=''):
    if path not in indexed:
        raise ValueError('reference outside frozen manifest: ' + path)
    return {'manifest_sha256': MANIFEST_SHA, 'path': path, 'sha256': indexed[path]['sha256'], 'pointer': pointer}


def pointer(document, path):
    value = document
    if path:
        if not path.startswith('/'):
            raise ValueError('invalid JSON pointer')
        for part in path[1:].split('/'):
            key = part.replace('~1', '/').replace('~0', '~')
            value = value[int(key)] if isinstance(value, list) else value[key]
    return value


def resolve(root, indexed, ref):
    if ref['manifest_sha256'] != MANIFEST_SHA or indexed.get(ref['path'], {}).get('sha256') != ref['sha256']:
        raise ValueError('foreign frozen reference')
    return pointer(load(root, ref['path']), ref['pointer'])


def check(target, expected_ref, operation, components=()):
    return {'target': target, 'expected_ref': expected_ref, 'mode': 'eq', 'actual_transform': 'none', 'operation': operation, 'complete_components': list(components)}


def source_rows(root, indexed):
    programs = load(root, 'actual-semantic-programs.json')['records']
    original_path = 'v1-preserved/expected-observables.json'
    original = load(root, original_path)
    rows = []
    for number, baseline in enumerate(original):
        name = baseline['id']
        fixture_prefix = 'v1-preserved/observed/fixtures/' + name + '/'
        physical = {path[len(fixture_prefix):]: (root / path).read_bytes().decode('utf-8') for path in indexed if path.startswith(fixture_prefix)}
        files = {path: text for path, text in physical.items() if path in baseline['inputFiles']}
        if set(files) != set(baseline['inputFiles']):
            raise ValueError('source fixture closure differs: ' + name)
        main = 'main.d.ts' if name == 'computed-dts' else 'main.ts'
        contexts = [(i, row) for i, row in enumerate(programs) if row['stream'] == 'source-50' and '/fixtures/' + name + '/' in row['sourcePath']]
        row = make_row(name, files, main, reference(indexed, original_path, '/' + str(number)), contexts, programs, indexed)
        row['physical_only_files'] = {path: text for path, text in physical.items() if path not in files}
        base = '/'+str(number)
        row['checks'] = [check(['subjects', {'path': main}, 'javascript', 'native', key], reference(indexed, original_path, base+'/native/'+key), 'inspectNativeModuleBindings', [['subjects', {'path': main}, 'sourceFileObservation']]) for key in baseline['native']]
        component = ['subjects', {'path': main}, 'moduleConfigurationObservations', 'retainedWithoutSource']
        row['checks'].append(check(component + ['reasons'], reference(indexed, original_path, base+'/configuration'), 'inspectModuleConfiguration', [component]))
        row['provenance_only_fields'] = ['compilerBindingOrigins: auxiliary standalone Program, not the actual configuration use site', 'compilerOptions: auxiliary Program input; actual use-site context is authoritative where present']
        row['unmapped_expected_fields'] = []
        if name == 'snapshot':
            row['snapshot_boundary'] = {'refusal_ref': reference(indexed, original_path, base+'/absentSnapshot'), 'graph_nodes_ref': reference(indexed, original_path, base+'/validCaptureNodes'), 'workspace_name': name, 'request_operation': 'qualified analyzeRepository with/without retained inputs', 'refusal_projection': 'Exact complete frozen SOURCE_SNAPSHOT_REQUIRED error string, including its explanatory suffix; the code prefix remains provenance only. stderr/stdout/exit remain raw and refusal carries no useful compiler facts.'}
        if 'scope' in baseline:
            row['gaps'].append('UNKNOWN_NATIVE_LIFECYCLE_MAPPING')
            row['unmapped_expected_fields'].append('scope: whole inspectRetainedQualifiedScope result, not syntax-only observation')
        if name == 'computed-dts':
            row['gaps'].append('UNKNOWN_NATIVE_DECLARATION_ONLY_ROOT_SUBJECT')
        rows.append(row)
    additional_path = 'expected-additional-observables.json'
    additional = load(root, additional_path)['results']
    for number, baseline in enumerate(additional):
        name = baseline['id']
        contexts = [(i, row) for i, row in enumerate(programs) if row['stream'] == 'additional-17' and '/additions/' + name + '/' in row['sourcePath']]
        row = make_row(name, {'main.ts': baseline['source']}, 'main.ts', reference(indexed, additional_path, '/results/'+str(number)), contexts, programs, indexed)
        if 'configuration' in baseline:
            component = ['subjects', {'path': 'main.ts'}, 'moduleConfigurationObservations', 'retainedWithoutSource']
            row['checks'] = [check(component + ['reasons'], reference(indexed, additional_path, '/results/'+str(number)+'/configuration'), 'inspectModuleConfiguration', [component])]
            row['unmapped_expected_fields'] = []
        else:
            row['checks'] = [check(['outlines', 'main.ts', 'outline'], reference(indexed, additional_path, '/results/'+str(number)+'/outline'), 'outlineTopLevel')]
            row['unmapped_expected_fields'] = []
            row['parser_contract'] = {'baseline_target': 'Latest', 'source_authority': reference(indexed, 'additions.ts'), 'entrypoint': 'raw outline of unchanged Program SourceFile', 'scope': 'Only these ten frozen main.ts byte streams: operator/let-var/type-only-export/raw-template/trivia syntax all recognized at ES2022. No emit, downlevel transform, checker query or SDK-derived fact enters outline::outline/digest; it consumes SourceFile AST and exact source text. Existing whole-outline frozen comparisons retain every actual difference.', 'source_evidence': ['main.rs outlines.insert(program::get_source_file, ast::source_file_text)', 'outline.rs::outline and digest: AST traversal, raw template spelling, scanner with skipped trivia; no compiler-option input'], 'arbitrary_future_syntax_supported': False, 'numeric_enum_mirror_required': False}
            row['parameters']['case_policy'] = 'Outline projection on one unchanged ASCII main.ts input is path/case independent; bind actual request case and source bytes without claiming a baseline Program.'
        rows.append(row)
    if len(rows) != 67 or len({row['id'] for row in rows}) != 67:
        raise ValueError('source67 denominator or identity drift')
    return rows


def make_row(name, files, main, expected_ref, contexts, programs, indexed):
    context_refs = [reference(indexed, 'actual-semantic-programs.json', '/records/'+str(index)) for index, _ in contexts]
    gaps = []
    roots = [main]
    for _, context in contexts:
        if context['options'] != TS_OPTIONS:
            gaps.append('UNKNOWN_COMPILER_OPTION_TRANSLATION')
        prefix = context['sourcePath'].rsplit('/', 1)[0] + '/'
        actual_roots = [path.removeprefix(prefix) for path in context['rootNames']]
        if any(path not in files for path in actual_roots):
            gaps.append('UNKNOWN_EFFECTIVE_ROOT_OUTSIDE_FROZEN_FIXTURE')
        elif roots != [main] and roots != actual_roots:
            gaps.append('UNKNOWN_MULTIPLE_PROGRAM_ROOT_CONTRACTS')
        else:
            roots = actual_roots
    return {'id': 'source::'+name, 'kind': 'source', 'entrypoint': 'run_raw_recipe', 'expected_refs': [expected_ref], 'input_refs': [reference(indexed, path) for path in indexed if path.startswith('v1-preserved/observed/fixtures/'+name+'/')] or [expected_ref], 'actual_program_refs': context_refs, 'baseline_program_created': bool(contexts), 'parameters': {'actual_contexts_take_precedence': True, 'auxiliary_program_may_substitute': False, 'compiler_options_ts': TS_OPTIONS, 'compiler_options_dto': DTO_OPTIONS, 'case_sensitive': None, 'baseline_observed_case_sensitive': contexts[0][1]['caseSensitive'] if contexts else None, 'case_policy': 'Measure and bind the actual host through existing materialize(); baseline case flag is observed host provenance, not a forced false input. Explicit case/alias witnesses remain separate.', 'case_authority': 'baseline ts-symbols.ts createCompilerHost(COMPILER_OPTIONS) inherits ts.sys; capture.ts records ts.sys.useCaseSensitiveFileNames; existing qualification materialize() binds measured host mode'}, 'template': {'id': 'supplement-source-'+name, 'files': files, 'roots': roots, 'options': DTO_OPTIONS, 'retained': True, 'qualified': False, 'sdk_directory': '/sdk/lib', 'roles': {}, 'selection': {}, 'disabled': [], 'utf16_files': {}, 'raw_files': {}}, 'operation_mappings': [], 'checks': [], 'gaps': sorted(set(gaps)), 'qualification_credit': 0, 'state': 'DRAFT_ABI_NOT_NATIVE_EXECUTED'}


def materialize_checks(row, root, indexed):
    checks = []
    for draft in row['checks']:
        check_value = {key: value for key, value in draft.items() if key not in ['expected_ref', 'operation', 'complete_components']}
        check_value['expected'] = resolve(root, indexed, draft['expected_ref'])
        check_value['expected_origin'] = draft['expected_ref']
        if draft['target'][-1] == 'reasons':
            check_value['operation_binding'] = {'status': 'VERIFIED_SOURCE_OPERATION', 'target': draft['target'], 'baseline_operation': draft['operation'], 'authority': draft['expected_ref']}
        checks.append(check_value)
        for component in draft['complete_components']:
            for field, expected in [('executed', True), ('unsupported', [])]:
                guard = {'target': component+[field], 'expected': expected, 'mode': 'eq', 'actual_transform': 'none', 'expected_origin': 'component completeness required by adapter; not an invented baseline output'}
                if guard not in checks:
                    checks.append(guard)
    return {'unit_id': row['id'], 'case_id': row['id'], 'surface': 'raw_cli', 'requests': [row['template']], 'checks': checks, 'gaps': [], 'relations': [], 'physical_uncaptured_files': row.get('physical_only_files', {}), 'physical_live_after_capture': {}, 'supplement_unmapped_properties': row['gaps'] + row.get('unmapped_expected_fields', [])}
