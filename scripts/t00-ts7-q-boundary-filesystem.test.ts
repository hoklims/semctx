import { expect, test } from "bun:test";
import { dialectProperties, retainedSystemExecution } from "./t00-ts7-q-boundary-filesystem";

const subject = { path: "entry.ts", capabilityScope: { language: "typescript", dialectVersion: "7.1.0-dev" } };
const observed = {
  native_compiler_version: "7.1.0-dev",
  engine_revision: "780dc512d64f40afebffa6a7028207649fb7ed1c",
  producer_artifact_id: "sha256:abc",
  complete: true,
  subjects: [subject],
};

test("retained system refuses a nonzero process even when its JSON claims execution", () => {
  const row = { executed: true, unsupported: [], refusals: [] };
  const execution = { exitCode: 0, stdout: "", stderr: "", value: { executed: true, unsupported: [], reasons: [], results: [row] }, evidence: [] };
  expect(retainedSystemExecution(execution).pass).toBe(true);
  expect(retainedSystemExecution({ ...execution, exitCode: 1 }).pass).toBe(false);
  expect(retainedSystemExecution({ ...execution, value: {} }).pass).toBe(false);
  expect(retainedSystemExecution({ ...execution, value: { ...execution.value, results: [{ ...row, executed: false }] } }).pass).toBe(false);
  expect(retainedSystemExecution({ ...execution, value: { ...execution.value, results: [{ ...row, unsupported: ["UNIMPLEMENTED"] }] } }).pass).toBe(false);
  expect(retainedSystemExecution({ ...execution, value: { ...execution.value, results: [{ ...row, refusals: ["CAPTURE_INCOMPLETE"] }] } }).pass).toBe(false);
});

test("dialect evidence rejects a version string without any analyzed capability subject", () => {
  const checks = dialectProperties({ ...observed, subjects: [] }, "sha256:abc");
  expect(checks.length).toBeGreaterThan(0);
  expect(checks.some(check => !check.pass)).toBe(true);
});

test("dialect evidence requires exact candidate binding and every capability version", () => {
  expect(dialectProperties(observed, "sha256:abc").every(check => check.pass)).toBe(true);
  for (const altered of [
    { ...observed, producer_artifact_id: "sha256:foreign" },
    { ...observed, native_compiler_version: "5.9.3" },
    { ...observed, complete: false },
    { ...observed, subjects: [subject, { path: "other.ts", capabilityScope: {} }] },
    { ...observed, subjects: [subject, subject] },
    { ...observed, subjects: [{ ...subject, path: "" }] },
  ]) expect(dialectProperties(altered, "sha256:abc").some(check => !check.pass)).toBe(true);
});

test("relative import qualification rejects failed producer processes with correct JSON", async () => {
  const { filesystemObservations } = await import("./t00-ts7-q-boundary-filesystem");
  const { resultStatus } = await import("./t00-ts7-q-boundary-common");
  const sequence = ["./a", "../b", "./a", "./dynamic", "./nested", "./dynamic", "./options"];
  const evidence = { path: "/proof", sha256: "a".repeat(64), bytes: 1 };
  for (const exitCode of [0, 1, 137]) {
    const execution = { exitCode: 0, stdout: "a.ts successfully resolved", stderr: "", value: {}, evidence: [evidence] };
    const context = {
      root: "/project", sdk: {}, platform: "macos" as const, producerSha256: "a".repeat(64), helperSha256: "b".repeat(64), helper: "/helper",
      producerArtifact: evidence, oracleArtifact: evidence, receiveIdentity: () => Promise.resolve(execution),
      analysis: () => ({}), save: () => Promise.resolve(evidence), oracle: () => Promise.resolve(execution),
      extractionOracle: () => Promise.resolve({ ...execution, value: { relativeSpecifiers: { "fixture.tsx": sequence, "empty.tsx": [] } } }),
      applicationRuntime: () => Promise.resolve(execution),
      run: (label: string) => Promise.resolve({ ...execution, exitCode, value: { specifiers: label.includes("no-relative") ? [] : sequence } }),
    };
    const observations = await filesystemObservations(context, [230, 231]);
    expect(observations.map(row => resultStatus(row, false))).toEqual(exitCode === 0 ? ["qualified", "qualified"] : ["not_qualified", "not_qualified"]);
  }
});
