"""Pre-outcome supplementary public/identity field reader; zero native queries.

Canonical C4 files/results are immutable. Exact frozen segments are compiled in
isolated copied namespaces with only preregistered separator/path predicates.
"""
import argparse
import ast
import contextlib
import difflib
import hashlib
import json
from pathlib import Path

import adapt_windows_raw as custody
import windows_token_fields as tokens

COORDINATES = ((0, 1), (1, 1), (229, 0), (233, 1), (233, 2),
               (236, 0), (236, 1), (236, 2), (237, 1), (237, 2))
SUPPORTS = ('IDENTITY::I-relocation', 'IDENTITY::I-request-separation',
            'IDENTITY::complete-baseline-specimen')
PUBLIC_FILE = 'tools/rust-ts-r0/qualification/windows_public_fields.py'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def require(value, message):
    if not value:
        raise ValueError(message)


def separators(value):
    require(isinstance(value, str), 'path string required')
    return value.replace('\\', '/')


def normalized(value):
    result = separators(value)
    require(not any(part in ('.', '..') for part in result.split('/')), 'dot path component refused')
    return result


def same_path(actual, expected):
    return separators(actual) == separators(expected)


class OwnedPaths:
    """Map exact captured native spellings to inventory-backed local files."""
    def __init__(self, context):
        self.root = custody.safe_path(context['manifest']['hosts']['windows']['raw_root'])
        self.transport = self.root.parent
        self.native_root = normalized(context['native_raw_root'])
        require(not self.native_root.endswith('/'), 'trailing native root separator refused')
        require(self.native_root == normalized(context['documents']['inventory']['native_raw_root']),
                'native root changed beyond separators')
        self.files = context['verified_files']
        self.comparisons = []

    def native(self, local):
        path = custody.safe_path(local)
        relative = path.relative_to(self.root).as_posix()
        custody.member(relative)
        if relative.startswith('evidence/'):
            relative = 'supplement-evidence/' + relative.removeprefix('evidence/')
        return self.native_root + '/' + relative

    def file(self, local):
        path = custody.safe_path(local)
        key = path.relative_to(self.transport).as_posix()
        require(key in self.files, 'local file absent from verified inventory projection')
        raw = custody.regular(path).read_bytes()
        require(self.files[key] == {'sha256': sha(raw), 'bytes': len(raw)}, 'inventoried local file changed')
        return path

    def native_file(self, local):
        return self.native(self.file(local))

    def equal(self, actual, expected):
        result = same_path(actual, expected)
        self.comparisons.append({'raw': actual, 'normalized': separators(actual),
                                 'expected_raw': expected, 'expected_normalized': separators(expected),
                                 'equal': result})
        return result

    def frame(self, host, folder, captured, receipts=None):
        if receipts is not None:
            identities = [normalized(receipt['path']) for receipt in receipts]
            require(len(set(identities)) == len(identities), 'duplicate normalized receipt frame')
        require(custody.safe_path(host['root']) == self.root, 'foreign host transport root')
        spelling = normalized(captured)
        basename = spelling.rsplit('/', 1)[-1]
        require(len(custody.member(basename).parts) == 1, 'unsafe frame basename')
        local = self.file(Path(folder) / basename)
        require(self.equal(captured, self.native(local)), 'receipt differs from exact owned native frame path')
        return local

    def argv(self, actual, expected, index):
        return (isinstance(actual, list) and len(actual) == len(expected)
                and all(type(value) is str for value in actual)
                and actual[:index] == expected[:index] and actual[index + 1:] == expected[index + 1:]
                and self.equal(actual[index], expected[index]))


# Literal substitutions are the complete preregistered semantic delta. No regex
# rewriting, source edits, assertion removal, data rewriting or suffix fallback.
REPLACEMENTS = {
    ('qualified_carriers', 'load_public_lifecycle'): [
        ("folder/receipt['path'].rsplit('/',1)[-1]", "owned_frame(host,folder,receipt['path'],receipts)")],
    ('remaining_carriers', 'public_verify'): [
        ("folder/receipt['path'].rsplit('/',1)[-1]", "owned_frame(host,folder,receipt['path'],receipts)"),
        ("observed['repository_root']==prepared['repository_root']", "owned_equal(observed['repository_root'],prepared['repository_root'])")],
    ('remaining_carriers', 'native_process_binding'): [
        ("frame['argv']==expected", "owned_argv(frame['argv'],expected,1+int(mode is not None))"),
        ("frame['cwd']==prepared['repository_root']", "owned_equal(frame['cwd'],prepared['repository_root'])")],
    ('remaining_carriers', 'identity_support'): [
        ("frame['argv'][2].endswith('/'+name+'/request.json')", "owned_equal(frame['argv'][2],owned_native(folder/'request.json'))"),
        ("frame['argv'][3].endswith('/'+name+'/sdk.json')", "owned_equal(frame['argv'][3],owned_native(folder/'sdk.json'))")],
    ('nonqualified_carriers', 'legacy_one'): [
        ("request['repository_root'].endswith(f'/implementation-{ordinal}')", "owned_separators(request['repository_root']).endswith(f'/implementation-{ordinal}')"),
        ("request['compiler_package_root'].endswith(f'/compiler-{ordinal}')", "owned_separators(request['compiler_package_root']).endswith(f'/compiler-{ordinal}')")],
    ('remaining_carriers', 'public_base_binding'): [],
    ('nonqualified_carriers', 'legacy'): [],
}


