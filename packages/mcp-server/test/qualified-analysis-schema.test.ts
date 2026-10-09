import { expect, test } from "bun:test";
import type { VerifyReport } from "@semantic-context/core";
import { TOOL_OUTPUT_SCHEMAS } from "../src/tool-output-schemas";

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
test("public MCP output rejects stale, empty or unsupported positive admission and rejected PASS", () => {
  const schema = TOOL_OUTPUT_SCHEMAS.semctx_verify_change;
  expect(schema.safeParse(report()).success).toBe(true);
  const stale = report(); stale.analysisAdmission!.indexFreshness = { verdict: "STALE", reasons: ["ANALYSIS_INPUT_MISMATCH"] };
  expect(schema.safeParse(stale).success).toBe(false);
  const empty = report(); empty.analysisAdmission!.changeCoverage = { expected: [], analyzed: [], files: [] };
  expect(schema.safeParse(empty).success).toBe(false);
  const unsupported = report(); unsupported.analysisAdmission!.changeCoverage.files[0]!.status = "unsupported";
  expect(schema.safeParse(unsupported).success).toBe(false);
  const rejected = report(); rejected.analysisAdmission!.status = "rejected";
  expect(schema.safeParse(rejected).success).toBe(false);
});
