import { expect, test } from "bun:test";
import { VerifyReportSchema, type VerifyReport } from "@semantic-context/core";
import { assertInterruptedAdmission } from "./modelo-interruption-witness";

function interruptedReport(): VerifyReport {
  const digest = `sha256:${"0".repeat(64)}`;
  return {
    schemaVersion: 1, verdict: "BLOCK", base: null, head: "public-fixture", mergeBase: null, range: null,
    changedFiles: ["src/value.ts"], changedSymbols: [], impactedContracts: [], impactedInvariants: [],
    recommendedTests: [], contradictions: [], unknowns: [], findings: [], summary: { blockCount: 1, warnCount: 0 },
    analysisAdmission: {
      schemaVersion: 1, profile: "modelo-suite-static-v1", status: "rejected",
      identity: { source: digest, sourceCommits: ["0".repeat(40)], baseCommit: null, diff: digest, config: digest, analyzer: digest, indexSnapshot: digest },
      binding: { status: "valid", reasons: [] }, indexFreshness: { verdict: "STALE", reasons: ["INDEX_BUILD_INCOMPLETE"] },
      controlFreshness: { verdict: "STALE", reasons: ["INDEX_BUILD_INCOMPLETE"] }, checkFreshness: { status: "current", reasons: [] },
      repositoryCoverage: { status: "complete", files: [{ path: "src/value.ts", status: "analyzed", reasons: [] }] },
      changeCoverage: { expected: ["src/value.ts"], analyzed: ["src/value.ts"], files: [{ path: "src/value.ts", status: "analyzed", reasons: [] }] },
      reasons: ["INDEX_BUILD_INCOMPLETE"], limitations: ["Public static fixture only"], proofObligations: [],
    },
  };
}
function observation(report: unknown) { return { code: 3, stdout: JSON.stringify(report), stderr: "" }; }

test("rejects an infrastructure failure instead of treating it as interrupted admission", () => {
  expect(() => assertInterruptedAdmission({ code: 1, stdout: '{"reason":"close the writer"}', stderr: "ERROR [STORE_ERROR] active WAL sidecars" })).toThrow();
});

test("accepts structured incomplete-build BLOCK with exit three", () => {
  const report = interruptedReport();
  VerifyReportSchema.parse(report);
  expect(() => assertInterruptedAdmission(observation(report))).not.toThrow();
});

test("rejects a BLOCK that does not identify the incomplete build", () => {
  const report = interruptedReport(); report.analysisAdmission!.reasons = ["INDEX_STALE"];
  expect(() => assertInterruptedAdmission(observation(report))).toThrow();
});

test.each([
  ["a string instead of an array", "INDEX_BUILD_INCOMPLETE"],
  ["a substring-bearing string instead of an array", "PREFIX_INDEX_BUILD_INCOMPLETE_SUFFIX"],
  ["an array containing a non-string reason", ["INDEX_BUILD_INCOMPLETE", null]],
  ["an array-like object instead of an array", { 0: "INDEX_BUILD_INCOMPLETE", length: 1 }],
  ["a null reasons container", null],
])("rejects interrupted admission with %s", (_description, reasons) => {
  const report = interruptedReport();
  expect(() => assertInterruptedAdmission(observation({ ...report, analysisAdmission: { ...report.analysisAdmission, reasons } }))).toThrow();
});

test("rejects an array containing only a lookalike incomplete-build reason", () => {
  const report = interruptedReport(); report.analysisAdmission!.reasons = ["PREFIX_INDEX_BUILD_INCOMPLETE_SUFFIX"];
  expect(() => assertInterruptedAdmission(observation(report))).toThrow();
});

test("rejects an unsupported verify report schema version", () => {
  expect(() => assertInterruptedAdmission(observation({ ...interruptedReport(), schemaVersion: 2 }))).toThrow();
});

test.each(["identity", "repositoryCoverage", "changeCoverage"] as const)("rejects admission missing required %s", (field) => {
  const report = interruptedReport();
  const admission = { ...report.analysisAdmission }; delete admission[field];
  expect(() => assertInterruptedAdmission(observation({ ...report, analysisAdmission: admission }))).toThrow();
});

test("accepts additive fields allowed by the public report contract", () => {
  expect(() => assertInterruptedAdmission(observation({ ...interruptedReport(), futureOptionalEvidence: "public" }))).not.toThrow();
});
