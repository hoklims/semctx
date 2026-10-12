import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, VerifyReportSchema } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

const roots: string[] = [];
const unsupported = "function helper() { return true; } Object.defineProperty(Array, Symbol.hasInstance, { value: helper }); export function run(value) { return value instanceof Array; }\n";
const supported = unsupported.replace("Symbol.hasInstance", "'metadata'");
function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}
function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-current-admission-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  for (const [path, source] of Object.entries(files)) writeFileSync(join(root, path), source);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "core.autocrlf", "false");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*", "test/**/*"] });
  return root;
}
function refreshed(root: string, expected: string[]) {
  indexRepository(root, "2026-10-12T00:00:00.000Z");
  const observed = runVerify(root, { kind: "working-tree" });
  console.info(JSON.stringify({ expected, report: observed.report }));
  expect(VerifyReportSchema.safeParse(observed.report).success).toBe(true);
  const admission = observed.report.analysisAdmission!;
  expect(admission.indexFreshness).toEqual({ verdict: "DIRTY_KNOWN", reasons: ["WORKING_TREE_DIRTY"] });
  expect(admission.controlFreshness).toEqual({ verdict: "DIRTY_KNOWN", reasons: ["WORKING_TREE_DIRTY"] });
  expect(admission.checkFreshness).toEqual({ status: "current", reasons: [] });
  expect(admission.changeCoverage.expected).toEqual(expected);
  expect(admission.changeCoverage.analyzed).toEqual(expected);
  return observed;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("current protocol refusal preserves its precise diagnostic and current binding", () => {
  const root = repository({ "src/main.ts": "export function main() { return 1; }\n", "src/subject.ts": unsupported });
  writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
  const observed = refreshed(root, ["src/main.ts"]);
  expect(observed.report.verdict).toBe("BLOCK");
  expect(observed.report.analysisAdmission?.status).toBe("rejected");
  expect(observed.report.analysisAdmission?.reasons).toEqual(["DEPENDENCY_SCOPE_CONFIGURATION:src/subject.ts:SOURCE_PROTOCOL_DESCRIPTOR_UNSUPPORTED"]);
  expect(observed.report.analysisAdmission?.binding).toEqual({ status: "valid", reasons: [] });
}, 60_000);

test("otherwise admitted current source cannot erase an unsupported immutable HEAD subject", () => {
  const root = repository({ "src/main.ts": "export function main() { return 1; }\n", "src/subject.ts": unsupported });
  writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
  writeFileSync(join(root, "src/subject.ts"), supported);
  const observed = refreshed(root, ["src/main.ts", "src/subject.ts"]);
  const reason = "QUALIFIED_WORKING_TREE_BASE_CAPTURE_UNSUPPORTED:src/main.ts, src/subject.ts:DEPENDENCY_SCOPE_CONFIGURATION:src/subject.ts:SOURCE_PROTOCOL_DESCRIPTOR_UNSUPPORTED";
  expect(observed.report.verdict).toBe("BLOCK");
  expect(observed.report.analysisAdmission?.status).toBe("rejected");
  expect(observed.report.analysisAdmission?.reasons).toEqual([reason]);
  expect(observed.report.analysisAdmission?.binding).toEqual({ status: "invalid", reasons: [reason] });
}, 60_000);

test("admitted current source still recovers removed invariant and security guards", () => {
  const root = repository({ "src/main.ts": "/** @invariant fixed: stays fixed\n * @tag security */\nexport function main() { return 1; }\n" });
  writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
  const observed = refreshed(root, ["src/main.ts"]);
  expect(observed.report.analysisAdmission?.status).toBe("admitted");
  expect(observed.report.analysisAdmission?.reasons).toEqual([]);
  expect(observed.report.analysisAdmission?.binding).toEqual({ status: "valid", reasons: [] });
  expect(observed.report.verdict).toBe("BLOCK");
  expect(observed.result.findings.map(finding => finding.rule)).toContain("invariant_touched_without_test");
  expect(observed.result.findings.map(finding => finding.rule)).toContain("security_surface_without_verification");
}, 60_000);

test("admitted body replacement retains unchanged guards and its covering test", () => {
  const guard = "/** @invariant fixed: stays fixed */\n";
  const root = repository({ "src/main.ts": `${guard}export function main() { return 1; }\n`, "test/main.test.ts": 'import { expect, test } from "bun:test";\nimport { main } from "../src/main";\ntest("main", () => expect(main()).toBe(1));\n' });
  writeFileSync(join(root, "src/main.ts"), `${guard}export function main() { return 2; }\n`);
  const observed = refreshed(root, ["src/main.ts", "test/main.test.ts"]);
  expect(observed.report.analysisAdmission?.status).toBe("admitted");
  expect(observed.report.analysisAdmission?.reasons).toEqual([]);
  expect(observed.report.analysisAdmission?.binding).toEqual({ status: "valid", reasons: [] });
  expect(observed.report.verdict).not.toBe("BLOCK");
}, 60_000);
