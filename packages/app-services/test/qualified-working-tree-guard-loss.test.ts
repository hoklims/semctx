import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, VerifyReportSchema } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

const roots: string[] = [];
const CLI = join(import.meta.dir, "../../../apps/cli/src/index.ts");
function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
function repository(source: string) {
  const root = mkdtempSync(join(tmpdir(), "semctx-qualified-worktree-guard-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(join(root, "src/value.ts"), source);
  git(root, "init", "-q", "-b", "main"); git(root, "add", "."); git(root, "commit", "-q", "-m", "guarded base");
  initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*", "test/**/*"] });
  return root;
}
function refreshed(root: string) {
  indexRepository(root, "2026-10-12T00:00:00.000Z");
  const observed = runVerify(root, { kind: "working-tree" });
  expect(VerifyReportSchema.safeParse(observed.report).success).toBe(true);
  expect(observed.report.analysisAdmission?.changeCoverage.analyzed).toContain("src/value.ts");
  expect(observed.report.analysisAdmission?.indexFreshness.verdict).toBe("DIRTY_KNOWN");
  expect(observed.report.analysisAdmission?.checkFreshness.status).toBe("current");
  return observed;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const [kind, rule, before, after] of [
  ["invariant", "invariant_touched_without_test", "/** @invariant fixed: stays fixed */\nexport function value() { return 1; }\n", "export function value() { return 1; }\n"],
  ["security", "security_surface_without_verification", "/** @tag security */\nexport function value() { return 1; }\n", "export function value() { return 1; }\n"],
  ["exported contract", "contract_changed_without_test", "export interface Value { value: number }\n", "interface Value { value: number }\nexport function value() { return 1; }\n"],
] as const) test(`refreshed qualified working tree cannot erase ${kind} guard`, () => {
  const root = repository(before);
  writeFileSync(join(root, "src/value.ts"), after);
  const observed = refreshed(root);
  console.info(JSON.stringify({ kind, report: observed.report }));
  expect(observed.result.findings.map((finding) => finding.rule)).toContain(rule);
  expect(observed.result.verdict).not.toBe("PASS");
  expect(observed.report.analysisAdmission?.status).toBe("admitted");
  const cli = Bun.spawnSync([process.execPath, CLI, "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { stdout: "pipe", stderr: "pipe" });
  expect(cli.exitCode).toBe(0);
  const report = JSON.parse(new TextDecoder().decode(cli.stdout));
  expect(VerifyReportSchema.safeParse(report).success).toBe(true);
  expect(report.analysisAdmission.status).toBe("admitted");
  expect(report.findings.map((finding: { rule: string }) => finding.rule)).toContain(rule);
}, 60_000);

test("pure addition preserves an unchanged guard and an actual covering test", () => {
  const root = repository("/** @invariant fixed: stays fixed */\nexport function value() { return 1; }\n");
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "test/value.test.ts"), 'import { expect, test } from "bun:test";\nimport { value } from "../src/value";\ntest("value", () => expect(value()).toBe(1));\n');
  git(root, "add", "test/value.test.ts"); git(root, "commit", "-q", "-m", "covering base test");
  writeFileSync(join(root, "src/value.ts"), "/** @invariant fixed: stays fixed */\nexport function value() { return 1; }\nexport function extra() { return 2; }\n");
  const observed = refreshed(root);
  expect(observed.report.analysisAdmission?.status).toBe("admitted");
  expect(observed.result.verdict).not.toBe("BLOCK");
}, 60_000);

test("body replacement with unchanged guard and covering test preserves existing admission", () => {
  const root = repository("/** @invariant fixed: stays fixed */\nexport function value() { return 1; }\n");
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "test/value.test.ts"), 'import { expect, test } from "bun:test";\nimport { value } from "../src/value";\ntest("value", () => expect(value()).toBe(1));\n');
  git(root, "add", "test/value.test.ts"); git(root, "commit", "-q", "-m", "covering base test");
  writeFileSync(join(root, "src/value.ts"), "/** @invariant fixed: stays fixed */\nexport function value() { return 2; }\n");
  const observed = refreshed(root);
  console.info(JSON.stringify({ bodyReplacement: observed.report }));
  expect(observed.report.analysisAdmission?.status).toBe("admitted");
  expect(observed.result.verdict).not.toBe("BLOCK");
}, 60_000);

