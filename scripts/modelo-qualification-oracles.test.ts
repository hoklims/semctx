import { expect, test } from "bun:test";
import type { AnalysisAdmission, VerifyReport } from "@semantic-context/core";
import { assertQualifiedBlock, assertOperationalError, assertPositiveReport, assertMcpPositiveReport, assertLegacyQualifiedConfigRefusal, assertMcpQualifiedBlock } from "./modelo-qualification-oracles";

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
function rejection(): VerifyReport & { analysisAdmission: AnalysisAdmission } {
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

function positive() {
  const value = rejection();
  value.verdict = "PASS";
  value.summary.blockCount = 0;
  value.analysisAdmission.status = "admitted";
  value.analysisAdmission.repositoryCoverage.status = "complete";
  value.analysisAdmission.changeCoverage.analyzed = ["src/main.ts"];
  value.analysisAdmission.changeCoverage.files = [{ path: "src/main.ts", status: "analyzed", reasons: [] as string[] }];
  value.analysisAdmission.reasons = [];
  return value;
}

test("positive CLI and plugin reports require numeric exit zero", () => {
  for (const code of [1, 7]) {
    expect(() => assertPositiveReport(observation(positive(), code), { qualified: true })).toThrow();
    expect(() => assertPositiveReport(observation(positive(), code), { verdict: "PASS" })).toThrow();
  }
});

test("positive CLI and plugin reports require every report field", () => {
  const { summary: _summary, ...malformed } = positive();
  expect(() => assertPositiveReport({ code: 0, stdout: JSON.stringify(malformed), stderr: "" }, { qualified: true })).toThrow();
  expect(() => assertPositiveReport({ code: 0, stdout: JSON.stringify(malformed), stderr: "" }, { verdict: "PASS" })).toThrow();
});

for (const freshness of ["indexFreshness", "controlFreshness"] as const) {
  test(`positive admission rejects contradictory ${freshness}`, () => {
    const value = positive();
    value.analysisAdmission[freshness] = { verdict: "STALE", reasons: ["SOURCE_CHANGED"] };
    expect(() => assertPositiveReport(observation(value, 0), { qualified: true })).toThrow();
    expect(() => assertMcpPositiveReport({ structuredContent: value }, { qualified: true })).toThrow();
  });
}

test("positive admission requires valid binding and current check", () => {
  const invalidBinding = positive(); invalidBinding.analysisAdmission.binding.status = "invalid";
  const changedCheck = positive(); changedCheck.analysisAdmission.checkFreshness.status = "changed";
  for (const value of [invalidBinding, changedCheck]) {
    expect(() => assertPositiveReport(observation(value, 0), { qualified: true })).toThrow();
    expect(() => assertMcpPositiveReport({ structuredContent: value }, { qualified: true })).toThrow();
  }
});

test("qualified positives cannot substitute a legacy PASS or rejected admission", () => {
  const { analysisAdmission: _admission, ...legacy } = positive();
  expect(() => assertPositiveReport({ code: 0, stdout: JSON.stringify(legacy), stderr: "" }, { qualified: true })).toThrow();
  expect(() => assertPositiveReport(observation(rejection(), 0), { qualified: true })).toThrow();
});

test("MCP positives reject errors even with matching structured fields", () => {
  expect(() => assertMcpPositiveReport({ isError: true, structuredContent: positive() }, { qualified: true })).toThrow();
});

test("MCP positives require a complete structured report", () => {
  const { summary: _summary, ...malformed } = positive();
  for (const structuredContent of [undefined, malformed]) {
    expect(() => assertMcpPositiveReport({ structuredContent }, { qualified: true })).toThrow();
  }
});

test("schema-valid current positive CLI plugin and MCP controls remain admitted", () => {
  const value = positive();
  const cli = assertPositiveReport(observation(value, 0), { qualified: true });
  const plugin = assertPositiveReport(observation(value, 0), { qualified: true });
  const mcp = assertMcpPositiveReport({ isError: false, structuredContent: value }, { qualified: true });
  expect(cli).toEqual(value); expect(plugin).toEqual(cli); expect(mcp).toEqual(cli);
});

test("schema-valid legacy PASS with exit zero needs no qualified admission", () => {
  const { analysisAdmission: _admission, ...legacy } = positive();
  expect(assertPositiveReport({ code: 0, stdout: JSON.stringify(legacy), stderr: "" }, { verdict: "PASS" })).toEqual(legacy);
});

function legacyQualifiedRefusals() {
  const root = "/legacy-consumer";
  return {
    root,
    index: { code: 1, stdout: JSON.stringify({ issues: [{ code: "invalid_literal", path: ["selectionMode"], expected: "globs-v1", received: "qualified-static-v1" }] }), stderr: "ERROR [CONFIG_INVALID] config.json failed schema validation" },
    verify: { code: 1, stdout: JSON.stringify({ root }), stderr: `ERROR [REPO_NOT_INDEXED] repository index is absent at ${root}` },
  };
}

test("legacy qualified configuration refusal retains its precise issue and absent-index result", () => {
  const { index, verify, root } = legacyQualifiedRefusals();
  expect(() => assertLegacyQualifiedConfigRefusal(index, verify, root)).not.toThrow();
});

test("legacy qualified index refusal rejects wrong exit diagnostic or issue", () => {
  const { index, verify, root } = legacyQualifiedRefusals();
  for (const corrupted of [
    { ...index, code: 7 }, { ...index, stderr: "crash" },
    { ...index, stdout: JSON.stringify({ issues: [] }) },
    { ...index, stdout: JSON.stringify({ issues: [{ code: "invalid_literal", path: ["other"], expected: "globs-v1", received: "qualified-static-v1" }] }) },
    { ...index, stdout: JSON.stringify({ issues: [{ code: "invalid_literal", path: ["selectionMode"], expected: "qualified-static-v1", received: "globs-v1" }] }) },
    { ...index, stdout: JSON.stringify({ issues: [{ code: "other", path: ["selectionMode"], expected: "globs-v1", received: "qualified-static-v1" }] }) },
  ]) expect(() => assertLegacyQualifiedConfigRefusal(corrupted, verify, root)).toThrow();
});

test("legacy absent-index verification rejects wrong exit crash admission or root", () => {
  const { index, verify, root } = legacyQualifiedRefusals();
  for (const corrupted of [
    { ...verify, code: 0 }, { ...verify, code: 3 }, { ...verify, stderr: "crash" },
    { ...verify, stderr: "ERROR [CONFIG_INVALID] config.json failed schema validation" },
    { ...verify, stdout: JSON.stringify(positive()) }, { ...verify, stdout: "{}" },
    { ...verify, stdout: JSON.stringify({ root: "/another-consumer" }) },
  ]) expect(() => assertLegacyQualifiedConfigRefusal(index, corrupted, root)).toThrow();
});

test("MCP qualified rejection requires a non-error complete tool envelope", () => {
  const envelope = { content: [{ type: "text", text: JSON.stringify(rejection()) }], structuredContent: rejection() };
  expect(() => assertMcpQualifiedBlock(envelope)).not.toThrow();
  for (const malformed of [
    { ...envelope, isError: true }, { ...envelope, isError: "false" },
    { ...envelope, content: undefined }, { ...envelope, content: "BLOCK" },
  ]) expect(() => assertMcpQualifiedBlock(malformed)).toThrow();
});

test("MCP qualified rejection requires the full shared verify report schema", () => {
  const value = rejection();
  const { summary: _summary, ...missingSummary } = value;
  const { identity: _identity, ...missingIdentity } = value.analysisAdmission;
  const { changeCoverage: _coverage, ...missingCoverage } = value.analysisAdmission;
  const { repositoryCoverage: _repository, ...missingRepository } = value.analysisAdmission;
  for (const structuredContent of [
    { verdict: "BLOCK", analysisAdmission: { status: "rejected" } }, missingSummary,
    { ...value, analysisAdmission: missingIdentity }, { ...value, analysisAdmission: missingCoverage }, { ...value, analysisAdmission: missingRepository },
    { ...value, analysisAdmission: { ...value.analysisAdmission, reasons: "stale" } },
    { ...value, verdict: "PASS" },
  ]) expect(() => assertMcpQualifiedBlock({ content: [], structuredContent })).toThrow();
});

test("MCP stale refusal retains the claimed freshness and complete BLOCK control", () => {
  const value = rejection(); value.analysisAdmission.indexFreshness = { verdict: "STALE", reasons: ["ANALYSIS_INPUT_MISMATCH"] };
  const envelope = { content: [], structuredContent: value };
  expect(() => assertMcpQualifiedBlock(envelope, { indexFreshness: ["STALE", "UNSEALED"] })).not.toThrow();
  expect(() => assertMcpQualifiedBlock(envelope, { indexFreshness: ["FRESH", "DIRTY_KNOWN"] })).toThrow();
});
