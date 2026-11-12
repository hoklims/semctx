import copy
import os
import tempfile
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


if __name__ == '__main__':
    unittest.main()
