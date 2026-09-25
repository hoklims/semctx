"""Run the four cross-platform HOK-834 regression cases from the bundled skill."""

from pathlib import Path
import sys
import unittest


TESTS = (
    "test_reconcile_worker.SemctxHostBindingTests.test_operator_record_recovers_negative_verdict_without_rebuild",
    "test_reconcile_worker.SemctxHostBindingTests.test_negative_verdict_recovers_on_worker_reconciliation_without_refresh",
    "test_reconcile_worker.SemctxHostBindingTests.test_version_skew_is_reported_and_never_rebuilt_away",
    "test_index_control.FingerprintTests.test_dotted_vendor_tree_does_not_admit_graphify",
)


def main() -> int:
    tests_dir = Path(__file__).resolve().parents[1] / "plugins/shared/skills/index-control-plane/tests"
    if not tests_dir.is_dir():
        raise RuntimeError(f"index-control-plane tests are missing: {tests_dir}")
    sys.path.insert(0, str(tests_dir))
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    for name in TESTS:
        case = loader.loadTestsFromName(name)
        if case.countTestCases() != 1:
            raise RuntimeError(f"expected exactly one regression case: {name}")
        suite.addTest(case)
    result = unittest.TextTestRunner().run(suite)
    if result.skipped:
        for case, reason in result.skipped:
            print(f"skipped HOK-834 regression: {case.id()}: {reason}", file=sys.stderr)
        return 1
    return 0 if result.wasSuccessful() and result.testsRun == len(TESTS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
