"""Public R0 lifecycle consumer recipes. No process execution and no expected-derived facts."""
import json
import re
import base64
import posixpath
import argparse
from pathlib import Path
import public_adapter as a
from public_runtime import Gap, resolve_ref, normalize

OUTPUTS = {'dist', 'build', 'coverage', '.turbo', '.next'}
HARD = {'node_modules', '.git', '.semctx'}


def vector_and_operation(root, row_id, sequence):
    root = Path(root)
    if a.digest((root / 'manifest-sha256.json').read_bytes()) != a.MANIFEST_SHA:
        raise Gap('FOREIGN_FROZEN_MANIFEST')
    inventory = {f['path']: f for f in a.load(root / 'manifest-sha256.json')['files']}
    relative = 'public-vectors/' + row_id + '.json'
    vector = resolve_ref({'path': str(root / relative), 'sha256': inventory[relative]['sha256']})
    matches = [o for o in vector['operations'] if o['sequence'] == sequence]
    if len(matches) != 1:
        raise Gap('OPERATION_SEQUENCE_ABSENT_OR_DUPLICATED')
    return root, vector, matches[0], root / relative


def closure_files(operation, repository, root):
    result = {}
    for item in operation['request']['fixtureClosure']:
        if a.normalize_path(item['root']).lower() != a.normalize_path(repository).lower():
            continue
        a.validate_closure([item])
        if 'symlink' in item:
            raise Gap('LIFECYCLE_SYMLINK_NOT_IN_BOUNDED_PUBLIC_CASES')
        blob = root / 'public-vectors' / item['materializedBlob']
        raw = blob.read_bytes()
        if a.digest(raw) != item['sha256'] or len(raw) != item['size']:
            raise Gap('FROZEN_BLOB_HASH_MISMATCH')
        text = raw.decode('utf-8')
        if text.encode('utf-8') != raw:
            raise Gap('LIFECYCLE_TEXT_ROUNDTRIP_MISMATCH')
        result[item['path']] = text
    if not result:
        raise Gap('LIFECYCLE_ROOT_CLOSURE_ABSENT')
    return result


def selection(path, config):
    # Exact bounded public selector, not a general reimplementation of Bun.Glob.
    if config['include'] == ['src/**/*.ts'] and config.get('exclude') == ['node_modules', 'dist', '.semctx', '.git', 'coverage']:
        return path.startswith('src/') and path.endswith('.ts')
    if config['include'] == ['**/*'] and config.get('exclude') == []:
        return not HARD.intersection(path.split('/'))
    raise Gap('QUALIFIED_PUBLIC_SELECTOR_OUTSIDE_BOUNDED_RECIPE')


