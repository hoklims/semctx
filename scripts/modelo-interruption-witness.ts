import assert from "node:assert/strict";

export function assertInterruptedAdmission(result: { code: number; stdout: string; stderr: string }): void {
  assert.equal(result.code, 3, "Interrupted admission must use CLI exit 3, not an infrastructure error");
  const report = JSON.parse(result.stdout) as { verdict?: string; analysisAdmission?: { status?: string; reasons?: string[] } };
  assert.equal(report.verdict, "BLOCK");
  assert.equal(report.analysisAdmission?.status, "rejected");
  assert(report.analysisAdmission.reasons?.includes("INDEX_BUILD_INCOMPLETE"), "Admission must identify the interrupted build");
}
