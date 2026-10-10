import assert from "node:assert/strict";

export function assertInterruptedAdmission(result: { code: number; stdout: string; stderr: string }): void {
  assert.equal(result.code, 3, "Interrupted admission must use CLI exit 3, not an infrastructure error");
  const report = JSON.parse(result.stdout) as { verdict?: string; analysisAdmission?: { status?: string; reasons?: unknown } };
  assert.equal(report.verdict, "BLOCK");
  assert.equal(report.analysisAdmission?.status, "rejected");
  const reasons = report.analysisAdmission.reasons;
  assert(Array.isArray(reasons) && reasons.every((reason: unknown) => typeof reason === "string"), "Admission reasons must be an array of strings");
  assert(reasons.includes("INDEX_BUILD_INCOMPLETE"), "Admission must identify the interrupted build");
}