test("retained authored output imports a force-tracked covering test without touching the live index", () => {
  const root = repository('/** @invariant fixed: stays fixed */\nexport function value() { return 1; }\n');
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, ".gitignore"), ".semctx/\ndist/\n");
  writeFileSync(join(root, "dist/cover.test.ts"), 'import { expect, test } from "bun:test";\nimport { value } from "../src/value";\ntest("value", () => expect(value()).toBe(1));\n');
  const configPath = join(root, ".semctx/config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.include.push("dist/**/*");
  writeFileSync(configPath, JSON.stringify(config));
  git(root, "add", ".gitignore"); git(root, "add", "-f", "dist/cover.test.ts"); git(root, "commit", "-q", "-m", "ignored authored test");
  writeFileSync(join(root, "src/value.ts"), 'export function value() { return 1; }\n');
  const beforeIndex = readFileSync(join(root, ".git/index"));
  const observed = refreshed(root);
  expect(readFileSync(join(root, ".git/index"))).toEqual(beforeIndex);
  expect(observed.report.analysisAdmission?.status).toBe("admitted");
  expect(observed.result.verdict).not.toBe("BLOCK");
  expect(observed.result.findings.map(finding => finding.rule)).not.toContain("invariant_touched_without_test");
}, 60_000);

test("marker removal covered by a new current covering test remains admitted", () => {
  const root = repository('/** @invariant fixed: stays fixed */\nexport function value() { return 1; }\n');
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "test/value.test.ts"), 'import { expect, test } from "bun:test";\nimport { value } from "../src/value";\ntest("value", () => expect(value()).toBe(1));\n');
  git(root, "add", "test");
  writeFileSync(join(root, "src/value.ts"), 'export function value() { return 1; }\n');
  const observed = refreshed(root);
  expect(observed.report.analysisAdmission?.status).toBe("admitted");
  expect(observed.result.verdict).not.toBe("BLOCK");
  expect(observed.result.findings.map(finding => finding.rule)).not.toContain("invariant_touched_without_test");
}, 60_000);

for (const [kind, source, configFiles] of [
  ["parse", 'export function value( { return 1; }\n', []],
  ["module", 'const value = require("node:fs");\nexport { value };\n', []],
  ["inherited compiler policy", 'export function value() { return 1; }\n', [["tsconfig.json", '{"extends":"./base-config.json"}'], ["base-config.json", '{"compilerOptions":{"module":"CommonJS"}}']]],
] as const) test(`unsupported old ${kind} cannot authorize a clean replacement`, () => {
  const root = repository(source);
  for (const [path, content] of configFiles) writeFileSync(join(root, path), content);
  if (configFiles.length > 0) { git(root, "add", "."); git(root, "commit", "-q", "-m", "old compiler policy"); }
  writeFileSync(join(root, "src/value.ts"), 'export function value() { return 2; }\n');
  if (configFiles.length > 0) writeFileSync(join(root, "base-config.json"), '{"compilerOptions":{"module":"ESNext"}}');
  indexRepository(root, "2026-10-12T00:00:00.000Z");
  const observed = runVerify(root, { kind: "working-tree" });
  expect(VerifyReportSchema.safeParse(observed.report).success).toBe(true);
  expect(observed.result.verdict).toBe("BLOCK");
  expect(observed.report.analysisAdmission?.reasons.some(reason => reason.startsWith("QUALIFIED_WORKING_TREE_BASE_CAPTURE_UNSUPPORTED:"))).toBe(true);
  expect(observed.report.findings.some(finding => finding.severity === "block" && finding.locations.some(location => location.file === "src/value.ts"))).toBe(true);
}, 60_000);