def prepare_lifecycle(frozen_root, row_id, sequence, case_root, sdk_directory, case_sensitive):
    root, vector, operation, vector_path = vector_and_operation(frozen_root, row_id, sequence)
    name = operation['baselineFunction']
    args = operation['request']['arguments']
    if name in ('indexRepository', 'runVerify'):
        repository = args[0]
    elif name == 'discoverRepository':
        repository = args[0]['repositoryRoot']
    elif name == 'inspectRetainedQualifiedScope':
        repository = args[0]['config']['repositoryRoot']
    else:
        raise Gap('UNSUPPORTED_LIFECYCLE_FUNCTION')
    native_root = case_root.rstrip('/') + '/workspace'
    current = closure_files(operation, repository, root)
    index_calls = [o for o in vector['operations'] if o['baselineFunction'] == 'indexRepository'
                   and a.normalize_path(o['request']['arguments'][0]).lower() == a.normalize_path(repository).lower()]
    if not index_calls and name != 'inspectRetainedQualifiedScope':
        raise Gap('PUBLIC_INITIAL_GIT_SNAPSHOT_ABSENT')
    if index_calls:
        initial = closure_files(index_calls[0], repository, root)
        discovery = next((o for o in vector['operations'] if o['baselineFunction'] == 'discoverRepository'
                          and o['parent'] == index_calls[0]['sequence']), None)
        if discovery is None:
            raise Gap('PUBLIC_CONFIG_INPUT_NOT_CAPTURED')
        config = discovery['request']['arguments'][0]
        root_capture_sequence = index_calls[0]['sequence']
    else:
        # Immutable old-capture scope uses a separate baseline clone. Scope has no
        # Git parameter and needs no invented historical index/commit for that clone.
        initial = current.copy()
        config = args[0]['config']
        root_capture_sequence = sequence
    captured = {p: text for p, text in current.items() if not HARD.intersection(p.split('/'))
                and not OUTPUTS.intersection(p.split('/')[:-1])}
    # Qualified metadata inside output directories is admitted by its actual native
    # metadata walk. Public generated witness contains only an unretained .ts source.
    if any(OUTPUTS.intersection(p.split('/')[:-1]) and p.endswith(('.json', '.toml')) for p in current):
        raise Gap('OUTPUT_METADATA_REQUIRES_NATIVE_CAPTURE_EXPANSION')
    roots = [p for p in captured if selection(p, config) and re.search(r'\.(?:[cm]?[tj]sx?)$', p)]
    if not roots:
        raise Gap('QUALIFIED_PUBLIC_SELECTED_ROOTS_EMPTY')
    position = vector['operations'].index(operation)
    request = {'id': row_id + ':' + str(sequence), 'files': captured, 'roots': roots,
        'options': a.OPTIONS_NATIVE.copy(), 'sdk_directory': sdk_directory,
        'retained': True, 'qualified': True, 'roles': {}, 'selection': {}, 'disabled': [],
        'raw_files': {}, 'utf16_files': {}}
    # Existing materialize() consumes relative request templates. The actual root,
    # case mode and SDK paths are attached by the native supervisor at run time.
    result = {'row_id': row_id, 'sequence': sequence, 'baseline_function': name,
        'surface': 'qualified_flow_cli', 'public_flow_kind': 'index-store' if name == 'indexRepository' else 'qualified-discovery' if name == 'discoverRepository' else 'retained-scope' if name == 'inspectRetainedQualifiedScope' else 'public-verify',
        'execution_enabled': False, 'case_root': case_root, 'repository_root': native_root,
        'requests': [request], 'physical_files': initial, 'physical_current_files': current,
        'include': config['include'], 'exclude': config['exclude'], 'checks': [], 'gaps': [],
        'source_capture_stream_sha256': 'sha256:' + vector['rawStream']['sha256'],
        'request_ref': a.ref(vector_path, '/operations/' + str(position) + '/request'),
        'expected_ref': a.ref(vector_path, '/operations/' + str(position) + '/normalizedProjection'),
        'relocations': [(a.normalize_path(repository), native_root)], 'path_normalization': vector['pathNormalization'],
        'git_setup': [['git', 'init', '-q'], ['git', 'add', '.'], ['git', '-c', 'user.name=T00Fixture', '-c', 'user.email=t00@example.test', 'commit', '-qm', 'initial']],
        'git_after_current': [], 'root_capture_sequence': root_capture_sequence}
    if row_id == 'scope-admission-02' and 'package.json' in current and 'package.json' not in initial:
        # Frozen authority test explicitly commits only this new manifest before
        # modifying main.ts. Never stage the dirty source while creating that commit.
        result['git_after_current'] = [['git', 'add', 'package.json'], ['git', '-c', 'user.name=T00Fixture', '-c', 'user.email=t00@example.test', 'commit', '-qm', 'track optional dependency fixture']]
    if name == 'discoverRepository':
        query_config = args[0]
        eligibility_config = args[1] if len(args) > 1 else query_config
        paths = sorted(current)
        result['discovery_config'] = {k: query_config[k] for k in ('version', 'include', 'exclude', 'languages', 'migrationsDirs')}
        result['eligibility_queries'] = paths
        result['eligibility_include'] = eligibility_config['include']
        result['eligibility_exclude'] = eligibility_config['exclude']
        result['native_system_queries'] = [{'operation': 'read_file', 'path': p} for p in paths]
        result['ordinary_discovery_request'] = {'repositoryRoot': native_root, 'config': result['discovery_config']}
    elif name == 'inspectRetainedQualifiedScope':
        scope = args[0]
        consumed = scope['consumedInputs']
        files = {}
        for f in consumed['files']:
            raw = base64.b64decode(f['bytes']['$bytes'], validate=True)
            files[f['path']] = raw.decode('utf-8', errors='replace')
        result['requests'][0]['files'] = files
        result['requests'][0]['roots'] = [p for p in files if re.search(r'\.(?:[cm]?[tj]sx?)$', p)]
        result['scope_input'] = {'graph': scope['graph'], 'expectedInputHash': scope['expectedInputHash'],
            'consumed_digest': consumed['digest'], 'retainedCompilerInputs': scope.get('retainedCompilerInputs'),
            'checkChanged': scope['checkChanged']}
    elif name == 'runVerify':
        if args[1] != {'kind': 'working-tree'}:
            raise Gap('NATIVE_VERIFY_SUPPORTS_WORKING_TREE_ONLY')
        result['native_verification'] = {'descriptor_from_actual_index': True, 'mode': ['verify', 'working-tree'], 'fail_on': 'none'}
        # The native CLI emits a bounded admission DTO. The full public report adds
        # repository coverage, freshness and task outcomes that are not emitted here.
        result['projection_gap'] = 'NATIVE_VERIFY_PUBLIC_COVERAGE_FRESHNESS_AND_VERDICT_DTO_NOT_EXPOSED'
    semantic = {k: result[k] for k in ['public_flow_kind', 'physical_files', 'physical_current_files', 'requests', 'include', 'exclude', 'git_after_current']}
    semantic['origin_root'] = a.normalize_path(repository)
    semantic['root_capture_sequence'] = root_capture_sequence
    for key in ['scope_input', 'discovery_config', 'eligibility_queries', 'eligibility_include', 'eligibility_exclude']:
        if key in result:
            semantic[key] = result[key]
    # Operation IDs do not split otherwise identical temporal input snapshots.
    normalized = json.loads(json.dumps(semantic))
    for template in normalized['requests']:
        template.pop('id', None)
    result['invocation_group_id'] = a.digest(a.canonical(normalized))
    return result


