"""Pure positive/negative lifecycle comparators; all native observations are synthetic."""
import unittest
import copy
import lifecycle_adapter_29_frozen as l
import lifecycle_adapter_29_strict as strict


class LifecycleTests(unittest.TestCase):
    def base(self):
        return {'repository_root': '/case/workspace', 'relocations': [], 'path_normalization': {'roots': []}}

    def test_index_requires_actual_store_readback_and_identities(self):
        observed = {'index_store_written': True, 'index_store_readback_equal': True, 'index_batch_id': 'sha256:actual', 'git_head': 'actual-head'}
        self.assertEqual(l.project_index_store({}, observed), {'statefulSetupObserved': True})
        for key in observed:
            changed = dict(observed)
            changed.pop(key)
            with self.subTest(key=key), self.assertRaises(l.Gap):
                l.project_index_store({}, changed)
        with self.assertRaisesRegex(l.Gap, 'BOUND_COMPLETE_INDEX_RECEIPT_REQUIRED'):
            strict.project_lifecycle({'public_flow_kind': 'index-store'}, observed)
        observed['batch_binding_receipt'] = {'state': 'BOUND_COMPLETE_INDEX_BATCH', 'admissible_index_store': True}
        self.assertEqual(strict.project_lifecycle({'public_flow_kind': 'index-store'}, observed), {'statefulSetupObserved': True})

    def discovery(self):
        prepared = {**self.base(), 'eligibility_queries': ['build/generated.ts', 'src/main.ts'],
            'physical_current_files': {'build/generated.ts': 'generated', 'src/main.ts': 'source'}}
        observed = {'ordinary_discovery': {'executed': True, 'unsupported': [], 'candidates': [
            {'relPath': 'src/main.ts', 'selectionDecision': 'selected', 'reason': 'SELECTED'}], 'files': [
                {'relPath': 'src/main.ts', 'role': 'source', 'language': 'typescript', 'content': 'source'}]},
            'eligibility': {'eligibility_established': True, 'queries': prepared['eligibility_queries'], 'eligible_results': [False, True]},
            'system': {'results': [{'path': '/case/workspace/' + path, 'found': True, 'value': text,
                                   'unsupported': [], 'refusals': []} for path, text in prepared['physical_current_files'].items()]}}
        return prepared, observed

    def test_generated_exclusion_comes_from_actual_native_eligibility(self):
        prepared, observed = self.discovery()
        result = l.project_qualified_discovery(prepared, observed)
        self.assertEqual(result['candidates'][0], {'relPath': 'build/generated.ts', 'selectionDecision': 'excluded', 'analysisOutcome': 'not_applicable', 'reason': 'IGNORED_GENERATED_OUTPUT'})
        observed['eligibility']['eligible_results'][0] = True
        with self.assertRaisesRegex(l.Gap, 'CANDIDATE_MISSING'):
            l.project_qualified_discovery(prepared, observed)

    def test_generated_discovery_refuses_foreign_missing_and_changed_evidence(self):
        prepared, observed = self.discovery()
        for mutate in [lambda o: o['eligibility'].update(eligibility_established=False),
                       lambda o: o['eligibility'].update(eligible_results=[False]),
                       lambda o: o['system']['results'][0].update(value='changed'),
                       lambda o: o['system']['results'][0].update(found=False),
                       lambda o: o['ordinary_discovery'].update(executed=False)]:
            changed = copy.deepcopy(observed)
            mutate(changed)
            with self.assertRaises(l.Gap):
                l.project_qualified_discovery(prepared, changed)

    def scope(self):
        prepared = {**self.base(), 'requests': [{'files': {'src/main.ts': 'export function main() {}'}, 'roots': ['src/main.ts']}],
            'scope_input': {'graph': {'nodes': [{'id': 'a', 'filePath': 'a.ts'}, {'id': 'b', 'filePath': 'b.ts'}],
                                     'edges': [{'kind': 'imports', 'from': 'a', 'to': 'b'}, {'kind': 'calls', 'from': 'a', 'to': 'b'}]},
                            'consumed_digest': 'same', 'expectedInputHash': 'same'}}
        subject = {'path': 'src/main.ts', 'reasons': [], 'javascript': {'native': {'commonJsUnsupported': False, 'unmodeledMembers': []}},
            'moduleConfigurationObservations': {'retainedWithSource': {'executed': True, 'unsupported': [], 'reasons': []}},
            'sourceParsingObservation': {'executed': True, 'unsupported': [], 'reasons': []},
            'retainedScopeSyntaxObservation': {'executed': True, 'unsupported': [], 'reasons': []}}
        observed = {'raw_scope': {'complete': True, 'global_admission_inferred': False, 'subjects': [subject],
            'raw_extraction': {'imports': [{'fromRelPath': 'a.ts', 'resolvedRelPath': 'b.ts'}]},
            'outlines': {'src/main.ts': {'outline': {'directiveLines': []}, 'moduleLinks': []}}}}
        return prepared, observed

    def test_scope_preserves_extraction_and_graph_input_link_multiplicity(self):
        prepared, observed = self.scope()
        prepared['public_flow_kind'] = 'retained-scope'
        observed['raw_scope']['input_manifest_id'] = 'synthetic-capture'
        projected = {'links': [['a.ts', 'b.ts']] * 3, 'reasons': [], 'externalModuleSpecifiers': [], 'unresolvedImports': []}
        observed['scope_ast_receipt'] = {'kind': 'rust-consumer-native-ast-v1', 'input_manifest_id': 'synthetic-capture'}
        observed['rust_scope_projection'] = projected
        self.assertEqual(strict.project_lifecycle(prepared, observed), projected)
        observed['scope_ast_receipt']['input_manifest_id'] = 'foreign'
        with self.assertRaisesRegex(l.Gap, 'RUST_NATIVE_AST_SCOPE_RECEIPT_REQUIRED'):
            strict.project_lifecycle(prepared, observed)

    def test_scope_reference_literal_requires_rust_receipt_not_python_source_inference(self):
        prepared, observed = self.scope()
        prepared['public_flow_kind'] = 'retained-scope'
        prepared['requests'][0]['files']['src/main.ts'] = '/// <reference path="../build/generated.ts" />\nexport function main() {}'
        native = observed['raw_scope']
        native['outlines']['src/main.ts']['outline']['directiveLines'] = [1]
        native['subjects'][0]['moduleConfigurationObservations']['retainedWithSource']['reasons'] = ['SOURCE_REFERENCE_PATH_UNSUPPORTED']
        with self.assertRaisesRegex(l.Gap, 'RUST_NATIVE_AST_SCOPE_RECEIPT_REQUIRED'):
            strict.project_lifecycle(prepared, observed)
        observed['raw_scope']['input_manifest_id'] = 'synthetic-reference-capture'
        observed['scope_ast_receipt'] = {'kind': 'rust-consumer-native-ast-v1', 'input_manifest_id': 'synthetic-reference-capture'}
        observed['rust_scope_projection'] = {'links': [], 'reasons': ['DEPENDENCY_SCOPE_UNRETAINED_REFERENCE:src/main.ts:../build/generated.ts'], 'externalModuleSpecifiers': [], 'unresolvedImports': []}
        self.assertEqual(strict.project_lifecycle(prepared, observed)['reasons'], observed['rust_scope_projection']['reasons'])
        native['outlines']['src/main.ts']['outline']['directiveLines'] = []
        del observed['scope_ast_receipt']
        with self.assertRaisesRegex(l.Gap, 'RUST_NATIVE_AST_SCOPE_RECEIPT_REQUIRED'):
            strict.project_lifecycle(prepared, observed)

    def test_scope_parse_failure_is_not_promoted_to_complete_syntax_scan(self):
        prepared, observed = self.scope()
        prepared['public_flow_kind'] = 'retained-scope'
        subject = observed['raw_scope']['subjects'][0]
        subject['sourceParsingObservation']['reasons'] = ["SOURCE_PARSE_ERROR:1005:'}' expected."]
        subject['retainedScopeSyntaxObservation'] = {'executed': False, 'unsupported': ['PARSE_FAILED']}
        with self.assertRaisesRegex(l.Gap, 'RUST_NATIVE_AST_SCOPE_RECEIPT_REQUIRED'):
            strict.project_lifecycle(prepared, observed)
        prepared['requests'][0]['files']['src/main.ts'] += '; import(name)'
        with self.assertRaisesRegex(l.Gap, 'RUST_NATIVE_AST_SCOPE_RECEIPT_REQUIRED'):
            strict.project_lifecycle(prepared, observed)

    def test_public_verify_dto_gap_never_returns_admitted_from_component_success(self):
        with self.assertRaises(l.Gap):
            strict.project_lifecycle({'public_flow_kind': 'public-verify', 'adapter': 'full_admission_adapter'}, {'status': 'admitted'})

    def test_selector_is_bounded_and_does_not_guess_unknown_glob_semantics(self):
        self.assertTrue(l.selection('src/nested/main.ts', {'include': ['src/**/*.ts'], 'exclude': ['node_modules', 'dist', '.semctx', '.git', 'coverage']}))
        with self.assertRaises(l.Gap):
            l.selection('a.ts', {'include': ['custom/**'], 'exclude': []})


if __name__ == '__main__':
    unittest.main()
