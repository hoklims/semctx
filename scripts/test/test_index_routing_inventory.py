"""Negative witnesses for the portable controller gate (no installed host required)."""

import importlib.util
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "verify-index-routing.py"
SPEC = importlib.util.spec_from_file_location("routing_gate", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.tests = gate.discover_tests(gate.TESTS_DIR)
        self.manifest = gate.load_manifest(gate.MANIFEST)

    def test_baseline_inventory_covers_every_module_and_more_than_four_regressions(self):
        selected, excluded = gate.select_tests(self.tests, self.manifest, "nt")
        self.assertEqual(len(self.tests), 122)
        self.assertEqual(len(selected), 108)
        self.assertEqual(len(excluded), 14)
        self.assertEqual({case.id().split(".")[0] for case in selected}, set(gate.MODULES))
        self.assertTrue(set(gate.TESTS).issubset({case.id() for case in selected}))

    def test_unclassified_new_test_blocks(self):
        class Added(unittest.TestCase):
            def runTest(self):
                pass
        with self.assertRaisesRegex(ValueError, "unclassified"):
            gate.select_tests([*self.tests, Added()], self.manifest, "nt")

    def test_missing_test_blocks(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            gate.select_tests(self.tests[1:], self.manifest, "nt")

    def test_missing_or_empty_module_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "modules"):
                gate.discover_tests(Path(tmp))
            for module in gate.MODULES:
                (Path(tmp) / (module + ".py")).write_text("", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "empty"):
                gate.discover_tests(Path(tmp))

    def test_malformed_manifest_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "inventory.json"
            for content in ("[]", '{"schema_version":1,"tests":[]}', "{broken"):
                path.write_text(content, encoding="utf-8")
                with self.assertRaises((ValueError, json.JSONDecodeError)):
                    gate.load_manifest(path)

    def test_unknown_classification_and_empty_reason_block(self):
        for classification, reason in (("optional", "reason"), ([], "reason"), ("external-host", "")):
            manifest = {key: dict(value) for key, value in self.manifest.items()}
            manifest[next(iter(manifest))] = {"classification": classification, "reason": reason}
            with self.assertRaises(ValueError):
                gate.select_tests(self.tests, manifest, "nt")

    def test_historical_regressions_cannot_be_excluded(self):
        for test_id in gate.TESTS:
            manifest = {key: dict(value) for key, value in self.manifest.items()}
            manifest[test_id] = {"classification": "external-host", "reason": "fake host dependency"}
            with self.assertRaisesRegex(ValueError, "mandatory"):
                gate.select_tests(self.tests, manifest, "nt")

    def test_non_windows_exclusions_are_explicit_and_not_successes(self):
        selected, excluded = gate.select_tests(self.tests, self.manifest, "posix")
        windows = [entry for entry in excluded if entry["classification"] == "windows-only"]
        self.assertEqual(len(windows), 3)
        self.assertEqual(len(selected), 105)
        self.assertTrue(all(entry["reason"] for entry in excluded))
        self.assertEqual({entry["status"] for entry in excluded}, {"NOT_APPLICABLE", "UNPROVEN"})

    def test_skips_failures_expected_failures_and_omissions_block(self):
        class Cases(unittest.TestCase):
            def test_ok(self):
                pass

            @unittest.skip("dependency missing")
            def test_skip(self):
                pass

            def test_fail(self):
                self.fail("negative witness")

            def test_error(self):
                raise RuntimeError("negative witness")

            @unittest.expectedFailure
            def test_expected_failure(self):
                self.fail("still a gap")

        for method in ("test_skip", "test_fail", "test_error", "test_expected_failure", "test_ok"):
            result = unittest.TextTestRunner(stream=io.StringIO()).run(Cases(method))
            expected = 2 if method == "test_ok" else 1
            self.assertFalse(gate.successful(result, expected), method)
        result = unittest.TextTestRunner(stream=io.StringIO()).run(Cases("test_ok"))
        self.assertTrue(gate.successful(result, 1))

    def test_main_reports_skips_as_block_with_json_only_stdout(self):
        class Skipped(unittest.TestCase):
            @unittest.skip("dependency missing")
            def runTest(self):
                pass

        case = Skipped()
        output = io.StringIO()
        with (
            mock.patch.object(sys, "argv", [str(SCRIPT)]),
            mock.patch.object(gate, "discover_tests", return_value=[case]),
            mock.patch.object(gate, "load_manifest", return_value={}),
            mock.patch.object(gate, "select_tests", return_value=([case], [])),
            contextlib.redirect_stdout(output),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(gate.main(), 1)
        report = json.loads(output.getvalue())
        self.assertEqual(report["status"], "BLOCK")
        self.assertEqual(report["executed"], 1)
        self.assertEqual(report["skipped"], [{"id": case.id(), "reason": "dependency missing"}])
        self.assertEqual(report["host_integration"], "UNPROVEN")

    def test_inventory_mode_never_claims_execution(self):
        output = io.StringIO()
        with mock.patch.object(sys, "argv", [str(SCRIPT), "--inventory"]), contextlib.redirect_stdout(output):
            self.assertEqual(gate.main(), 0)
        report = json.loads(output.getvalue())
        self.assertEqual(report["status"], "INVENTORIED")
        self.assertEqual(report["executed"], 0)
        self.assertEqual(report["discovered"], 122)
        self.assertEqual(report["provider_integration"], "UNPROVEN")


if __name__ == "__main__":
    unittest.main()
