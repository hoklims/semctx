import copy
import ast
import inspect
import json
import os
import tempfile
import subprocess
import sys
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

import run_windows_milestone as m


class WindowsMilestoneGuards(unittest.TestCase):
    def valid_args(self):
        return Namespace(execute_native_campaigns=True, root_authority=m.AUTHORITY,
                         expected_head='a'*40, prerequisite_proof_sha256='b'*64)

    def test_execution_requires_each_explicit_root_input_before_any_work(self):
        for key, value in [('execute_native_campaigns', False), ('root_authority', ''),
                           ('expected_head', 'a'*39), ('prerequisite_proof_sha256', '0'*64)]:
            args = self.valid_args()
            setattr(args, key, value)
            with self.subTest(key=key), patch.object(m.platform, 'system', return_value='Windows'), self.assertRaises(ValueError):
                m.authorize(args)
        with patch.object(m.platform, 'system', return_value='Windows'):
            m.authorize(self.valid_args())

    def test_other_hosts_do_not_run_this_milestone(self):
        with patch.object(m.platform, 'system', return_value='Linux'), self.assertRaises(ValueError):
            m.authorize(self.valid_args())

    def test_observer_selection_is_exact_and_rejects_missing_or_duplicate(self):
        self.assertEqual(m.observer_name('n::'+m.SUPPLEMENT+': test\nother: test\n', m.SUPPLEMENT), 'n::'+m.SUPPLEMENT)
        for listing in ['', m.SUPPLEMENT+': test\nx::'+m.SUPPLEMENT+': test\n']:
            with self.assertRaises(ValueError):
                m.observer_name(listing, m.SUPPLEMENT)

    def test_authorized_copy_changes_only_execution_flags_and_keeps_draft_unchanged(self):
        draft = {'execution_enabled': False, 'candidate_execution_authorized': False,
                 'rows': [{'execution_enabled': False, 'id': 'x', 'expected': {'reasons': []}}]}
        before = copy.deepcopy(draft)
        enabled = m.enable(draft)
        self.assertEqual(draft, before)
        enabled['execution_enabled'] = False
        enabled['candidate_execution_authorized'] = False
        for row in enabled['rows']:
            row['execution_enabled'] = False
        self.assertEqual(enabled, before)
        draft['rows'][0]['execution_enabled'] = True
        with self.assertRaises(ValueError):
            m.enable(draft)

    def test_public_inputs_restore_exact_historical_sdk_without_producer(self):
        configured = os.environ.get('SEMCTX_T00_TEST_REPO')
        candidates = [Path(configured)] if configured else [*Path(__file__).resolve().parents, Path.cwd(), *Path.cwd().parents]
        repo = next((p for p in candidates if (p/'docs/research/rust-ts-r0/resumption/gap-legacy-identity-evidence.json').is_file()), None)
        self.assertIsNotNone(repo, 'Set SEMCTX_T00_TEST_REPO or run inside the repository')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            receipt = m.restore_public_inputs(repo, root)
            self.assertEqual(receipt['sdk_sha256'], m.SDK_SHA)
            self.assertEqual(receipt['sdk_files'], 100)
            self.assertEqual(m.sha(root/'sdk-input.json'), m.SDK_SHA)
            self.assertEqual(m.sha(root/'legacy-identity-inputs.json'), receipt['legacy_input_sha256'])

    def test_complete_processes_do_not_hide_unknown_or_missing_supplement_results(self):
        carrier = {'rows': [{'id': str(i), 'state': 'MAPPED_OBSERVATIONS_MATCH_NO_QUALIFICATION_CREDIT'} for i in range(67)],
                   'digest_pairs': [{'id': str(i), 'pass': True} for i in range(5)],
                   'addenda': [{'id': str(i), 'result': {'pass': True}} for i in range(8)],
                   'public': {'rows': [{'id': str(i), 'state': 'CONSUMER_OUTPUTS_MATCH'} for i in range(25)]}}
        self.assertFalse(any(m.supplement_counts(carrier).values()))
        broken = copy.deepcopy(carrier)
        broken['public']['rows'][0]['state'] = 'UNKNOWN_REQUIRED_CONSUMER_OUTPUT'
        self.assertEqual(m.supplement_counts(broken)['public_nonpass'], 1)
        broken['rows'].pop()
        with self.assertRaises(ValueError):
            m.supplement_counts(broken)
        duplicated = copy.deepcopy(carrier)
        duplicated['public']['rows'][1]['id'] = duplicated['public']['rows'][0]['id']
        with self.assertRaisesRegex(ValueError, 'duplicated'):
            m.supplement_counts(duplicated)
        with self.assertRaises(ValueError):
            m.supplement_counts(carrier, [{'id': '0', 'disposition': 'additional_noncontract'}])

    def message_carrier(self, status='MATCH'):
        target = {'id': 'workspace-boundaries-01', 'state': 'CONSUMER_OUTPUTS_MATCH' if status == 'MATCH' else 'CONSUMER_OUTPUT_MISMATCH',
                  'required_outputs': [1], 'observations': [{'sequence': 1, 'parent': None,
                      'required_consumer_output': True, 'status': status}]}
        return {'rows': [{'id': str(i), 'state': 'MAPPED_OBSERVATIONS_MATCH_NO_QUALIFICATION_CREDIT'} for i in range(67)],
                'digest_pairs': [{'id': str(i), 'pass': True} for i in range(5)],
                'addenda': [{'id': str(i), 'result': {'pass': True}} for i in range(8)],
                'public': {'rows': [target, *[{'id': str(i), 'state': 'CONSUMER_OUTPUTS_MATCH'} for i in range(24)]]}}

    def test_direct_required_match_does_not_need_unused_unknown_message_disposition(self):
        carrier = self.message_carrier()
        diagnostic = {'state': 'UNKNOWN', 'reason': 'source-bound helper has no disposition for this candidate'}
        before = copy.deepcopy(diagnostic)
        try:
            counts = m.supplement_counts(carrier, diagnostic_assessment=diagnostic)
        except ValueError as error:
            self.fail('direct required MATCH blocked by unused diagnostic: ' + str(error))
        self.assertFalse(any(counts.values()))
        self.assertEqual(diagnostic, before)

    def test_required_unknown_or_mismatch_still_requires_exact_message_disposition(self):
        for status in ['UNKNOWN', 'MISMATCH']:
            carrier = self.message_carrier(status)
            with self.subTest(status=status), self.assertRaisesRegex(ValueError, 'diagnostic property remains unknown'):
                m.supplement_counts(carrier, diagnostic_assessment={'state': 'UNKNOWN'})
        carrier = self.message_carrier('MISMATCH')
        carrier['public']['rows'][0]['state'] = 'CONSUMER_OUTPUTS_MATCH'
        with self.assertRaisesRegex(ValueError, 'diagnostic property remains unknown'):
            m.supplement_counts(carrier, diagnostic_assessment={'state': 'UNKNOWN'})
        carrier = self.message_carrier()
        carrier['public']['rows'][0]['required_outputs'].append(2)
        with self.assertRaisesRegex(ValueError, 'diagnostic property remains unknown'):
            m.supplement_counts(carrier, diagnostic_assessment={'state': 'UNKNOWN'})

    def test_required_message_mismatch_keeps_existing_named_scoped_disposition(self):
        carrier = self.message_carrier('MISMATCH')
        diagnostic = {'state': 'SCOPED_CODE_AND_PRECEDENCE_OBSERVATIONS_RECORDED',
                      'message_disposition': 'additional_message_version_difference',
                      'disposition_scope': {'id': 'workspace-boundaries-01', 'sequence': 1,
                          'only_difference': 'module option choices within diagnostic message',
                          'whole_public_match_claimed': False, 'qualification_credit': 0}}
        counts = m.supplement_counts(carrier, diagnostic_assessment=diagnostic)
        self.assertEqual(counts['public_nonpass'], 0)
        self.assertEqual(counts['additional_message_representations'], 1)
        diagnostic['disposition_scope']['sequence'] = 2
        with self.assertRaisesRegex(ValueError, 'foreign scope'):
            m.supplement_counts(carrier, diagnostic_assessment=diagnostic)

    def test_descendant_python_commands_use_isolated_verified_script_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            repo, runtime, out = root/'producer', root/'verified-runtime-copy', root/'out'
            runtime.mkdir()
            qualification = repo/'tools/rust-ts-r0/qualification'
            qualification.mkdir(parents=True)
            for path in [qualification/'prepare_recipes.py', *[runtime/name for name in ['prepare_registry.py', 'public_bridge.py', 'write_verifier_fixture_fields.py']]]:
                path.write_text('# verified source-proof helper\n')
            tree = ast.parse(inspect.getsource(m.execute_acquisition))
            selected = {call.args[2].value: call.args[3] for call in ast.walk(tree)
                        if isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == 'run'
                        and len(call.args) >= 4 and isinstance(call.args[2], ast.Constant)
                        and call.args[2].value in ['recipes', 'registry', 'public-plan', 'fixture-fragment']}
            self.assertEqual(set(selected), {'recipes', 'registry', 'public-plan', 'fixture-fragment'})
            environment = {'repo': repo, 'runtime': runtime, 'out': out, 'frozen': root/'frozen',
                           'supplement_out': out/'supplement', 'case_sensitive': False, 'node': 'node.exe'}
            for label, expression in selected.items():
                with self.subTest(label=label):
                    argv = eval(compile(ast.Expression(expression), '<actual collector command>', 'eval'), vars(m), environment)
                    self.assertEqual(argv[:4], [sys.executable, '-I', '-S', '-B'], 'descendant interpreter lacks isolated startup flags')
                    self.assertEqual(argv[4], '-c')

    def test_descendant_bootstrap_executes_sibling_import_without_site_or_pythonpath(self):
        self.assertTrue(hasattr(m, 'python_script'), 'collector descendant bootstrap is missing')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            runtime, foreign = root/'verified-runtime-copy', root/'foreign'
            runtime.mkdir(); foreign.mkdir()
            (runtime/'sibling.py').write_text('VALUE="verified sibling"\n')
            (foreign/'sibling.py').write_text('raise RuntimeError("foreign import")\n')
            script = runtime/'helper.py'
            script.write_text('import json,sys,sibling;print(json.dumps({"value":sibling.VALUE,"isolated":sys.flags.isolated,"no_site":sys.flags.no_site,"no_bytecode":sys.dont_write_bytecode}))\n')
            env = dict(os.environ, PYTHONPATH=str(foreign))
            result = subprocess.run(m.python_script(script, []), env=env, cwd=foreign, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {'value': 'verified sibling', 'isolated': 1, 'no_site': 1, 'no_bytecode': True})


if __name__ == '__main__':
    unittest.main()
