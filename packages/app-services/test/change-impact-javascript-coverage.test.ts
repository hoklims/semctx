import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runChangeImpact } from "../src";

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