def build_overlay(frozen_root):
    root = Path(frozen_root)
    rows = []
    counts = {}
    for row_id in ['scope-admission-01', 'scope-admission-02', 'scope-admission-03']:
        vector = a.load(root / 'public-vectors' / (row_id + '.json'))
        for operation in vector['operations']:
            name = operation['baselineFunction']
            selected = name in ('indexRepository', 'runVerify', 'inspectRetainedQualifiedScope')
            if name == 'discoverRepository':
                repository = operation['request']['arguments'][0]['repositoryRoot']
                files = closure_files(operation, repository, root)
                selected = any(OUTPUTS.intersection(path.split('/')[:-1]) for path in files)
            if not selected:
                continue
            recipe = prepare_lifecycle(root, row_id, operation['sequence'], '/case', '/sdk/lib', True)
            counts[name] = counts.get(name, 0) + 1
            rows.append({'id': row_id, 'sequence': operation['sequence'], 'kind': name,
                'status': 'UNKNOWN_PUBLIC_DTO' if 'projection_gap' in recipe else 'PREPARED_NOT_RUN',
                'request_ref': recipe['request_ref'], 'expected_ref': recipe['expected_ref'], 'recipe': recipe})
    if len(rows) != 34:
        raise Gap('LIFECYCLE_OVERLAY_DENOMINATOR_CHANGED')
    return {'schema_version': 1, 'manifest_sha256': a.MANIFEST_SHA,
        'execution_enabled': False, 'native_queries': 0, 'counts': counts,
        'operation_overrides': rows, 'global_admission': 'UNKNOWN',
        'distinct_invocation_groups': len({row['recipe']['invocation_group_id'] for row in rows})}


def project_index_store(prepared, observed):
    # This property observes a real index write/read; no DTO positive is fabricated.
    if observed.get('index_store_written') is not True or observed.get('index_store_readback_equal') is not True:
        raise Gap('ACTUAL_NATIVE_INDEX_STORE_NOT_OBSERVED')
    if not observed.get('index_batch_id') or not observed.get('git_head'):
        raise Gap('ACTUAL_NATIVE_INDEX_IDENTITY_ABSENT')
    return {'statefulSetupObserved': True}