def segment(source, name):
    nodes = [node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == name]
    require(len(nodes) == 1, 'frozen function absent or ambiguous: ' + name)
    return ast.get_source_segment(source, nodes[0])


def variant_source(source, name, replacements):
    original = segment(source, name)
    changed = original
    for before, after in replacements:
        require(changed.count(before) == 1 and after not in changed, 'preregistered source anchor differs: ' + name)
        changed = changed.replace(before, after, 1)
    restored = changed
    for before, after in reversed(replacements):
        require(restored.count(after) == 1, 'variant anchor ambiguous: ' + name)
        restored = restored.replace(after, before, 1)
    require(restored == original and ast.dump(ast.parse(restored)) == ast.dump(ast.parse(original)),
            'variant not exactly source/AST restorable: ' + name)
    return changed, {'function': name, 'original_sha256': sha(original.encode()),
                     'variant_sha256': sha(changed.encode()), 'source_ast_exactly_restorable': True,
                     'byte_identical_forwarder': not replacements,
                     'full_diff': ''.join(difflib.unified_diff(original.splitlines(True), changed.splitlines(True),
                                                           fromfile='Git33/' + name, tofile='supplement/' + name))}


def configured_entry(owner, variant, modules, environments):
    """Original configure(api) runs first; its exact API enters every copied closure."""
    def call(*args, **kwargs):
        current = modules[owner].API
        require(current is not None, 'frozen carrier API has not been configured')
        if owner == 'remaining_carriers':
            require(modules['qualified_carriers'].API is current, 'remaining/qualified API evaluation differs')
        for environment in environments.values():
            environment['API'] = current
        return variant(*args, **kwargs)
    call.variant = variant
    return call


def prepare_variants(a, api, paths):
    import qualified_carriers as q
    import remaining_carriers as r
    import nonqualified_carriers as nq
    modules = {'qualified_carriers': q, 'remaining_carriers': r, 'nonqualified_carriers': nq}
    for module in modules.values():
        module.configure(api)
    environments = {name: dict(module.__dict__) for name, module in modules.items()}
    functions, metadata = {}, []
    for (module_name, name), changes in REPLACEMENTS.items():
        relative = tokens.PACKAGE + module_name + '.py'
        source = tokens.git_source(a.REPO, relative).decode()
        changed, record = variant_source(source, name, changes)
        record.update(module=module_name, git_source_sha256=sha(source.encode()), git_source=tokens.SOURCE + ':' + relative)
        environment = environments[module_name]
        environment.update(owned_frame=paths.frame, owned_equal=paths.equal,
                           owned_argv=paths.argv, owned_native=paths.native_file, owned_separators=separators)
        exec(compile(changed, '<registered-' + module_name + '.' + name + '>', 'exec'), environment)
        functions[(module_name, name)] = environment[name]
        metadata.append(record)
    functions = {key: configured_entry(key[0], function, modules, environments)
                 for key, function in functions.items()}
    # These byte-identical callers must resolve the declared supplementary child.
    environments['remaining_carriers']['native_process_binding'] = functions[('remaining_carriers', 'native_process_binding')]
    environments['remaining_carriers']['public_base_binding'] = functions[('remaining_carriers', 'public_base_binding')]
    environments['nonqualified_carriers']['legacy_one'] = functions[('nonqualified_carriers', 'legacy_one')]
    environments['nonqualified_carriers']['legacy'] = functions[('nonqualified_carriers', 'legacy')]
    return modules, functions, metadata


@contextlib.contextmanager
def installed_variants(modules, functions):
    originals = {key: getattr(modules[key[0]], key[1]) for key in functions}
    try:
        for (module, name), function in functions.items():
            modules[module].__dict__[name] = function
        yield
    finally:
        for (module, name), function in originals.items():
            modules[module].__dict__[name] = function


