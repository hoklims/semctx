"""Run every classified portable controller test; report external evidence separately.

The inventory is an exact-ID contract: discovery drift blocks rather than silently
reducing coverage. External host/provider integrations remain UNPROVEN, never PASS.
"""

import argparse
import contextlib
import json
import os
from pathlib import Path
import sys
import unittest


TESTS = (
    "test_reconcile_worker.SemctxHostBindingTests.test_operator_record_recovers_negative_verdict_without_rebuild",
    "test_reconcile_worker.SemctxHostBindingTests.test_negative_verdict_recovers_on_worker_reconciliation_without_refresh",
    "test_reconcile_worker.SemctxHostBindingTests.test_version_skew_is_reported_and_never_rebuilt_away",
    "test_index_control.FingerprintTests.test_dotted_vendor_tree_does_not_admit_graphify",
)

ROOT = Path(__file__).resolve().parents[1]
TESTS_DIR = ROOT / "plugins/shared/skills/index-control-plane/tests"
MANIFEST = ROOT / "scripts/index-routing-inventory.json"
MODULES = (
    "test_benchmark", "test_gateway", "test_index_control", "test_lsp_benchmark",
    "test_reconcile_worker", "test_scip_json_probe",
)
CLASSIFICATIONS = {"portable", "windows-only", "external-host", "external-provider"}


def flatten(suite):
    for case in suite:
        if isinstance(case, unittest.TestSuite):
            yield from flatten(case)
        else:
            yield case


def discover_tests(tests_dir):
    modules = {path.stem for path in tests_dir.glob("test_*.py")}
    if modules != set(MODULES):
        raise ValueError(f"test modules differ: missing={sorted(set(MODULES) - modules)}, "
                         f"unclassified={sorted(modules - set(MODULES))}")
    # Loading by filename keeps unittest discovery (including import failures) real.
    # Remove prior test imports when exercising another fixture directory.
    for name in MODULES:
        sys.modules.pop(name, None)
    sys.path.insert(0, str(tests_dir))
    loader = unittest.TestLoader()
    try:
        cases = list(flatten(loader.discover(str(tests_dir), pattern="test_*.py")))
    finally:
        sys.path.remove(str(tests_dir))
    if loader.errors:
        raise ValueError("test discovery failed: " + "\n".join(loader.errors))
    empty = set(MODULES) - {case.id().split(".")[0] for case in cases}
    if empty:
        raise ValueError(f"empty test modules: {sorted(empty)}")
    if len({case.id() for case in cases}) != len(cases):
        raise ValueError("duplicate test IDs")
    return sorted(cases, key=lambda case: case.id())


def load_manifest(path):
    def unique_pairs(pairs):
        value = {}
        for key, entry in pairs:
            if key in value:
                raise ValueError(f"duplicate inventory key: {key}")
            value[key] = entry
        return value

    value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_pairs)
    if not isinstance(value, dict) or value.get("schema_version") != 1:
        raise ValueError("invalid inventory schema")
    tests = value.get("tests")
    if not isinstance(tests, dict) or not tests:
        raise ValueError("invalid or empty test inventory")
    return tests


def select_tests(tests, manifest, platform):
    discovered = {case.id() for case in tests}
    if discovered != set(manifest):
        raise ValueError(f"test inventory differs: unclassified={sorted(discovered - set(manifest))}, "
                         f"missing={sorted(set(manifest) - discovered)}")
    selected, excluded = [], []
    for case in tests:
        entry = manifest[case.id()]
        if (not isinstance(entry, dict) or not isinstance(entry.get("classification"), str)
                or entry["classification"] not in CLASSIFICATIONS):
            raise ValueError(f"invalid classification: {case.id()}")
        classification = entry["classification"]
        reason = entry.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError(f"missing classification reason: {case.id()}")
        if case.id() in TESTS and classification != "portable":
            raise ValueError(f"mandatory regression cannot be excluded: {case.id()}")
        if classification == "portable" or (classification == "windows-only" and platform == "nt"):
            selected.append(case)
        else:
            excluded.append({
                "id": case.id(), "classification": classification, "reason": reason,
                "status": "NOT_APPLICABLE" if classification == "windows-only" else "UNPROVEN",
            })
    if not set(TESTS).issubset(discovered):
        raise ValueError("mandatory regressions are missing")
    return selected, excluded


def successful(result, expected):
    return (result.wasSuccessful() and result.testsRun == expected
            and not result.skipped and not result.expectedFailures)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", action="store_true", help="report classification without executing tests")
    args = parser.parse_args()
    # Preserve JSON-only stdout even if a test/provider prints a diagnostic.
    try:
        with contextlib.redirect_stdout(sys.stderr):
            tests = discover_tests(TESTS_DIR)
            selected, excluded = select_tests(tests, load_manifest(MANIFEST), os.name)
            report = {
                "schema_version": 1, "scope": "portable-controller", "platform": sys.platform,
                "discovered": len(tests), "selected": len(selected),
                "selected_ids": [case.id() for case in selected], "excluded": excluded,
                "host_integration": "UNPROVEN", "provider_integration": "UNPROVEN",
            }
            if args.inventory:
                report.update({"status": "INVENTORIED", "executed": 0})
                exit_code = 0
            else:
                result = unittest.TextTestRunner(stream=sys.stderr).run(unittest.TestSuite(selected))
                exit_code = 0 if successful(result, len(selected)) else 1
                report.update({
                    "status": "PASS" if exit_code == 0 else "BLOCK", "executed": result.testsRun,
                    "failures": [case.id() for case, _ in result.failures],
                    "errors": [case.id() for case, _ in result.errors],
                    "skipped": [{"id": case.id(), "reason": reason} for case, reason in result.skipped],
                    "expected_failures": [case.id() for case, _ in result.expectedFailures],
                    "unexpected_successes": [case.id() for case in result.unexpectedSuccesses],
                })
    except (OSError, ValueError) as error:
        report = {"schema_version": 1, "scope": "portable-controller", "status": "BLOCK", "error": str(error)}
        exit_code = 1
    print(json.dumps(report, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