test("excluded old importer cannot disappear from retained dependency closure", () => {
  const root = repository('export function value() { return 1; }\n');
  mkdirSync(join(root, "other"));
  writeFileSync(join(root, "other/importer.ts"), 'import { value } from "../src/value";\nexport const copy = value();\n');
  git(root, "add", "other"); git(root, "commit", "-q", "-m", "old excluded importer");
  writeFileSync(join(root, "src/value.ts"), 'export function value() { return 2; }\n');
  writeFileSync(join(root, "other/importer.ts"), 'export const copy = 0;\n');
  const observed = refreshed(root);
  expect(observed.result.verdict).toBe("BLOCK");
  expect(observed.report.analysisAdmission?.reasons.some(reason => reason.includes("QUALIFIED_WORKING_TREE_BASE_CAPTURE_UNSUPPORTED") && reason.includes("other/importer.ts"))).toBe(true);
}, 60_000);

for (const fault of ["missing input", "raw byte mismatch", "gitlink", "unsafe path", "scratch drift"] as const) {
  test(`immutable old capture refuses ${fault} as a structured result`, () => {
    const root = repository('/** @invariant fixed: stays fixed */\nexport function value() { return 1; }\n');
    writeFileSync(join(root, "src/value.ts"), 'export function value() { return 1; }\n');
    indexRepository(root, "2026-10-12T00:00:00.000Z");
    const original = Bun.spawnSync;
    let injected = false;
    const spy = spyOn(Bun, "spawnSync").mockImplementation((...args) => {
      const command = args[0];
      const result = Reflect.apply(original, Bun, args) as ReturnType<typeof Bun.spawnSync>;
      if (!Array.isArray(command)) return result;
      if (!injected && command[1] === "ls-tree" && fault === "gitlink") {
        injected = true;
        return { ...result, stdout: Buffer.concat([result.stdout!, Buffer.from(`160000 commit ${git(root, "rev-parse", "HEAD")}\tsrc/vendor\0`)]) };
      }
      if (!injected && command[1] === "ls-tree" && fault === "unsafe path") {
        injected = true;
        return { ...result, stdout: Buffer.from(new TextDecoder().decode(result.stdout).replace("src/value.ts", "src/../value.ts")) };
      }
      if (!injected && command[1] === "cat-file" && fault === "missing input") {
        injected = true;
        return { ...result, stdout: Buffer.from("missing\n") };
      }
      if (!injected && command[1] === "cat-file" && fault === "raw byte mismatch") {
        injected = true;
        return { ...result, stdout: Buffer.from(new TextDecoder().decode(result.stdout).replace("return 1", "return 9")) };
      }
      const options = args[1] as { cwd?: string } | undefined;
      if (!injected && fault === "scratch drift" && command.includes("--index-info") && options?.cwd !== root) {
        injected = true;
        const scratch = options!.cwd!;
        writeFileSync(join(scratch, "src/value.ts"), 'export function tampered() { return 9; }\n');
      }
      return result;
    });
    let observed: ReturnType<typeof runVerify>;
    try { observed = runVerify(root, { kind: "working-tree" }); }
    finally { spy.mockRestore(); }
    expect(injected).toBe(true);
    expect(VerifyReportSchema.safeParse(observed.report).success).toBe(true);
    expect(observed.result.verdict).toBe("BLOCK");
    expect(observed.report.analysisAdmission?.status).toBe("rejected");
    expect(observed.report.analysisAdmission?.reasons.some(reason => reason.startsWith("QUALIFIED_WORKING_TREE_BASE_CAPTURE_UNSUPPORTED:"))).toBe(true);
  }, 60_000);
}

