import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

const git = (root: string, ...args: string[]): void => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
};
for (const extension of ["ts", "js"]) for (const selected of [true, false]) for (const [name, content] of [
  ["nested callback", "import { register } from 'opaque'; function helper() { return 1; } export function run() { return register({ handler: helper }); }"],
  ["toJSON", "import { value } from './value'; export function run() { return JSON.stringify(value); }"],
] as const) test(`qualified ${name} ${extension}, selected ${selected}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-data-serialization-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "package.json"), '{"dependencies":{"opaque":"1.0.0"}}');
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    const prefix = selected ? "src/" : "";
    writeFileSync(join(root, `${prefix}subject.${extension}`), content);
    writeFileSync(join(root, `${prefix}value.${extension}`), "export const value = { toJSON() { return 1; } };\n");
    git(root, "init", "-q"); git(root, "add", "."); git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const admission = runVerify(root, { kind: "working-tree" }).report.analysisAdmission;
    console.info(JSON.stringify({ name, extension, selected, admission }));
    expect(admission?.status).toBe("rejected");
    expect(admission?.reasons.some(reason => reason.includes("UNSUPPORTED"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);

for (const [name, qualified, extra, expected] of [["qualified untracked", true, true, "rejected"], ["qualified tracked-only with ignored output", true, false, "admitted"], ["qualified ignored authored source", true, false, "rejected"], ["ordinary untracked", false, true, undefined]] as const) test(name, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-untracked-obligation-"));
  try {
    const ignoredOutput = name === "qualified tracked-only with ignored output";
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ignoredOutput ? ".semctx/\nnode_modules/\nbuild/\n" : ".semctx/\nnode_modules/\nignored.ts\n");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    git(root, "init", "-q"); git(root, "add", "."); git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), ...(qualified ? { selectionMode: "qualified-static-v1" as const, analysisProfile: "modelo-suite-static-v1" as const } : {}), include: ["src/**/*"] });
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
    if (extra) writeFileSync(join(root, "src/new.ts"), "export function extra() { return 1; }\n");
    if (ignoredOutput) mkdirSync(join(root, "build"));
    writeFileSync(join(root, ignoredOutput ? "build/ignored.ts" : "ignored.ts"), "export function ignored() { return 1; }\n");
    mkdirSync(join(root, ".semctx/reports")); writeFileSync(join(root, ".semctx/reports/ignored.json"), "{}");
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const admission = runVerify(root, { kind: "working-tree" }).report.analysisAdmission;
    console.info(JSON.stringify({ name, admission }));
    expect(admission?.status).toBe(expected);
    if (qualified && extra) expect(admission?.reasons).toContain("QUALIFIED_WORKING_TREE_UNTRACKED_INPUT:src/new.ts");
    if (name === "qualified ignored authored source") expect(admission?.binding).toEqual({ status: "invalid", reasons: ["QUALIFIED_WORKING_TREE_UNTRACKED_INPUT:ignored.ts"] });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);
