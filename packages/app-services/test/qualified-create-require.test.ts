import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

const cases: { path: string; source: string; selected: boolean; barrel?: string; mainPath?: string }[] = [
  { path: "hidden.mjs", source: "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); export function hidden() { return load('./src/main.ts').main(); }", selected: true },
  { path: "hidden-alias.mjs", source: "import { createRequire as makeLoader } from 'module'; const load = makeLoader(import.meta.url); export const hidden = load('./src/main.ts');", selected: false },
  { path: "hidden-namespace.ts", source: "import * as nodeModule from 'node:module'; const load = nodeModule.createRequire(import.meta.url); export const hidden = load('./src/main.ts');", selected: false },
  { path: "hidden-barrel.ts", source: "import { make } from './barrel.mjs'; const load = make(import.meta.url); export const hidden = load('./src/main.ts');", selected: false, barrel: "export { createRequire as make } from 'node:module';" },
  { path: "hidden-assignment.mjs", source: "import * as m from 'node:module'; let n; n = m; const r = n.createRequire(import.meta.url); export const hidden = r('./src/main.mjs');", selected: false, mainPath: "src/main.mjs" },
  { path: "hidden-assignment.ts", source: "import * as m from 'module'; let n; n = m; const r = n.createRequire(import.meta.url); export const hidden = r('./src/main.mjs');", selected: false, mainPath: "src/main.mjs" },
];
for (const { path, source, selected, barrel, mainPath = "src/main.ts" } of cases) test(`qualified ${path} createRequire source cannot hide its CommonJS dependency`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-node-loader-"));
  const git = (...args: string[]): void => {
    const command = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (command.exitCode !== 0) throw new Error(new TextDecoder().decode(command.stderr));
  };
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, mainPath), "export function main() { return 1; }\n");
    writeFileSync(join(root, path!), source!);
    if (barrel !== undefined) writeFileSync(join(root, "barrel.mjs"), barrel);
    git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*.ts", "src/**/*.mjs", ...(selected ? [path!] : [])], languages: { typescript: "on", javascript: "on" } });
    indexRepository(root, "2026-10-09T10:00:00.000Z");
    writeFileSync(join(root, mainPath), "export function main() { return 2; }\n"); indexRepository(root, "2026-10-09T10:01:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    const cli = Bun.spawnSync(["bun", join(import.meta.dir, "../../../apps/cli/src/index.ts"), "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { stdout: "pipe", stderr: "pipe" });
    console.info(JSON.stringify({ path, selected, admission: report.analysisAdmission?.status, cliExit: cli.exitCode }));
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.reasons).toContain(`DEPENDENCY_SCOPE_COMMONJS_UNSUPPORTED:${barrel === undefined ? path : "barrel.mjs"}`);
    expect(cli.exitCode).toBe(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
