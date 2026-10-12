import { describe, expect, test } from "bun:test";
import { VerifyReportSchema, type VerifyReport } from "../src";

function report(): VerifyReport {
  const digest = `sha256:${"a".repeat(64)}`;
  const file = { path: "scripts/leaf.mjs", status: "analyzed" as const, reasons: [] };
  return {
    schemaVersion: 1, verdict: "PASS", base: null, head: "HEAD", mergeBase: null, range: null,
    changedFiles: [file.path], changedSymbols: [{ id: "function:leaf", name: "leaf", kind: "function", file: file.path }],
    impactedContracts: [], impactedInvariants: [], recommendedTests: [], contradictions: [], unknowns: [], findings: [], summary: { blockCount: 0, warnCount: 0 },
    analysisAdmission: {
      schemaVersion: 1, profile: "modelo-suite-static-v1", status: "admitted",
      identity: { source: digest, sourceCommits: ["a".repeat(40)], baseCommit: null, diff: digest, config: digest, analyzer: digest, indexSnapshot: digest },
      binding: { status: "valid", reasons: [] }, indexFreshness: { verdict: "DIRTY_KNOWN", reasons: ["WORKING_TREE_DIRTY"] },
      controlFreshness: { verdict: "DIRTY_KNOWN", reasons: ["WORKING_TREE_DIRTY"] }, checkFreshness: { status: "current", reasons: [] },
      repositoryCoverage: { status: "partial", files: [file] }, changeCoverage: { expected: [file.path], analyzed: [file.path], files: [file] },
      reasons: [], limitations: ["Static source/dependency analysis only."], proofObligations: [],
    },
  };
}
describe("qualified report scope consistency", () => {
  test("keeps the existing admitted public fixture and dependency closure valid", () => {
    expect(VerifyReportSchema.safeParse(report()).success).toBe(true);
    const closure = report();
    const dependency = { path: "scripts/dependency.ts", status: "analyzed" as const, reasons: [] };
    closure.analysisAdmission!.changeCoverage.expected.push(dependency.path);
    closure.analysisAdmission!.changeCoverage.analyzed.push(dependency.path);
    closure.analysisAdmission!.changeCoverage.files.push(dependency);
    closure.analysisAdmission!.repositoryCoverage.files.push(dependency);
    expect(VerifyReportSchema.safeParse(closure).success).toBe(true);
  });
  test("rejects an admitted changed source omitted from its obligations", () => {
    const omitted = report();
    omitted.changedFiles.push("src/unreviewed.ts");
    expect(VerifyReportSchema.safeParse(omitted).success).toBe(false);
  });
  test("rejects complete repository coverage carrying failed or missing records", () => {
    for (const status of ["failed", "missing", "unsupported"] as const) {
      const contradictory = report();
      contradictory.analysisAdmission!.repositoryCoverage.status = "complete";
      contradictory.analysisAdmission!.repositoryCoverage.files.push({ path: "src/other.ts", status, reasons: ["NO_CURRENT_ANALYZED_SOURCE"] });
      expect(VerifyReportSchema.safeParse(contradictory).success).toBe(false);
    }
  });
  test("allows partial repository failures outside the admitted change and complete excluded files", () => {
    const partial = report();
    partial.analysisAdmission!.repositoryCoverage.files.push({ path: "src/unrelated.ts", status: "failed", reasons: ["PRODUCER_FAILED"] });
    expect(VerifyReportSchema.safeParse(partial).success).toBe(true);
    const uncertain = report();
    uncertain.analysisAdmission!.repositoryCoverage.status = "complete";
    uncertain.analysisAdmission!.repositoryCoverage.files.push({ path: "src/other.ts", status: "analyzed", reasons: ["PARTIAL_REFERENCE_COVERAGE"] });
    expect(VerifyReportSchema.safeParse(uncertain).success).toBe(false);
    const excluded = report();
    excluded.analysisAdmission!.repositoryCoverage.status = "complete";
    excluded.analysisAdmission!.repositoryCoverage.files.push({ path: "docs/guide.md", status: "excluded", reasons: ["INCLUDE_MISS"] });
    expect(VerifyReportSchema.safeParse(excluded).success).toBe(true);
  });
  test("keeps legacy and rejected noneligible or unknown changed paths diagnostic", () => {
    const legacy = report();
    delete legacy.analysisAdmission;
    legacy.changedFiles = ["docs/guide.md", "package.json"];
    expect(VerifyReportSchema.safeParse(legacy).success).toBe(true);
    const rejected = report();
    rejected.verdict = "BLOCK";
    rejected.analysisAdmission!.status = "rejected";
    rejected.changedFiles.push("src/untracked.ts", "docs/guide.md", "package.json");
    expect(VerifyReportSchema.safeParse(rejected).success).toBe(true);
  });
});
