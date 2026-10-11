import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

const cases = [
  ["species", "function helper() {} Object.defineProperty(Array, Symbol.species, { value: helper }); export function run() { return [1, 2].slice(); }", "PROTOCOL_DESCRIPTOR_UNSUPPORTED"],
  ["sort", "const values = [{ toString() { return 'b'; } }, { toString() { return 'a'; } }]; export function run() { return values.sort(); }", "SORT_COERCION_UNSUPPORTED"],
  ["vm", "import { runInThisContext } from 'node:vm'; export function run() { return runInThisContext('7'); }", "RUNTIME_EVALUATION_UNSUPPORTED"],
] as const;
for (const [name, content, reason] of cases) for (const extension of ["ts", "js"]) for (const selected of [true, false]) test(`qualified ${name} ${extension}, selected ${selected}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-implicit-hooks-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    writeFileSync(join(root, `${selected ? 'src/' : ''}subject.${extension}`), content);
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" }); if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const admission = runVerify(root, { kind: "working-tree" }).report.analysisAdmission;
    console.info(JSON.stringify({ name, extension, selected, admission }));
    expect(admission?.status).toBe("rejected");
    expect(admission?.reasons.some(value => value.includes(reason))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);
