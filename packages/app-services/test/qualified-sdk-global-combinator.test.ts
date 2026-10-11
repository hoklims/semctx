import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

for (const [name, content] of [
  ["destructured SDK global", "function helper() { return 1; } [Math] = [{ random: helper }]; export function run() { return Math.random(); }"],
  ["asserted undefined comparator", "function helper() { return 1; } const values = [{toString:helper},{toString:helper}]; export function run() { return values.sort(undefined as any); }"],
  ["global replacement", "function helper() { return 1; } Math = { ...Math, random: helper }; export function run() { return Math.random(); }"],
  ["explicit primitive hook", "function helper() { return 'value'; } const value = {}; value[Symbol.toPrimitive] = helper; export function run() { return String(value); }"],
  ["combinator thenable", "function helper() {} export function run() { return Promise.all([{ then: helper }]); }"],
] as const) test(`causal helper change ${name}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-global-assimilation-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    const file = join(root, "src/main.ts"); writeFileSync(file, content);
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" }); if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"] });
    writeFileSync(file, content.replace("return 1;", "return 2;").replace("return 'value';", "return 'changed';").replace("function helper() {}", "function helper() { return 1; }"));
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const admission = runVerify(root, { kind: "working-tree" }).report.analysisAdmission;
    console.info(JSON.stringify({ name, admission }));
    expect(admission?.status).toBe("rejected");
    expect(admission?.reasons.length).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);
