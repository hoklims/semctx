import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexHealth, indexRepository, runVerify } from "../src";

for (const [content, label] of [
  ["function helper() { return true; } Object.defineProperty(Array, Symbol.hasInstance, { value: helper }); export function run(value) { return value instanceof Array; }", "PROTOCOL_DESCRIPTOR_UNSUPPORTED"],
  ["function* helper() { yield 1; } const values = [1]; Reflect.set(values, Symbol.iterator, helper); export function run() { return [...values]; }", "PROTOCOL_MUTATION_UNSUPPORTED"],
  ["function* helper() { yield 1; } const values = [1]; Reflect.defineProperty(values, Symbol.iterator, { value: helper }); export function run() { return [...values]; }", "PROTOCOL_DESCRIPTOR_UNSUPPORTED"],
  ["const value = { then() { return 1; } }; export function start() { return Promise.resolve(value); }", "PROMISE_ASSIMILATION_UNSUPPORTED"],
  ["import { register } from 'opaque'; function helper() { return 1; } export function start() { return register(helper); }", "OPAQUE_CALLBACK_UNSUPPORTED"],
] as const) for (const extension of ["ts", "js"]) for (const selected of [true, false]) test(`qualified SDK ${label} callback ${extension}, selected ${selected}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-sdk-callback-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    writeFileSync(join(root,"package.json"), '{"dependencies":{"opaque":"1.0.0"}}');
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
    expect(report.analysisAdmission?.reasons.some(reason => reason.includes("UNSUPPORTED"))).toBe(true);
    if (selected) expect(indexHealth(root).candidates.find(candidate => candidate.path === path)?.analysisReasons.some(reason => reason.includes("UNSUPPORTED"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test("reassigned retained callee cannot publish primitive-data admission", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-return-mutation-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "package.json"), '{"dependencies":{"opaque":"1.0.0"}}');
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    writeFileSync(join(root, "src/subject.js"), "import { expect } from 'opaque'; function helper() {} function value() { return 1; } value = () => helper; export function run() { return expect(value()); }\n");
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" }); if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const admission = runVerify(root, { kind: "working-tree" }).report.analysisAdmission;
    console.info(JSON.stringify({ calleeMutationAdmission: admission }));
    expect(admission?.status).toBe("rejected");
    expect(admission?.reasons.some(reason => reason.includes("OPAQUE_CALLBACK_UNSUPPORTED"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);
