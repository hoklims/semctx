import { rejects } from "node:assert/strict";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { parseNativeHoldout, jointHoldoutAggregate, publicHoldoutAggregate, runFrozenHoldout } from "../tools/rust-ts-r0/qualification/holdout_runner.mjs";

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type PublicReceipt = { baseline: string; counts: { totalVariants: number; byPrimaryFamily: { family: string; variants: number }[] }; privateCommitments: { expectationsSha256: string } };
const receipt = JSON.parse(readFileSync(new URL("../docs/research/rust-ts-r0/cases/reserved/PUBLIC-FREEZE-RECEIPT.json", import.meta.url), "utf8")) as PublicReceipt;
const synthetic = () => ({
  schema_version: 1,
  oracle: { typescript_version: "5.9.3", baseline: receipt.baseline },
  units: receipt.counts.byPrimaryFamily.flatMap((family: { family: string; variants: number }) =>
    Array.from({ length: family.variants }, (_, index) => ({
      unit_id: `synthetic-${family.family}-${index}`,
      primary_family: family.family,
      surface: "primitive_cli",
      primitive_requests: [{ operation: "relative_import_specifiers", source: 'import "./synthetic";', filename: "main.ts" }],
      checks: [{ observation: 0, target: ["specifiers"], mode: "eq", expected: ["./synthetic"], expected_origin: "typescript-5.9.3", actual_transform: "none" }],
      gaps: [],
    }))),
});

describe("frozen holdout input protocol on authored synthetic data", () => {
  test("accepts the complete public family accounting with exact independent comparisons", () => {
    expect(parseNativeHoldout(synthetic(), receipt).units).toHaveLength(26);
  });

  test.each([
    ["missing oracle", (value: ReturnType<typeof synthetic>) => { delete (value as { oracle?: unknown }).oracle; }],
    ["foreign oracle", (value: ReturnType<typeof synthetic>) => { value.oracle.typescript_version = "7.1.0-dev"; }],
    ["empty inventory", (value: ReturnType<typeof synthetic>) => { value.units = []; }],
    ["duplicate unit", (value: ReturnType<typeof synthetic>) => { value.units[1] = value.units[0]!; }],
    ["unknown family", (value: ReturnType<typeof synthetic>) => { value.units[0]!.primary_family = "unknown"; }],
    ["incorrect family counts", (value: ReturnType<typeof synthetic>) => { value.units[0]!.primary_family = "qualified_refusals"; }],
    ["empty comparisons", (value: ReturnType<typeof synthetic>) => { value.units[0]!.checks = []; }],
    ["filtered comparison", (value: ReturnType<typeof synthetic>) => { Object.assign(value.units[0]!.checks[0]!, { actual_filter: { absent: true } }); }],
    ["arbitration substitution", (value: ReturnType<typeof synthetic>) => { Object.assign(value.units[0]!.checks[0]!, { version_arbitration: true }); }],
    ["missing expected", (value: ReturnType<typeof synthetic>) => { delete (value.units[0]!.checks[0] as { expected?: unknown }).expected; }],
    ["missing transform", (value: ReturnType<typeof synthetic>) => { delete (value.units[0]!.checks[0] as { actual_transform?: unknown }).actual_transform; }],
    ["missing invocation", (value: ReturnType<typeof synthetic>) => { value.units[0]!.primitive_requests = []; }],
    ["unknown field", (value: ReturnType<typeof synthetic>) => { Object.assign(value, { fallback: true }); }],
  ])("refuses %s", (_label, mutate) => {
    const input = synthetic();
    mutate(input);
    expect(() => parseNativeHoldout(input, receipt)).toThrow("HOLDOUT_FORMAT_NONCONFORMING");
  });
});


