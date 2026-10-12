import { expect, test } from "bun:test";
import { assertQualifiedBlock, assertOperationalError } from "./modelo-qualification-oracles";

for (const [name, code, stdout] of [
  ["crash with empty output", 1, ""],
  ["admission exit with empty output", 3, ""],
  ["empty JSON", 3, "{}"],
  ["JSON without verdict", 3, '{"analysisAdmission":{"status":"rejected"}}'],
  ["non-JSON operational error", 3, "failure"],
  ["plain BLOCK without admission", 3, '{"verdict":"BLOCK"}'],
] as const) {
  test(`qualified refusal rejects ${name}`, () => {
    expect(() => assertQualifiedBlock({ code, stdout, stderr: "infrastructure failure" })).toThrow();
  });
}

const digest = `sha256:${"a".repeat(64)}`;
function rejection() {
  return {
    schemaVersion: 1, verdict: "BLOCK", base: null, head: "HEAD", mergeBase: null, range: null,
    changedFiles: ["src/main.ts"], changedSymbols: [], impactedContracts: [], impactedInvariants: [],
    recommendedTests: [], contradictions: [], unknowns: [], findings: [], summary: { blockCount: 1, warnCount: 0 },
    analysisAdmission: {
      schemaVersion: 1, profile: "modelo-suite-static-v1", status: "rejected",
      identity: { source: digest, sourceCommits: ["a".repeat(40)], baseCommit: null, diff: digest, config: digest, analyzer: digest, indexSnapshot: digest },
      binding: { status: "valid", reasons: [] }, indexFreshness: { verdict: "DIRTY_KNOWN", reasons: ["WORKING_TREE_DIRTY"] },
      checkFreshness: { status: "current", reasons: [] }, controlFreshness: { verdict: "FRESH", reasons: [] },
      repositoryCoverage: { status: "partial", files: [] }, changeCoverage: { expected: ["src/main.ts"], analyzed: [], files: [] },
      reasons: ["SOURCE_COERCION_UNSUPPORTED"], limitations: [], proofObligations: [],
    },
  };
}
function observation(value = rejection(), code = 3) { return { code, stdout: JSON.stringify(value), stderr: "" }; }
test("structured qualified rejection passes", () => {
  expect(() => assertQualifiedBlock(observation())).not.toThrow();
});
test("a structured report on infrastructure exit is not a qualified refusal", () => {
  expect(() => assertQualifiedBlock(observation(rejection(), 1))).toThrow();
});
test("malformed JSON is not a qualified refusal", () => {
  expect(() => assertQualifiedBlock({ code: 3, stdout: "{", stderr: "" })).toThrow();
});

test("source refusal must have the claimed current binding and freshness", () => {
  const value = rejection();
  value.analysisAdmission.binding.status = "invalid";
  expect(() => assertQualifiedBlock(observation(value), { binding: "valid" })).toThrow();
  value.analysisAdmission.binding.status = "valid";
  value.analysisAdmission.indexFreshness.verdict = "STALE";
  expect(() => assertQualifiedBlock(observation(value), { indexFreshness: ["FRESH", "DIRTY_KNOWN"] })).toThrow();
  value.analysisAdmission.indexFreshness.verdict = "DIRTY_KNOWN";
  expect(() => assertQualifiedBlock(observation(value), { binding: "valid", indexFreshness: ["FRESH", "DIRTY_KNOWN"] })).not.toThrow();
});
test("operational errors require their named deliberate diagnostic", () => {
  const expected = { code: 1, stdout: "", stderr: "[CONFIG_NOT_FOUND] repository is not initialized at /fixture" };
  expect(() => assertOperationalError(expected, "CONFIG_NOT_FOUND", "repository is not initialized")).not.toThrow();
  for (const result of [{ ...expected, stderr: "crashed" }, { ...expected, code: 3 }, observation()]) {
    expect(() => assertOperationalError(result, "CONFIG_NOT_FOUND", "repository is not initialized")).toThrow();
  }
});

test("named operational errors may carry details JSON but never admission", () => {
  const result = { code: 1, stdout: JSON.stringify({ root: "/fixture" }), stderr: "[CONFIG_NOT_FOUND] repository is not initialized at /fixture" };
  expect(() => assertOperationalError(result, "CONFIG_NOT_FOUND", "repository is not initialized")).not.toThrow();
  expect(() => assertOperationalError({ ...result, stdout: "{}", stderr: "crash" }, "CONFIG_NOT_FOUND", "repository is not initialized")).toThrow();
});
