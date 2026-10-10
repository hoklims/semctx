import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

const cases: { path: string; source: string; selected: boolean; barrel?: string; mainPath?: string; unmodeled?: string }[] = [
  { path: "hidden-process-default.mjs", source: "import { default as p } from 'node:process'; const M = p.getBuiltinModule('module'); const r = M.createRequire(import.meta.url); export const hidden = r('./src/main.mjs');", selected: false, mainPath: "src/main.mjs", unmodeled: "process.getBuiltinModule" },
  { path: "hidden-process-destructure.ts", source: "const { getBuiltinModule: get } = process; const M = get('module'); const r = M.createRequire(import.meta.url); export const hidden = r('./src/main.mjs');", selected: false, mainPath: "src/main.mjs", unmodeled: "process.getBuiltinModule" },
  { path: "hidden.mjs", source: "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); export function hidden() { return load('./src/main.ts').main(); }", selected: true },
  { path: "hidden-alias.mjs", source: "import { createRequire as makeLoader } from 'module'; const load = makeLoader(import.meta.url); export const hidden = load('./src/main.ts');", selected: false },
  { path: "hidden-namespace.ts", source: "import * as nodeModule from 'node:module'; const load = nodeModule.createRequire(import.meta.url); export const hidden = load('./src/main.ts');", selected: false },
  { path: "hidden-barrel.ts", source: "import { make } from './barrel.mjs'; const load = make(import.meta.url); export const hidden = load('./src/main.ts');", selected: false, barrel: "export { createRequire as make } from 'node:module';" },
  { path: "hidden-assignment.mjs", source: "import * as m from 'node:module'; let n; n = m; const r = n.createRequire(import.meta.url); export const hidden = r('./src/main.mjs');", selected: false, mainPath: "src/main.mjs" },
  { path: "hidden-assignment.ts", source: "import * as m from 'module'; let n; n = m; const r = n.createRequire(import.meta.url); export const hidden = r('./src/main.mjs');", selected: false, mainPath: "src/main.mjs" },
  { path: "hidden-export-default.mjs", source: "import { default as M } from 'node:module'; const r = M.createRequire(import.meta.url); export const hidden = r('./src/main.mjs');", selected: false, mainPath: "src/main.mjs" },
  { path: "hidden-export-string.ts", source: "import { 'default' as M } from 'module'; const r = M.createRequire(import.meta.url); export const hidden = r('./src/main.mjs');", selected: false, mainPath: "src/main.mjs" },
  { path: "hidden-export-destructure.mjs", source: "import * as m from 'node:module'; const { default: M } = m; const r = M.createRequire(import.meta.url); export const hidden = r('./src/main.mjs');", selected: false, mainPath: "src/main.mjs" },
  { path: "hidden-export-module.ts", source: "import * as m from 'node:module'; const { Module: M } = m; const r = M.createRequire(import.meta.url); export const hidden = r('./src/main.mjs');", selected: false, mainPath: "src/main.mjs" },
  { path: "hidden-export-quoted.mjs", source: "import * as m from 'node:module'; const { 'createRequire': make } = m; const r = make(import.meta.url); export const hidden = r('./src/main.mjs');", selected: false, mainPath: "src/main.mjs" },
  { path: "hidden-native-load.mjs", source: "import M from 'node:module'; export const hidden = M._load('./src/main.mjs', undefined, false);", selected: false, mainPath: "src/main.mjs" },
  { path: "hidden-native-load.ts", source: "import { _load as nativeLoad } from 'module'; export const hidden = nativeLoad('./src/main.mjs', undefined, false);", selected: false, mainPath: "src/main.mjs" },
  { path: "hidden-native-prototype.mjs", source: "import M from 'node:module'; const loader = M.prototype.require; export const hidden = loader.call({filename: import.meta.filename}, './src/main.mjs');", selected: false, mainPath: "src/main.mjs", unmodeled: "prototype" },
  { path: "hidden-native-member.ts", source: "import { _resolveFilename as resolveName } from 'node:module'; export const hidden = resolveName('./src/main.mjs');", selected: false, mainPath: "src/main.mjs", unmodeled: "_resolveFilename" },
  { path: "hidden-global-getter.mjs", source: "const get = process.getBuiltinModule; const M = get('module'); const r = M.createRequire(import.meta.url); export const hidden = r('./src/main.mjs');", selected: false, mainPath: "src/main.mjs", unmodeled: "process.getBuiltinModule" },
  { path: "hidden-global-getter.ts", source: "const M = process.getBuiltinModule('module'); const r = M.createRequire(import.meta.url); export const hidden = r('./src/main.mjs');", selected: false, mainPath: "src/main.mjs", unmodeled: "process.getBuiltinModule" },
];
for (const { path, source, selected, barrel, mainPath = "src/main.ts", unmodeled } of cases) test(`qualified ${path} createRequire source cannot hide its CommonJS dependency`, () => {
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
    expect(report.analysisAdmission?.reasons).toContain(unmodeled === undefined
      ? `DEPENDENCY_SCOPE_COMMONJS_UNSUPPORTED:${barrel === undefined ? path : "barrel.mjs"}`
      : `DEPENDENCY_SCOPE_NATIVE_MODULE_MEMBER_UNSUPPORTED:${path}:${unmodeled}`);
    expect(cli.exitCode).toBe(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
