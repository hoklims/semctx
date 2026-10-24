import { expect, test } from "bun:test";
import { compareBaseCapture } from "./t00-ts7-q-boundary-base";
import type { Execution } from "./t00-ts7-q-boundary-common";

function execution(value: Record<string, unknown>, exitCode = 0): Execution {
  return { value, exitCode, stdout: JSON.stringify(value), stderr: "", evidence: [] };
}

test("base capture requires the old scope and commit, not a current admitted report", () => {
  const result = execution({ analysisAdmission: { status: "admitted", reasons: [] }, verdict: "NOT_ASSERTED", base_capture: { status: "analyzed", commit: "base", expected: ["src/main.ts"] }, global_admission_inferred: false });
  expect(compareBaseCapture("control", "analyzed", "base", result).every(item => item.pass)).toBe(true);
  result.value["base_capture"] = { status: "not_required" };
  expect(compareBaseCapture("control", "analyzed", "base", result).some(item => !item.pass)).toBe(true);
  result.value["base_capture"] = { status: "analyzed", commit: "other", expected: [] };
  expect(compareBaseCapture("control", "analyzed", "base", result).filter(item => !item.pass).map(item => item.name)).toEqual(["base.control.commit", "base.control.old-scope"]);
});

test("base refusal needs a structured blocking report and the named base boundary", () => {
  const result = execution({ analysisAdmission: { status: "rejected", reasons: ["QUALIFIED_WORKING_TREE_BASE_CAPTURE_UNSUPPORTED:old source"] }, verdict: "BLOCK", base_capture: { status: "unsupported" }, global_admission_inferred: false }, 3);
  expect(compareBaseCapture("refusal", "unsupported", "base", result).every(item => item.pass)).toBe(true);
  result.value["analysisAdmission"] = { status: "rejected", reasons: ["unrelated"] };
  expect(compareBaseCapture("refusal", "unsupported", "base", result).some(item => !item.pass)).toBe(true);
  expect(compareBaseCapture("missing", "unsupported", "base", execution({}, 1)).some(item => !item.pass)).toBe(true);
});