const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-holdout-synthetic-"));
  const file = (name: string, value: unknown) => {
    const path = join(root, name);
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };
  const inputPath = file("input.json", synthetic());
  const receiptPath = file("receipt.json", { ...receipt, privateCommitments: { expectationsSha256: digest(readFileSync(inputPath)) } });
  const contractPath = file("contract.md", "Authored synthetic contract");
  const lane: Record<string, string> = {};
  for (const name of ["artifact", "helper", "transport_fixture", "sdk"]) {
    lane[name + "_path"] = file(name, "synthetic-" + name);
    lane[name + "_sha256"] = digest(readFileSync(lane[name + "_path"]!));
  }
  lane.qualification_observer_path = process.execPath;
  lane.qualification_observer_sha256 = digest(readFileSync(process.execPath));
  const nativeFreeze = file("native-freeze.json", lane);
  const candidateSourceCommit = "0".repeat(40);
  const candidateFreezePath = file("candidate.json", { sourceCommit: candidateSourceCommit, lanes: { macos: { manifest: lane, freezeSha256: digest(readFileSync(nativeFreeze)) } } });
  const runner = new URL("../tools/rust-ts-r0/qualification/holdout_runner.mjs", import.meta.url);
  const freezePath = file("freeze.json", { runnerSha256: digest(readFileSync(runner)), contractPath, contractSha256: digest(readFileSync(contractPath)), receiptSha256: digest(readFileSync(receiptPath)), candidateFreezePath, candidateFreezeSha256: digest(readFileSync(candidateFreezePath)), candidateSourceCommit, platformFreezePaths: { macos: nativeFreeze }, runtimeSha256: { macos: digest(readFileSync(process.execPath)) } });
  return { root, lane, inputPath, receiptPath, freezePath, outputDirectory: join(root, "output"), platform: "macos" };
};