def selected(rows):
    properties, supports = {}, {}
    for row in rows:
        if row.get('kind') == 'property':
            coord = row['coordinate']
            key = (coord['obligation_index'], coord['property_index'])
            if key in COORDINATES:
                require(key not in properties, 'duplicate public property selection')
                properties[key] = row
        elif row.get('kind') == 'support' and row.get('support_id') in SUPPORTS:
            key = row['support_id']
            require(key not in supports, 'duplicate public support selection')
            supports[key] = row
    require(set(properties) == set(COORDINATES) and set(supports) == set(SUPPORTS), 'public scope selections absent')
    return [properties[key] for key in COORDINATES] + [supports[key] for key in SUPPORTS]


def public_registration(context, readback_repo):
    registration = context['documents']['registration']
    bindings = registration.get('public_bindings', {})
    expected = {'public_reader_sha256': sha(custody.regular(__file__).read_bytes()),
                'public_coordinates': json.dumps([list(c) for c in COORDINATES], separators=(',', ':')),
                'public_support_ids': json.dumps(list(SUPPORTS), separators=(',', ':'))}
    require(all(bindings.get(key) == value for key, value in expected.items()), 'registered public reader/scope differs')
    actual = custody.regular(Path(readback_repo) / PUBLIC_FILE).read_bytes()
    require(actual == custody.regular(__file__).read_bytes()
            and actual == custody.git_bytes(readback_repo, registration['readback_head'], PUBLIC_FILE),
            'public reader differs from registered actual Git W code')
    return expected