test("unrelated old unsupported source outside dependency closure does not refuse a supported body edit", () => {
  const root = repository('export function value() { return 1; }\n');
  writeFileSync(join(root, "src/unrelated.py"), 'def unrelated(:\n');
  git(root, "add", "src/unrelated.py"); git(root, "commit", "-q", "-m", "old unrelated disabled Python source");
  const configPath = join(root, ".semctx/config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.languages.python = "off";
  writeFileSync(configPath, JSON.stringify(config));
  // Selected disabled Python is repository partial, outside the bounded TS/JS changed closure.
  writeFileSync(join(root, "src/value.ts"), 'export function value() { return 2; }\n');
  const observed = refreshed(root);
  console.info(JSON.stringify({ unrelatedPartial: observed.report }));
  expect(observed.report.analysisAdmission?.changeCoverage.expected).toEqual(["src/value.ts"]);
  expect(observed.report.analysisAdmission?.status).toBe("admitted");
  expect(observed.result.verdict).not.toBe("BLOCK");
}, 60_000);

test("unreadable immutable HEAD capture is rejected by CLI even under advisory none", () => {
  const root = repository('/** @invariant fixed: stays fixed */\nexport function value() { return 1; }\n');
  writeFileSync(join(root, "src/value.ts"), 'export function value() { return 1; }\n');
  indexRepository(root, "2026-10-12T00:00:00.000Z");
  const entry = join(root, ".git/base-capture-cli.ts");
  const module = (path: string): string => JSON.stringify(join(import.meta.dir, path).replaceAll("\\", "/"));
  writeFileSync(entry, `import {runVerifyDiff} from ${module("../../../apps/cli/src/commands/verify.ts")};
import {parseArgs} from ${module("../../../apps/cli/src/args.ts")};
const original=Bun.spawnSync;
Bun.spawnSync=((...args)=>{
 const command=args[0];const result=Reflect.apply(original,Bun,args);
 return Array.isArray(command)&&command[1]==="cat-file"?{...result,exitCode:1}:result;
}) as typeof Bun.spawnSync;
process.exit(runVerifyDiff(process.argv[2]!,parseArgs(["verify","diff","--format","json","--fail-on","none"])));
`);
  const cli = Bun.spawnSync([process.execPath, entry, root], { stdout: "pipe", stderr: "pipe" });
  expect(cli.exitCode).toBe(3);
  const report = JSON.parse(new TextDecoder().decode(cli.stdout));
  expect(VerifyReportSchema.safeParse(report).success).toBe(true);
  expect(report.analysisAdmission.status).toBe("rejected");
  expect(report.analysisAdmission.reasons.some((reason: string) => reason.startsWith("QUALIFIED_WORKING_TREE_BASE_CAPTURE_UNSUPPORTED:"))).toBe(true);
}, 60_000);

test("unsupported excluded old loader cannot hide its guard dependency from closure", () => {
  const root = repository('export function value() { return 1; }\n');
  mkdirSync(join(root, "other"));
  writeFileSync(join(root, "other/importer.ts"), 'const path = "../src/value";\nexport async function run() { return import(path); }\n');
  git(root, "add", "other"); git(root, "commit", "-q", "-m", "old computed loader");
  writeFileSync(join(root, "src/value.ts"), 'export function value() { return 2; }\n');
  writeFileSync(join(root, "other/importer.ts"), 'export const safe = 0;\n');
  const observed = refreshed(root);
  expect(observed.result.verdict).toBe("BLOCK");
  expect(observed.report.analysisAdmission?.reasons.some(reason => reason.includes("QUALIFIED_WORKING_TREE_BASE_CAPTURE_UNSUPPORTED") && reason.includes("other/importer.ts"))).toBe(true);
}, 60_000);

test("ignored force-tracked old output dependency has an explicit eligibility decision", () => {
  const root = repository('import { legacy } from "../dist/legacy";\nexport function value() { return legacy; }\n');
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, ".gitignore"), ".semctx/\ndist/\n");
  writeFileSync(join(root, "dist/legacy.ts"), 'export const legacy = 1;\n');
  git(root, "add", ".gitignore"); git(root, "add", "-f", "dist/legacy.ts"); git(root, "commit", "-q", "-m", "old ignored authored dependency");
  writeFileSync(join(root, "src/value.ts"), 'export function value() { return 2; }\n');
  const observed = refreshed(root);
  expect(observed.result.verdict).toBe("BLOCK");
  expect(observed.report.analysisAdmission?.reasons.some(reason => reason.includes("QUALIFIED_WORKING_TREE_BASE_CAPTURE_UNSUPPORTED") && reason.includes("dist/legacy.ts"))).toBe(true);
}, 60_000);
