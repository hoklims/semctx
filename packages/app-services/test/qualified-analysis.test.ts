import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, createDefaultConfig, SemctxConfigSchema, VerifyReportSchema } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";
import { __setIndexRepositoryCaptureBarrierForTesting } from "../src/indexing";
import { __setVerifyAnalysisBarrierForTesting } from "../src/verify";

const roots: string[] = [];
test("reserved profile markers cannot silently downgrade through legacy config stripping", () => {
  const legacy = createDefaultConfig(".");
  expect(SemctxConfigSchema.safeParse(legacy).success).toBe(true);
  expect(SemctxConfigSchema.safeParse({ ...legacy, futureInformationalKey: "ignored" }).success).toBe(true);
  expect(SemctxConfigSchema.safeParse({ ...legacy, analysisProfile: "modelo-suite-static-v1" }).success).toBe(false);
  expect(SemctxConfigSchema.safeParse({ ...legacy, selectionMode: "qualified-static-v1" }).success).toBe(false);
  expect(SemctxConfigSchema.safeParse({ ...createGlobSelectionConfig("."), analysisProfile: "modelo-suite-static-v1" }).success).toBe(false);
  expect(SemctxConfigSchema.safeParse({ ...createGlobSelectionConfig("."), selectionMode: "qualified-static-v1" }).success).toBe(false);
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}
test("qualified profile refuses an excluded changed mjs even with an otherwise healthy index", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-qualified-")); roots.push(root);
  mkdirSync(join(root, "scripts")); mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(join(root, "src/main.ts"), "export const main = 1;\n");
  writeFileSync(join(root, "scripts/check.mjs"), "export const check = 1;\n");
  git(root, "init", "-q"); git(root, "add", ".");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture");
  initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", include: ["src/**/*.ts"], analysisProfile: "modelo-suite-static-v1" });
  indexRepository(root, "2026-10-09T10:00:00.000Z");
  writeFileSync(join(root, "scripts/check.mjs"), "export const check = 2;\n");
  const computation = runVerify(root, { kind: "working-tree" });
  expect(computation.result.verdict).toBe("BLOCK");
  expect(computation.report.analysisAdmission?.changeCoverage.files).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "scripts/check.mjs", status: "excluded" }),
  ]));
});

function selectedRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-qualified-selected-")); roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
  writeFileSync(join(root, "src/consumer.ts"), "import { main } from './main'; export function consume() { return main(); }\n");
  git(root, "init", "-q"); git(root, "add", ".");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture");
  initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", include: ["src/**/*.ts"], analysisProfile: "modelo-suite-static-v1" });
  indexRepository(root, "2026-10-09T10:00:00.000Z");
  return root;
}
test("stale inputs reject then actual rebuild admits current sources with dependent closure", () => {
  const root = selectedRepository();
  writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
  const stale = runVerify(root, { kind: "working-tree" });
  expect(stale.report.analysisAdmission?.status).toBe("rejected");
  expect(stale.report.analysisAdmission?.indexFreshness.verdict).toBe("STALE");
  indexRepository(root, "2026-10-09T10:01:00.000Z");
  const refreshed = runVerify(root, { kind: "working-tree" });
  expect(refreshed.report.analysisAdmission?.status).toBe("admitted");
  expect(refreshed.report.analysisAdmission?.changeCoverage.analyzed).toEqual(["src/consumer.ts", "src/main.ts"]);
  expect(refreshed.report.changedSymbols.map((symbol) => symbol.name)).toContain("main");
});
test("raw whitespace, excluded untracked sources and manifests invalidate analysis identity", () => {
  for (const [path, content] of [["src/main.ts", "export function main() { return 1; }  \n"], ["untracked.mjs", "export const hidden = 1;\n"], ["package.json", '{"name":"fixture","type":"module"}']]) {
    const root = selectedRepository(); writeFileSync(join(root, path!), content!);
    const report = runVerify(root, { kind: "working-tree" }).report;
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.indexFreshness.reasons).toContain("ANALYSIS_INPUT_MISMATCH");
  }
});
test("zero obligations never produce qualified admission", () => {
  const root = selectedRepository();
  expect(runVerify(root, { kind: "working-tree" }).report.analysisAdmission?.reasons).toContain("ZERO_ANALYZED_OBLIGATIONS");
});
test("an interrupted rebuild rejects the preserved old index even when inputs match", () => {
  const root = selectedRepository();
  writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
  indexRepository(root, "2026-10-09T10:01:00.000Z");
  __setIndexRepositoryCaptureBarrierForTesting(() => { throw new Error("interrupted fixture"); });
  expect(() => indexRepository(root, "2026-10-09T10:02:00.000Z")).toThrow("interrupted fixture");
  expect(runVerify(root, { kind: "working-tree" }).report.analysisAdmission?.reasons).toContain("INDEX_BUILD_INCOMPLETE");
});
test("a configured nested root cannot hide worktree obligations via git --relative", () => {
  const root = selectedRepository(); const nested = join(root, "src");
  initWorkspace(nested, { ...createGlobSelectionConfig(nested), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1" });
  indexRepository(nested, "2026-10-09T10:00:00.000Z");
  expect(() => runVerify(nested, { kind: "working-tree" })).toThrow("exact Git worktree root");
});
test("excluded parse-failed or computed importers cannot silently disappear from dependency scope", () => {
  for (const content of ["import { main } from './src/main'; export function broken( {", "const path = './src/main'; import(path);", "import { main } from '@hidden/inbound'; export const value = main();"]) {
    const root = selectedRepository();
    writeFileSync(join(root, "hidden.ts"), content);
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
    indexRepository(root, "2026-10-09T10:01:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.reasons.some((reason) => reason.startsWith("DEPENDENCY_SCOPE_"))).toBe(true);
  }
});
test("post-capture mutation is refused rather than describing the new bytes as analyzed", () => {
  const root = selectedRepository();
  writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
  indexRepository(root, "2026-10-09T10:01:00.000Z");
  __setVerifyAnalysisBarrierForTesting(() => writeFileSync(join(root, "hidden.ts"), "export const hidden = 1;\n"));
  const report = runVerify(root, { kind: "working-tree" }).report;
  expect(report.analysisAdmission?.checkFreshness.status).toBe("changed");
  expect(report.verdict).toBe("BLOCK");
});
test("structured validation rejects forged stale admission and a rejected PASS report", () => {
  const root = selectedRepository();
  writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
  indexRepository(root, "2026-10-09T10:01:00.000Z");
  const report = runVerify(root, { kind: "working-tree" }).report;
  expect(VerifyReportSchema.safeParse(report).success).toBe(true);
  const forged = { ...report, analysisAdmission: { ...report.analysisAdmission!, indexFreshness: { verdict: "STALE", reasons: ["ANALYSIS_INPUT_MISMATCH"] } } };
  expect(VerifyReportSchema.safeParse(forged).success).toBe(false);
  expect(VerifyReportSchema.safeParse({ ...report, verdict: "PASS", analysisAdmission: { ...report.analysisAdmission!, status: "rejected" } }).success).toBe(false);
});
test("CLI none policy cannot turn rejected qualified analysis into process success", () => {
  const root = selectedRepository();
  const process = Bun.spawnSync(["bun", join(import.meta.dir, "../../../apps/cli/src/index.ts"), "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { stdout: "pipe", stderr: "pipe" });
  expect(process.exitCode).toBe(3);
  const report = JSON.parse(new TextDecoder().decode(process.stdout));
  expect(report.analysisAdmission.status).toBe("rejected");
  expect(report.verdict).toBe("BLOCK");
});
test("qualified raw input inventory refuses an external directory link without following it", () => {
  const root = selectedRepository();
  const outside = mkdtempSync(join(tmpdir(), "semctx-qualified-outside-")); roots.push(outside);
  writeFileSync(join(outside, "hidden.ts"), "export const privateContent = 1;\n");
  symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  expect(() => runVerify(root, { kind: "working-tree" })).toThrow("cannot read a symbolic link");
});

test("excluded TypeScript dynamic construction cannot hide an inbound scope", () => {
  for (const content of [
    'const load = new Function("return import(\'./src/main.ts\')"); export const result = load();\n',
    'with (globalThis) { const load = packageLoader; load("./src/main.ts"); }\n',
  ]) {
    const root = selectedRepository();
    writeFileSync(join(root, "hidden.ts"), content);
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
    indexRepository(root, "2026-10-09T10:01:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.reasons).toContain("DEPENDENCY_SCOPE_RUNTIME_CODE:hidden.ts");
  }
});