def project_qualified_discovery(prepared, observed):
    ordinary = observed['ordinary_discovery']
    eligibility = observed['eligibility']
    system = observed['system']
    if ordinary.get('executed') is not True or ordinary.get('unsupported') != []:
        raise Gap('ORDINARY_DISCOVERY_NOT_EXECUTED')
    if eligibility.get('eligibility_established') is not True or eligibility.get('queries') != prepared['eligibility_queries']:
        raise Gap('ACTUAL_GIT_ELIGIBILITY_NOT_ESTABLISHED')
    outcomes = eligibility['eligible_results']
    if len(outcomes) != len(prepared['eligibility_queries']) or any(type(v) is not bool for v in outcomes):
        raise Gap('ELIGIBILITY_DENOMINATOR_MISMATCH')
    reads = {entry['path']: entry for entry in system['results']}
    candidates = {entry['relPath']: entry for entry in ordinary['candidates']}
    selected = {entry['relPath']: entry for entry in ordinary['files']}
    result_candidates, result_files = [], []
    for relative, eligible in zip(prepared['eligibility_queries'], outcomes, strict=True):
        absolute = prepared['repository_root'] + '/' + relative
        read = reads.get(absolute)
        if read is None or read.get('found') is not True or read.get('unsupported') != [] or read.get('refusals') != []:
            raise Gap('PHYSICAL_NATIVE_FILE_READ_NOT_OBSERVED')
        if read['value'] != prepared['physical_current_files'][relative]:
            raise Gap('PHYSICAL_NATIVE_FILE_BYTES_CHANGED')
        if not eligible:
            result_candidates.append({'relPath': relative, 'selectionDecision': 'excluded', 'analysisOutcome': 'not_applicable', 'reason': 'IGNORED_GENERATED_OUTPUT'})
        else:
            if relative not in candidates:
                raise Gap('ELIGIBLE_NATIVE_DISCOVERY_CANDIDATE_MISSING')
            row = candidates[relative]
            result_candidates.append({k: row[k] for k in ('relPath', 'selectionDecision', 'analysisOutcome', 'reason') if k in row})
            if relative in selected:
                file = selected[relative]
                result_files.append({k: file[k] for k in ('relPath', 'role', 'language', 'content')})
    return normalize({'candidates': result_candidates, 'files': result_files}, prepared)