test.each(["pass", "nonpass", "wrong-binding", "missing-unit", "nonzero", "panic-after-pass", "missing-report", "pre-comparison-refusal", "throw-before-spawn"])("frozen invocation and aggregation: %s", async mode => {
  const setup = fixture();
  try {
    let calls = 0;
    const invoke = async (command: string[], environment: Record<string, string>) => {
      calls++;
      expect(command).toEqual([setup.lane.qualification_observer_path!, "suite_replay::suite_phase_a_replay_requires_frozen_manifest", "--exact", "--nocapture"]);
      expect(environment.SEMCTX_PROCESS_HELPER).toBe(setup.lane.helper_path!);
      if (mode === "throw-before-spawn") throw new Error("synthetic pre-spawn failure");
      const manifest = JSON.parse(readFileSync(environment.SEMCTX_SUITE_MANIFEST!, "utf8"));
      const report = { artifact_sha256: setup.lane.artifact_sha256, helper_sha256: setup.lane.helper_sha256, manifest_sha256: digest(readFileSync(environment.SEMCTX_SUITE_MANIFEST!)), units: manifest.units.map((unit: ReturnType<typeof synthetic>["units"][number], index: number) => ({ unit_id: unit.unit_id, result: { pass: mode !== "pre-comparison-refusal" && (mode !== "nonpass" || index !== 0), checks: mode === "pre-comparison-refusal" ? [] : unit.checks.map(check => ({ ...check, result: { state: mode === "nonpass" && index === 0 ? "MISMATCH" : "PASS_PROJECTED_PROPERTY" } })), relations: [] } })) };
      if (mode === "wrong-binding") report.artifact_sha256 = "foreign";
      if (mode === "missing-unit") report.units.pop();
      if (mode !== "missing-report") { mkdirSync(environment.SEMCTX_SUITE_EVIDENCE!); writeFileSync(join(environment.SEMCTX_SUITE_EVIDENCE!, "report.json"), JSON.stringify(report)); }
      return mode === "nonzero" ? 7 : ["nonpass", "panic-after-pass", "pre-comparison-refusal"].includes(mode) ? 101 : 0;
    };
    const result = await runFrozenHoldout(setup, invoke);
    expect(calls).toBe(1);
    expect(result.observerProcessInvocations).toBe(mode === "throw-before-spawn" ? 0 : 1);
    expect(result.observerInvocationAttempts).toBe(1);
    expect(result.variantsCompared).toBe(["pass", "nonpass"].includes(mode) ? 26 : 0);
    if (process.platform !== "win32") {
      expect(statSync(setup.outputDirectory).mode & 0o777).toBe(0o700);
      const report = join(setup.outputDirectory, "native-evidence/report.json");
      if (existsSync(report)) expect(statSync(report).mode & 0o777).toBe(0o600);
    }
    expect(result.variantsPass).toBe(mode === "pass" ? 26 : mode === "nonpass" ? 25 : 0);
    expect(result.state).toBe(["pass", "nonpass", "pre-comparison-refusal"].includes(mode) ? "REPORTED" : "EXECUTION_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain("synthetic-");
    await rejects(runFrozenHoldout(setup, invoke));
    expect(calls).toBe(1);
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test("a nonconforming frozen input is counted without adaptation or native invocation", async () => {
  const setup = fixture();
  try {
    writeFileSync(setup.inputPath, JSON.stringify({ privateSentinel: "synthetic-only-never-publish" }));
    const publicReceipt = JSON.parse(readFileSync(setup.receiptPath, "utf8"));
    publicReceipt.privateCommitments.expectationsSha256 = digest(readFileSync(setup.inputPath));
    writeFileSync(setup.receiptPath, JSON.stringify(publicReceipt));
    const freeze = JSON.parse(readFileSync(setup.freezePath, "utf8")); freeze.receiptSha256 = digest(readFileSync(setup.receiptPath)); writeFileSync(setup.freezePath, JSON.stringify(freeze));
    let calls = 0;
    const result = await runFrozenHoldout(setup, async () => { calls++; return 0; });
    expect(result.byPrimaryFamily.map((row: { formatFailure: number }) => row.formatFailure)).toEqual(receipt.counts.byPrimaryFamily.map((row: { variants: number }) => row.variants));
    expect(calls).toBe(0); expect(result.variantsFormatFailure).toBe(26); expect(result.variantsCompared).toBe(0); expect(result.observerProcessInvocations).toBe(0);
    expect(JSON.stringify(result)).not.toContain("synthetic-only-never-publish");
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test("the real subprocess failure cannot produce qualification", async () => {
  const setup = fixture();
  try { const result = await runFrozenHoldout(setup); expect(result.state).toBe("EXECUTION_UNAVAILABLE"); expect(result.variantsPass).toBe(0);
    if (process.platform !== "win32") for (const name of ["observer-stdout.log", "observer-stderr.log"]) expect(statSync(join(setup.outputDirectory, name)).mode & 0o777).toBe(0o600); }
  finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test("foreign committed bytes are refused before invoking or creating output", async () => {
  const setup = fixture();
  try { writeFileSync(setup.inputPath, "{}"); await rejects(runFrozenHoldout(setup), { message: "FROZEN_IDENTITY_MISMATCH" }); }
  finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test("private input and output paths inside the worktree are refused", async () => {
  const setup = fixture();
  try {
    const repository = resolve(import.meta.dir, "..");
    await rejects(runFrozenHoldout({ ...setup, inputPath: join(repository, "package.json") }), { message: "PRIVATE_DATA_IN_REPOSITORY_REFUSED" });
    await rejects(runFrozenHoldout({ ...setup, outputDirectory: join(repository, "synthetic-output-never-created") }), { message: "PRIVATE_DATA_IN_REPOSITORY_REFUSED" });
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test("publication exposes only public categories and counts", () => {
  const result = publicHoldoutAggregate(receipt, "REPORTED", [{ family: "module_resolution", pass: true, compared: true, privateSentinel: "synthetic-only-never-publish" }]);
  expect(result.variantsPass).toBe(1); expect(result.byPrimaryFamily).toHaveLength(8); expect(JSON.stringify(result)).not.toContain("synthetic-only-never-publish");
});


test("the executable freeze must agree with the candidate manifest, not just have a valid hash", async () => {
  const setup = fixture();
  try {
    const freeze = JSON.parse(readFileSync(setup.freezePath, "utf8"));
    const nativeFreeze = freeze.platformFreezePaths.macos;
    const lane = JSON.parse(readFileSync(nativeFreeze, "utf8"));
    lane.sdk_path = setup.inputPath; lane.sdk_sha256 = digest(readFileSync(setup.inputPath));
    writeFileSync(nativeFreeze, JSON.stringify(lane));
    const candidate = JSON.parse(readFileSync(freeze.candidateFreezePath, "utf8"));
    candidate.lanes.macos.freezeSha256 = digest(readFileSync(nativeFreeze));
    writeFileSync(freeze.candidateFreezePath, JSON.stringify(candidate));
    freeze.candidateFreezeSha256 = digest(readFileSync(freeze.candidateFreezePath)); writeFileSync(setup.freezePath, JSON.stringify(freeze));
    let calls = 0;
    await rejects(runFrozenHoldout(setup, async () => { calls++; return 0; }), { message: "FROZEN_MANIFEST_INCOHERENT" });
    expect(calls).toBe(0); expect(existsSync(setup.outputDirectory)).toBe(false);
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});


test("joint qualification intersects exact private units rather than adding or taking minimum counts", () => {
  const record = (platform: string, passing: number[]) => {
    const units = synthetic().units.map((unit, index) => ({ unitId: unit.unit_id, family: unit.primary_family, pass: passing.includes(index), compared: true }));
    const aggregate = { ...publicHoldoutAggregate(receipt, "REPORTED", units), platform, candidateSourceCommit: "synthetic-public-candidate", candidateFreezeSha256: "synthetic-public-freeze", contractSha256: "synthetic-public-contract", frozenRunnerSha256: "synthetic-public-runner", publicReceiptSha256: "synthetic-public-receipt", inputCommitmentSha256: receipt.privateCommitments.expectationsSha256 };
    return { units, aggregate };
  };
  expect(jointHoldoutAggregate(receipt, record("macos", [0, 1]), record("linux", [2, 3])).variantsPass).toBe(0);
  expect(jointHoldoutAggregate(receipt, record("macos", [0, 1]), record("linux", [1, 2])).variantsPass).toBe(1);
  const foreign = record("linux", [0]); foreign.aggregate.candidateFreezeSha256 = "foreign";
  expect(jointHoldoutAggregate(receipt, record("macos", [0]), foreign).variantsPass).toBe(0);
  const missing = record("linux", [0]); missing.units.pop();
  expect(jointHoldoutAggregate(receipt, record("macos", [0]), missing).state).toBe("EXECUTION_UNAVAILABLE");
  const a = record("macos", []); const b = record("linux", []);
  a.aggregate.state = "FORMAT_NONCONFORMING"; b.aggregate.state = "FORMAT_NONCONFORMING";
  expect(jointHoldoutAggregate(receipt, a, b).variantsFormatFailure).toBe(26);
});

test("the CLI publishes a bound joint aggregate without private unit IDs", () => {
  const setup = fixture();
  try {
    const freeze = JSON.parse(readFileSync(setup.freezePath, "utf8"));
    const frozenReceipt = JSON.parse(readFileSync(setup.receiptPath, "utf8")) as PublicReceipt;
    const units = synthetic().units.map(unit => ({ unitId: unit.unit_id, family: unit.primary_family, pass: true, compared: true }));
    const identity = { candidateSourceCommit: freeze.candidateSourceCommit, candidateFreezeSha256: freeze.candidateFreezeSha256, contractSha256: freeze.contractSha256, frozenRunnerSha256: freeze.runnerSha256, publicReceiptSha256: freeze.receiptSha256, inputCommitmentSha256: frozenReceipt.privateCommitments.expectationsSha256 };
    const paths = ["macos", "linux"].map(platform => {
      const path = join(setup.root, platform + ".json");
      writeFileSync(path, JSON.stringify({ aggregate: { ...publicHoldoutAggregate(frozenReceipt, "REPORTED", units), platform, ...identity }, units }));
      return path;
    });
    const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../tools/rust-ts-r0/qualification/holdout_runner.mjs"), "--joint", paths[0]!, paths[1]!, setup.outputDirectory, setup.receiptPath, setup.freezePath], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(JSON.parse(stdout).variantsPass).toBe(26);
    expect(stdout).not.toContain("synthetic-");
    if (process.platform !== "win32") expect(statSync(join(setup.outputDirectory, "aggregate.json")).mode & 0o777).toBe(0o600);
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});
