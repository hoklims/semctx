import assert from "node:assert/strict";
import { VerifyReportSchema, type AnalysisAdmission, type VerifyReport } from "@semantic-context/core";

export type Observation = { code: number; stdout: string; stderr: string };
export type RefusalExpectation = {
  binding?: AnalysisAdmission["binding"]["status"];
  indexFreshness?: AnalysisAdmission["indexFreshness"]["verdict"][];
};

type PositiveExpectation = { qualified?: boolean; verdict?: VerifyReport["verdict"] };

function positiveReport(value: unknown, expected: PositiveExpectation): VerifyReport {
  const verified = VerifyReportSchema.parse(value);
  assert.notEqual(verified.verdict, "BLOCK", "Positive verification must not block");
  if (expected.verdict !== undefined) assert.equal(verified.verdict, expected.verdict, "Positive verification must establish the claimed verdict");
  if (expected.qualified) assert.equal(verified.analysisAdmission?.status, "admitted", "Qualified positive verification must retain admitted analysis evidence");
  return verified;
}

export function assertPositiveReport(result: Observation, expected: PositiveExpectation = {}): VerifyReport {
  assert.equal(result.code, 0, "Positive verification must use numeric CLI exit 0");
  return positiveReport(JSON.parse(result.stdout), expected);
}

type McpReportEnvelope = { content?: unknown; isError?: unknown; structuredContent?: unknown };
function assertMcpReportEnvelope(result: McpReportEnvelope): void {
  assert(result.isError === undefined || result.isError === false, "MCP verification must not be a tool error or malformed error flag");
  assert(Array.isArray(result.content) && result.content.every(item => item !== null && typeof item === "object"
    && (item as Record<string, unknown>).type === "text" && typeof (item as Record<string, unknown>).text === "string"), "MCP verification must retain its text content envelope");
}

export function assertMcpPositiveReport(result: McpReportEnvelope, expected: PositiveExpectation = {}): VerifyReport {
  assertMcpReportEnvelope(result);
  return positiveReport(result.structuredContent, expected);
}

function qualifiedBlock(value: unknown, expected: RefusalExpectation): VerifyReport {
  const rejected = VerifyReportSchema.parse(value);
  assert.equal(rejected.verdict, "BLOCK", "Refusal must be represented by BLOCK");
  assert.equal(rejected.analysisAdmission?.status, "rejected", "Qualified refusal must retain explicit admission evidence");
  if (expected.binding !== undefined) assert.equal(rejected.analysisAdmission.binding.status, expected.binding, "Refusal must establish the claimed binding");
  if (expected.indexFreshness !== undefined) assert(expected.indexFreshness.includes(rejected.analysisAdmission.indexFreshness.verdict), "Refusal must establish the claimed index freshness");
  return rejected;
}

export function assertQualifiedBlock(result: Observation, expected: RefusalExpectation = {}): void {
  assert.equal(result.code, 3, "Qualified refusal must use CLI exit 3, not an infrastructure error");
  qualifiedBlock(JSON.parse(result.stdout), expected);
}

export function assertMcpQualifiedBlock(result: McpReportEnvelope, expected: RefusalExpectation = {}): VerifyReport {
  assertMcpReportEnvelope(result);
  return qualifiedBlock(result.structuredContent, expected);
}

export function assertOperationalError(result: Observation, code: "CONFIG_NOT_FOUND" | "CONFIG_INVALID" | "REPO_NOT_INDEXED", message: string): void {
  assert.equal(result.code, 1, "Expected operational error must use CLI exit 1");
  if (result.stdout.trim()) {
    const details = JSON.parse(result.stdout) as Record<string, unknown>;
    assert(details !== null && typeof details === "object" && !("verdict" in details) && !("analysisAdmission" in details), "Operational details are not an admission report");
  }
  assert(result.stderr.includes(`[${code}]`) && result.stderr.includes(message), `Expected deliberate ${code}: ${message}`);
}

export function assertLegacyQualifiedConfigRefusal(index: Observation, verify: Observation, root: string): void {
  assertOperationalError(index, "CONFIG_INVALID", "config.json failed schema validation");
  const details = JSON.parse(index.stdout) as { issues?: { code?: unknown; path?: unknown; expected?: unknown; received?: unknown }[] };
  assert(Array.isArray(details.issues) && details.issues.some(issue => issue.code === "invalid_literal"
    && Array.isArray(issue.path) && issue.path.length === 1 && issue.path[0] === "selectionMode"
    && issue.expected === "globs-v1" && issue.received === "qualified-static-v1"), "Legacy indexing must reject the exact unsupported qualified selection mode");
  assertOperationalError(verify, "REPO_NOT_INDEXED", "repository index is absent");
  assert.equal((JSON.parse(verify.stdout) as { root?: unknown }).root, root, "Legacy absent-index verification must retain the requested root");
}