def evaluate_public(a, context, c4, modules, functions):
    require(c4.get('kind') == 'DETERMINISTIC_CURRENT_FIELD_ASSESSMENT'
            and c4.get('candidate_head') == tokens.SOURCE
            and c4.get('evaluation_protocol_ref', {}).get('sha256') == tokens.PROTOCOL,
            'C4 source/protocol differs')
    require(c4.get('qualified') is False and type(c4.get('qualification_credit')) is int
            and c4['qualification_credit'] == 0 and c4.get('R0_decision') is None, 'C4 credit boundary differs')
    require(len(c4['rows']) == 446, 'complete C4 row denominator required')
    tokens.assessment_rows(c4, a.scope_protocol()['baseline_rows'])
    originals = selected(c4['rows'])
    host = context['manifest']['hosts']['windows']
    _, identity = a.final_join.validate_host_epoch(host, tokens.SOURCE, 'windows')
    require(c4.get('host_bindings', {}).get('windows') == identity, 'C4 host binding differs')
    with installed_variants(modules, functions):
        supplementary = a.run(context['manifest'])
    tokens.assessment_rows(supplementary, a.scope_protocol()['baseline_rows'])
    require(supplementary['host_bindings']['windows'] == identity, 'supplementary host identity changed')
    fields = selected(supplementary['rows'])
    states = [row['hosts']['windows']['state'] for row in fields]
    verdict = ('WINDOWS_PUBLIC_FIELDS_DIFFER' if 'NONPASS' in states else
               'WINDOWS_PUBLIC_FIELDS_MATCH' if all(state == 'RELEVANT_PASS' for state in states) else
               'WINDOWS_PUBLIC_FIELDS_GAP')
    return {'verdict': verdict, 'rows': fields, 'c4_rows_preserved': originals,
            'host_binding': identity,
            'scope': 'Exactly10 public/legacy properties and3 identity supports; other recomputed C4 rows discarded'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('repo', 'readback-repo', 'protocol', 'cache', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--protocol-sha256', required=True)
    parser.add_argument('--freeze-only', action='store_true')
    for name in ('manifest', 'ledger', 'inventory', 'registration', 'c4-assessment'):
        parser.add_argument('--' + name, type=Path)
        parser.add_argument('--' + name + '-sha256')
    for name in ('export-root', 'caller-repo'):
        parser.add_argument('--' + name, type=Path)
    args = parser.parse_args(argv)
    repo, readback_repo, protocol, cache, output = map(custody.safe_path,
        (args.repo, args.readback_repo, args.protocol, args.cache, args.output))
    custody.protect_shipped_writes((cache, output), (repo, readback_repo, protocol),
                                   (__file__, tokens.__file__, tokens.custody.__file__))
    require(not output.exists(), 'fresh public output required')
    require(custody.regular(readback_repo / PUBLIC_FILE).read_bytes() == custody.regular(__file__).read_bytes(),
            'executing public reader differs from W source')
    require(custody.regular(readback_repo / custody.READBACK_FILES['adapter_sha256']).read_bytes()
            == custody.regular(custody.__file__).read_bytes(), 'executing adapter differs from W source')
    require(custody.regular(readback_repo / custody.READBACK_FILES['verifier_sha256']).read_bytes()
            == custody.regular(tokens.__file__).read_bytes(), 'executing token/helper reader differs from W source')
    require(custody.regular(readback_repo / custody.READBACK_FILES['adapter_sha256']).read_bytes()
            == custody.regular(tokens.custody.__file__).read_bytes(), 'token/helper adapter differs from W source')
    context = None
    references = {}
    if not args.freeze_only:
        names = ('manifest', 'ledger', 'inventory', 'registration')
        require(all(getattr(args, name) and getattr(args, name + '_sha256') for name in names)
                and all((args.export_root, args.caller_repo, args.c4_assessment, args.c4_assessment_sha256)),
                'all explicit pinned custody/C4 inputs required')
        references = {name: {'path': str(getattr(args, name)), 'sha256': getattr(args, name + '_sha256')} for name in names}
        custody.disjoint_writes((cache, output), (args.c4_assessment,))
        custody_args = dict(**references, export_root=args.export_root, source_repo=repo,
                            caller_repo=args.caller_repo, readback_repo=readback_repo, cache=cache, output=output)
        context = custody.verify_transport(**custody_args)
        public_registration(context, readback_repo)
        c4 = tokens.pinned(args.c4_assessment, args.c4_assessment_sha256)
    a, api, _, freeze = tokens.prepare(repo, custody.regular(protocol), args.protocol_sha256, cache)
    selected(a.scope_protocol()['baseline_rows'])
    freeze = {key: freeze[key] for key in ('source_head', 'protocol_sha256', 'sdk_sha256',
                                          'source_joins', 'helper_dependencies')}
    if context is None:
        # A prequery freeze binds code/segments only and claims no future custody.
        class FreezePaths:
            def __getattr__(self, name):
                def disabled(*args, **kwargs):
                    raise ValueError('FREEZE_ONLY_PATH_HELPER_NOT_EXECUTABLE')
                return disabled
        paths = FreezePaths()
    else:
        paths = OwnedPaths(context)
    modules, functions, variants = prepare_variants(a, api, paths)
    freeze.update(kind='WINDOWS_PUBLIC_FIELDS_PREQUERY_FREEZE', public_reader_sha256=sha(custody.regular(__file__).read_bytes()),
                  adapter_sha256=sha(custody.regular(custody.__file__).read_bytes()),
                  shared_token_helper_reader_sha256=sha(custody.regular(tokens.__file__).read_bytes()),
                  variants=variants, public_coordinates=[list(c) for c in COORDINATES], public_support_ids=list(SUPPORTS),
                  normalization_scope='Only preregistered path predicates in five segments; two byte-identical dependency forwarders',
                  public_registration_template={
                      'public_reader_sha256': sha(custody.regular(__file__).read_bytes()),
                      'public_coordinates': json.dumps([list(c) for c in COORDINATES], separators=(',', ':')),
                      'public_support_ids': json.dumps(list(SUPPORTS), separators=(',', ':'))},
                  frozen_scan_scope='Seven named carrier segments only; not an independent audit of139 source files',
                  dependency_bindings={'remaining_carriers.public_base_binding': 'variant native_process_binding',
                                       'nonqualified_carriers.legacy': 'variant legacy_one',
                                       'API': 'Entry dispatcher binds exact current original configure(api) into every copied namespace'},
                  readback_head=custody.subprocess.check_output(['git', '-C', str(readback_repo), 'rev-parse', 'HEAD']).decode().strip(),
                  readback_status=custody.subprocess.check_output(['git', '-C', str(readback_repo), 'status', '--porcelain']).decode())
    result = {'kind': 'SUPPLEMENTARY_WINDOWS_PUBLIC_FIELDS', 'freeze': freeze,
              'coordinates': [list(c) for c in COORDINATES], 'support_ids': list(SUPPORTS),
              'native_queries': 0, 'qualified': False, 'qualification_credit': 0, 'R0_decision': None}
    if context is not None:
        try:
            result.update(evaluate_public(a, context, c4, modules, functions))
        except (AssertionError, ValueError, TypeError, KeyError, IndexError, OSError, StopIteration) as error:
            result.update(verdict='WINDOWS_PUBLIC_FIELDS_GAP', gap=str(error), rows=[])
        result.update(input_sha256={name: ref['sha256'] for name, ref in references.items()},
                      c4_assessment_sha256=args.c4_assessment_sha256, path_comparisons=paths.comparisons,
                      public_registration=public_registration(context, readback_repo))
        require(custody.verify_transport(**custody_args) == context, 'public custody changed during read')
        tokens.pinned(args.c4_assessment, args.c4_assessment_sha256)
    custody.protect_shipped_writes((cache, output), (repo, readback_repo, protocol),
                                   (__file__, tokens.__file__, tokens.custody.__file__))
    with output.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
    return 0 if args.freeze_only or result.get('verdict') == 'WINDOWS_PUBLIC_FIELDS_MATCH' else 1


if __name__ == '__main__':
    raise SystemExit(main())
