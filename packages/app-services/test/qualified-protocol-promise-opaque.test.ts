import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, VerifyReportSchema, type VerifyReport } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexHealth, indexRepository, runVerify } from "../src";

const cases = [
  {
    label: "PROTOCOL_DESCRIPTOR_UNSUPPORTED", role: "Object.defineProperty",
    content: "function helper() { return true; } Object.defineProperty(Array, Symbol.hasInstance, { value: helper }); export function run(value) { return value instanceof Array; }",
    control: "function helper() { return true; } Object.defineProperty(Array, 'metadata', { value: helper }); export function run(value) { return value instanceof Array; }",
  },
  {
    label: "PROTOCOL_MUTATION_UNSUPPORTED", role: "Reflect.set",
    content: "function helper() { return { next() { return { done: true, value: 1 }; } }; } const values = [1]; Reflect.set(values, Symbol.iterator, helper); export function run() { return [...values]; }",
    control: "function helper() { return { next() { return { done: true, value: 1 }; } }; } const values = [1]; Reflect.set(values, 'metadata', helper); export function run() { return [...values]; }",
  },
  {
    label: "PROTOCOL_DESCRIPTOR_UNSUPPORTED", role: "Reflect.defineProperty",
    content: "function helper() { return { next() { return { done: true, value: 1 }; } }; } const values = [1]; Reflect.defineProperty(values, Symbol.iterator, { value: helper }); export function run() { return [...values]; }",
    control: "function helper() { return { next() { return { done: true, value: 1 }; } }; } const values = [1]; Reflect.defineProperty(values, 'metadata', { value: helper }); export function run() { return [...values]; }",
  },
  {
    label: "PROMISE_ASSIMILATION_UNSUPPORTED", role: "Promise.resolve",
    content: "const value = { then() { return 1; } }; export function start() { return Promise.resolve(value); }",
    control: "const value = 1; export function start() { return Promise.resolve(value); }",
  },
  {
    label: "OPAQUE_CALLBACK_UNSUPPORTED", role: "opaque callback",
    content: "import { register } from 'opaque'; function helper() { return 1; } export function start() { return register(helper); }",
    control: "import { register } from 'opaque'; function helper() { return 1; } export function start() { return register(helper()); }",
  },
] as const;

function withFixture(content: string, extension: string, selected: boolean, check: (root: string, path: string, report: VerifyReport) => void): void {
  const root = mkdtempSync(join(tmpdir(), "semctx-sdk-callback-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    writeFileSync(join(root, "package.json"), '{"dependencies":{"opaque":"1.0.0"}}');
    const path = `${selected ? "src/" : ""}subject.${extension}`;
    writeFileSync(join(root, path), content);
    for (const args of [["init", "-q"], ["config", "core.autocrlf", "false"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    expect(VerifyReportSchema.safeParse(report).success).toBe(true);
    const admission = report.analysisAdmission;
    expect(admission?.binding).toEqual({ status: "valid", reasons: [] });
    expect(admission?.indexFreshness).toEqual({ verdict: "DIRTY_KNOWN", reasons: ["WORKING_TREE_DIRTY"] });
    expect(admission?.checkFreshness).toEqual({ status: "current", reasons: [] });
    expect(admission?.controlFreshness).toEqual({ verdict: "DIRTY_KNOWN", reasons: ["WORKING_TREE_DIRTY"] });
    expect(admission?.changeCoverage.expected).toEqual(["src/main.ts"]);
    expect(admission?.changeCoverage.analyzed).toEqual(["src/main.ts"]);
    expect(admission?.changeCoverage.files).toEqual([{ path: "src/main.ts", status: "analyzed", reasons: [] }]);
    check(root, path, report);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const { content, label, role } of cases) for (const extension of ["ts", "js"]) for (const selected of [true, false]) test(`qualified SDK ${role} ${label} callback ${extension}, selected ${selected}`, () => {
  withFixture(content, extension, selected, (root, path, report) => {
    const reason = `SOURCE_${label}`;
    expect(report.analysisAdmission?.reasons).toEqual([`DEPENDENCY_SCOPE_CONFIGURATION:${path}:${reason}`]);
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.verdict).toBe("BLOCK");
    if (selected) expect(indexHealth(root).candidates.find(candidate => candidate.path === path)?.analysisReasons).toContain(reason);
  });
}, 60_000);

for (const { control, role } of cases) test(`qualified SDK ${role} paired data control is admitted`, () => {
  withFixture(control, "ts", true, (root, path, report) => {
    expect(report.verdict).not.toBe("BLOCK");
    expect(report.analysisAdmission?.status).toBe("admitted");
    expect(report.analysisAdmission?.reasons).toEqual([]);
    expect(indexHealth(root).candidates.find(candidate => candidate.path === path)?.analysisReasons).toEqual([]);
  });
}, 60_000);

test("reassigned retained callee cannot publish primitive-data admission", () => {
  const original = "import { expect } from 'opaque'; function helper() {} function value() { return 1; } export function run() { return expect(value()); }\n";
  withFixture(original.replace("export function run", "value = () => helper; export function run"), "js", true, (_root, path, report) => {
    expect(report.analysisAdmission?.reasons).toEqual([`DEPENDENCY_SCOPE_CONFIGURATION:${path}:SOURCE_OPAQUE_CALLBACK_UNSUPPORTED`]);
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.verdict).toBe("BLOCK");
  });
  withFixture(original, "js", true, (_root, _path, report) => {
    expect(report.verdict).not.toBe("BLOCK");
    expect(report.analysisAdmission?.status).toBe("admitted");
    expect(report.analysisAdmission?.reasons).toEqual([]);
  });
}, 180_000);
