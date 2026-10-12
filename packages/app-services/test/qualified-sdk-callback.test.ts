import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexHealth, indexRepository, runVerify } from "../src";
import { discoverRepository, extractTypeScript } from "@semantic-context/ts-analyzer";

for (const [content, label] of [
  ["function helper(value) { return value; } export function run() { return [1].map(helper); }", "method"],
  ["function executor() {} export async function run() { await new Promise(executor); }", "constructor"],
] as const) for (const extension of ["ts", "js"]) for (const selected of [true, false]) test(`qualified SDK ${label} callback ${extension}, selected ${selected}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-sdk-callback-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    const path = `${selected ? "src/" : ""}subject.${extension}`; writeFileSync(join(root, path), content);
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n"); indexRepository(root, "2026-10-11T10:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    console.info(JSON.stringify({ path, status: report.analysisAdmission?.status, reasons: report.analysisAdmission?.reasons }));
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.reasons.some(reason => reason.includes("SDK_CALLBACK_UNSUPPORTED"))).toBe(true);
    if (selected) expect(indexHealth(root).candidates.find(candidate => candidate.path === path)?.analysisReasons.some(reason => reason.includes("SDK_CALLBACK_UNSUPPORTED"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test("JavaScript migration-directory source retains exported facts, test association and recommendation", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-js-migration-source-"));
  try {
    mkdirSync(join(root, "migrations")); mkdirSync(join(root, "test"));
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    const step = join(root, "migrations/step.js"); const check = join(root, "test/step.test.js");
    writeFileSync(step, "export function step() { return 1; }\n");
    writeFileSync(check, "import { step } from '../migrations/step.js'; export function check() { return step(); }\n");
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    }
    const config = { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1" as const, analysisProfile: "modelo-suite-static-v1" as const, include: ["**/*"], languages: { typescript: "on" as const, javascript: "on" as const } };
    initWorkspace(root, config);
    expect(discoverRepository(config).files.find(file => file.relPath === "migrations/step.js")?.role).toBe("source");
    const extraction = extractTypeScript([step, check], root);
    expect(extraction.symbols).toContainEqual(expect.objectContaining({ relPath: "migrations/step.js", name: "step", exported: true }));
    expect(extraction.calls).toContainEqual(expect.objectContaining({ callerRelPath: "test/step.test.js", calleeRelPath: "migrations/step.js", calleeSymbolPath: "step" }));
    writeFileSync(step, "export function step() { return 2; }\n");
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    expect(report.analysisAdmission?.status).toBe("admitted");
    expect(report.recommendedTests.some(test => test.file === "test/step.test.js")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
