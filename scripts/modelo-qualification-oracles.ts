import assert from "node:assert/strict";
import { VerifyReportSchema, type AnalysisAdmission } from "@semantic-context/core";

export type Observation = { code: number; stdout: string; stderr: string };
export type RefusalExpectation = {
  binding?: AnalysisAdmission["binding"]["status"];
  indexFreshness?: AnalysisAdmission["indexFreshness"]["verdict"][];
};

export function assertQualifiedBlock(result: Observation, expected: RefusalExpectation = {}): void {
  assert.equal(result.code, 3, "Qualified refusal must use CLI exit 3, not an infrastructure error");
  const rejected = VerifyReportSchema.parse(JSON.parse(result.stdout));
  assert.equal(rejected.verdict, "BLOCK", "Refusal must be represented by BLOCK");
  assert.equal(rejected.analysisAdmission?.status, "rejected", "Qualified refusal must retain explicit admission evidence");
  if (expected.binding !== undefined) assert.equal(rejected.analysisAdmission.binding.status, expected.binding, "Refusal must establish the claimed binding");
  if (expected.indexFreshness !== undefined) assert(expected.indexFreshness.includes(rejected.analysisAdmission.indexFreshness.verdict), "Refusal must establish the claimed index freshness");
}

export function assertOperationalError(result: Observation, code: "CONFIG_NOT_FOUND" | "CONFIG_INVALID", message: string): void {
  assert.equal(result.code, 1, "Expected operational error must use CLI exit 1");
  if (result.stdout.trim()) {
    const details = JSON.parse(result.stdout) as Record<string, unknown>;
    assert(details !== null && typeof details === "object" && !("verdict" in details) && !("analysisAdmission" in details), "Operational details are not an admission report");
  }
  assert(result.stderr.includes(`[${code}]`) && result.stderr.includes(message), `Expected deliberate ${code}: ${message}`);
}
