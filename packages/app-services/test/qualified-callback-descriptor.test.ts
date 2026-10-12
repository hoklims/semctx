import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexHealth, indexRepository, runVerify } from "../src";

for (const [extension, content, reason, label] of [
  ["js", "function helper() { return 1; } export function start() { return setTimeout(helper, 0); }", "TIMER_CALLBACK_UNSUPPORTED", "native callback"],
  ["ts", "function helper() { return 1; } const box = {}; Object.defineProperty(box, 'value', { get: helper }); export function read() { return box.value; }", "DESCRIPTOR_ACCESSOR_UNSUPPORTED", "literal descriptor"],
  ["ts", "declare function eval(source: string): unknown; export function run() { return eval(\"import('./hidden.js')\"); }", "AMBIENT_FUNCTION_UNSUPPORTED", "ambient declaration"],
  ["js", "const { defineProperty } = Object; function helper() { return 1; } const box = {}; export function start() { defineProperty.call(Object, box, 'value', { get: helper }); return box.value; }", "DESCRIPTOR_ACCESSOR_UNSUPPORTED", "shorthand follow-up"],
  ["ts", "function helper() { return 1; } const box = {}; Object.defineProperty(box, 'value', { __proto__: { get: helper } }); export function read() { return box.value; }", "DESCRIPTOR_ACCESSOR_UNSUPPORTED", "prototype follow-up"],
] as const) for (const selected of [true, false]) test(`qualified ${reason} ${label}, selected ${selected}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-callback-descriptor-"));
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
    expect(report.analysisAdmission?.reasons.some(item => item.includes(reason))).toBe(true);
    if (selected) expect(indexHealth(root).candidates.find(candidate => candidate.path === path)?.analysisReasons.some(item => item.includes(reason))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