def project_retained_scope(prepared, observed):
    native = observed['raw_scope']
    if native.get('complete') is not True or native.get('global_admission_inferred') is not False:
        raise Gap('INCOMPLETE_NATIVE_SCOPE_OBSERVATION')
    extraction = native['raw_extraction']
    scope = prepared['scope_input']
    links = [[entry['fromRelPath'], entry['resolvedRelPath']] for entry in extraction['imports'] if 'resolvedRelPath' in entry]
    by_id = {node['id']: node.get('filePath') for node in scope['graph']['nodes']}
    for edge in scope['graph']['edges']:
        if edge['kind'] in ('imports', 'exports', 'calls', 'depends_on'):
            source, target = by_id.get(edge['from']), by_id.get(edge['to'])
            if source is not None and target is not None:
                links.append([source, target])
    reasons = []
    if scope['consumed_digest'] != scope['expectedInputHash']:
        reasons.append('DEPENDENCY_SCOPE_INPUT_CHANGED')
    subjects = {subject['path']: subject for subject in native['subjects']}
    unresolved = []
    external = []
    # C1's complete unresolved-import classifier uses the same retained manifests,
    # aliases, workspace names and builtin inventory. Its per-import reason decides
    # external-vs-unresolved; no manifest classification is guessed from expectations.
    for entry in extraction['imports']:
        if 'resolvedRelPath' in entry:
            continue
        path, specifier = entry['fromRelPath'], entry['moduleSpecifier']
        subject = subjects[path]
        marker = 'DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:' + path + ':' + specifier
        if marker in subject['reasons']:
            reasons.append(marker)
            unresolved.append({'path': path, 'specifier': specifier})
        else:
            external.append(specifier)
    sources = prepared['requests'][0]['files']
    for path in prepared['requests'][0]['roots']:
        subject = subjects[path]
        binding = subject['javascript']['native']
        if re.search(r'\.d\.(?:ts|mts|cts)$', path):
            reasons.append('DEPENDENCY_SCOPE_DECLARATION_UNSUPPORTED:' + path)
        if binding['commonJsUnsupported']:
            reasons.append('DEPENDENCY_SCOPE_COMMONJS_UNSUPPORTED:' + path)
        if binding.get('runtimeEvaluationUnsupported'):
            reasons.append('DEPENDENCY_SCOPE_RUNTIME_CODE:' + path)
        configuration = subject['moduleConfigurationObservations']['retainedWithSource']
        if configuration.get('executed') is not True or configuration.get('unsupported') != []:
            raise Gap('SCOPE_CONFIGURATION_COMPONENT_NOT_COMPLETE')
        if 'SOURCE_REFERENCE_PATH_UNSUPPORTED' in configuration['reasons']:
            # Bind the literal to a directive line actually observed by C1's native
            # outline; accept only the simple public path directive grammar.
            outline = native['outlines'][path]['outline']
            found = False
            for line_number in outline['directiveLines']:
                line = sources[path].splitlines()[line_number - 1]
                match = re.fullmatch(r'''\s*///\s*<reference\s+path\s*=\s*(['"])([^'"]+)\1\s*/>\s*''', line)
                if match:
                    found = True
                    target = posixpath.normpath(posixpath.join(posixpath.dirname(path), match[2]))
                    if target not in sources:
                        reasons.append('DEPENDENCY_SCOPE_UNRETAINED_REFERENCE:' + path + ':' + match[2])
            if not found:
                raise Gap('NATIVE_REFERENCE_LITERAL_NOT_EXPOSED_OUTSIDE_SIMPLE_DIRECTIVE_GRAMMAR')
        for member in binding['unmodeledMembers']:
            reasons.append('DEPENDENCY_SCOPE_NATIVE_MODULE_MEMBER_UNSUPPORTED:' + path + ':' + member)
        parsing = subject['sourceParsingObservation']
        if parsing.get('executed') is not True or parsing.get('unsupported') != []:
            raise Gap('SCOPE_PARSING_COMPONENT_NOT_COMPLETE')
        reasons.extend('DEPENDENCY_SCOPE_PARSE_FAILED:' + path + ':' + diagnostic for diagnostic in parsing['reasons'])
        reasons.extend('DEPENDENCY_SCOPE_CONFIGURATION:' + path + ':' + diagnostic for diagnostic in configuration['reasons'])
        syntax = subject['retainedScopeSyntaxObservation']
        if syntax.get('executed') is True and syntax.get('unsupported') == []:
            reasons.extend(syntax['reasons'])
        elif parsing['reasons']:
            # Native syntax component refuses malformed ASTs. The public malformed
            # witness has no dependency syntax; require both actual module links
            # absent and no candidate dependency construct in captured source.
            if native['outlines'][path]['moduleLinks'] or re.search(r'\bimport\b|\bwith\b|\bexport\s*=', sources[path]):
                raise Gap('MALFORMED_SCOPE_DEPENDENCY_SYNTAX_NOT_OBSERVED')
        else:
            raise Gap('SCOPE_SYNTAX_COMPONENT_NOT_COMPLETE')
    return normalize({'links': links, 'reasons': reasons, 'externalModuleSpecifiers': sorted(set(external)), 'unresolvedImports': unresolved}, prepared)


def project_lifecycle(prepared, observed):
    if observed.get('repository_root') and observed['repository_root'] != prepared['repository_root']:
        prepared = dict(prepared, repository_root=observed['repository_root'],
            relocations=[(origin, observed['repository_root']) for origin, _ in prepared['relocations']])
    kind = prepared['public_flow_kind']
    if kind == 'index-store':
        return project_index_store(prepared, observed)
    if kind == 'qualified-discovery':
        return project_qualified_discovery(prepared, observed)
    if kind == 'retained-scope':
        return project_retained_scope(prepared, observed)
    raise Gap(prepared.get('projection_gap', 'NATIVE_PUBLIC_ADMISSION_PROJECTION_NOT_EXPOSED'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--frozen', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    overlay = build_overlay(args.frozen)
    Path(args.output).write_text(json.dumps(overlay, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'operations': len(overlay['operation_overrides']), 'counts': overlay['counts'],
        'invocation_groups': overlay['distinct_invocation_groups'], 'native_queries': 0}))
