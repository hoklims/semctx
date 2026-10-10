import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runChangeImpact } from "../src";
for (const mode of ["directory", "sibling", "substitution"]) test(`a namespace consumer observes newly exported values with resolution: ${mode}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-impact-jsx-"));
  const git = (...args: string[]): void => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    mkdirSync(join(root, "src/widget"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/widget/index.jsx"), "export const existing = 1;\n");
    if (mode !== "directory") {
      writeFileSync(join(root, "src/widget/index.ts"), "export const decoy = 1;\n");
      writeFileSync(join(root, "src/widget.js"), "export const existing = 1;\n");
    }
    if (mode === "substitution") writeFileSync(join(root, "src/widget.ts"), "export const existing = 1;\n");
    writeFileSync(join(root, "src/consumer.mjs"), `import * as ns from './widget${mode === "substitution" ? ".js" : ""}'; ${mode === "substitution" ? "import './widget.ts';" : ""} export function read(key) { return ns[key]; }\n`);
    git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), include: ["src/**/*"], languages: { javascript: "on", typescript: "on" } });
    indexRepository(root, "2026-10-09T10:00:00.000Z");
    writeFileSync(join(root, mode === "substitution" ? "src/widget.ts" : mode === "sibling" ? "src/widget.js" : "src/widget/index.jsx"), "export const existing = 1;\nexport const added = 2;\n");
    const report = runChangeImpact(root, { kind: "working-tree" });
    expect(report.analysis.binding.status).toBe("bound");
    expect(report.changes.units?.some(unit => unit.behavioral)).toBe(true);
    expect(report.possiblyAffected?.some(target => target.file === "src/consumer.mjs")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
for (const language of ["typescript", "javascript"] as const) for (const selected of [true, false]) test(`round3 ledger-only ${language} escaped importer contributes an impact gap only when selected: ${selected}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-impact-ledger-"));
  const git = (...args: string[]): void => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    const consumerPath = `src/consumer.${language === "javascript" ? "js" : "ts"}`;
    writeFileSync(join(root, consumerPath), "import { main } from './main'; import { outside } from '../../outside'; export function consumer() { return main() + outside; }\n");
    git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), include: selected ? ["src/**/*.ts", "src/**/*.js"] : ["src/main.ts"], languages: { typescript: "on", javascript: "on" } });
    indexRepository(root, "2026-10-09T10:00:00.000Z");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
    indexRepository(root, "2026-10-09T10:01:00.000Z");
    const report = runChangeImpact(root, { kind: "working-tree" });
    expect(report.analysis.binding.status).toBe("bound");
    if (selected) {
      expect(report.unresolved).toContainEqual(expect.objectContaining({ code: `${language.toUpperCase()}_ANALYSIS_INCOMPLETE`, file: consumerPath, affects: "reach" }));
      expect(report.analysis.confidence.level).toBe("low");
    } else expect(report.unresolved.some(gap => gap.code === "TYPESCRIPT_ANALYSIS_INCOMPLETE")).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test("failed v2 TypeScript facts cannot produce analyzed coverage or change units", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-impact-ts-failed-"));
  const git = (...args: string[]): void => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/value.ts"), "export function broken( {\n");
    git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), include: ["src/**/*.ts"], languages: { typescript: "on" } });
    indexRepository(root, "2026-10-09T10:00:00.000Z");
    writeFileSync(join(root, "src/value.ts"), "export function broken( { // changed\n");
    indexRepository(root, "2026-10-09T10:01:00.000Z");
    const report = runChangeImpact(root, { kind: "working-tree" });
    expect(report.analysis.binding.status).toBe("bound");
    expect(report.changes.files[0]?.coverage).toMatchObject({ status: "not_analyzed", reason: "ANALYSIS_FAILED" });
    expect(report.changes.units).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

for (const [name, before, after, analyzed] of [
  ["esm", "export function value() { return 1; }", "export function value() { return 2; }", true],
  ["commonjs", "export function value() { return 1; } module.exports = value;", "export function value() { return 2; } module.exports = value;", false],
  ["parse-failed", "export function broken( {", "export function broken( { // changed", false],
] as const) test(`per-file impact coverage reflects actual indexed JavaScript ${name} outcome`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-impact-js-coverage-"));
  const git = (...args: string[]): void => {
    const process = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (process.exitCode !== 0) throw new Error(new TextDecoder().decode(process.stderr));
  };
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/value.mjs"), before);
    git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), include: ["src/**/*.mjs"], languages: { javascript: "on" } });
    indexRepository(root, "2026-10-09T10:00:00.000Z");
    writeFileSync(join(root, "src/value.mjs"), after);
    indexRepository(root, "2026-10-09T10:01:00.000Z");
    const report = runChangeImpact(root, { kind: "working-tree" });
    expect(report.analysis.binding.status).toBe("bound");
    expect(report.changes.files.find((file) => file.path === "src/value.mjs")?.coverage?.status).toBe(analyzed ? "analyzed" : "not_analyzed");
    expect(report.analysis.fileCoverage?.analyzed).toBe(analyzed ? 1 : 0);
    if (!analyzed) expect(report.changes.units).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

for (const changed of ["src/base.ts", "src/bridge.mjs"]) test(`mixed-language impact follows actual call edges from ${changed}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-mixed-impact-"));
  const git = (...args: string[]): void => {
    const process = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (process.exitCode !== 0) throw new Error(new TextDecoder().decode(process.stderr));
  };
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    const files = {
      "src/base.ts": "export function base() { return 1; }\n",
      "src/bridge.mjs": "import { base } from './base.ts'; export function bridge() { return base() + 1; }\n",
      "src/entry.ts": "import { bridge } from './bridge.mjs'; export function entry() { return bridge(); }\n",
    };
    for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
    git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), include: ["src/**/*.ts", "src/**/*.mjs"], languages: { javascript: "on", typescript: "on" } });
    indexRepository(root, "2026-10-09T10:00:00.000Z");
    writeFileSync(join(root, changed), files[changed as keyof typeof files].replace("1", "2"));
    indexRepository(root, "2026-10-09T10:01:00.000Z");
    const report = runChangeImpact(root, { kind: "working-tree" });
    expect(report.analysis.binding.status).toBe("bound");
    expect(report.changes.files.find((file) => file.path === changed)?.coverage?.status).toBe("analyzed");
    expect([...(report.directlyAffected ?? []), ...(report.transitivelyAffected ?? [])].some((target) => target.name === "entry")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
