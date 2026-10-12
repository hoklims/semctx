import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

for (const [name, consumer, testContent] of [
  ["namespace test value", "export function run(){return 1;}", "import * as dep from './dep';export const observed=dep.FLAG;"],
  ["production imported value", "import {FLAG} from './dep';export function run(){return FLAG;}", "import {run} from './consumer';export function check(){return run();}"],
] as const) test(`causal constant change ${name}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-runtime-value-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    const dep = join(root, "src/dep.ts"); writeFileSync(dep, "export const FLAG=true;");
    writeFileSync(join(root, "src/consumer.ts"), consumer); writeFileSync(join(root, "src/consumer.test.ts"), testContent);
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" }); if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"] });
    writeFileSync(dep, "export const FLAG=false;"); indexRepository(root, "2026-10-11T10:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    console.info(JSON.stringify({ name, admission: report.analysisAdmission, recommendedTests: report.recommendedTests }));
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.binding.status).toBe("valid");
    expect(report.analysisAdmission?.changeCoverage.files.some(file => file.reasons.some(reason => /QUALIFIED_(TEST|IMPORT)_BINDING_MISSING:src\/dep.ts:FLAG/.test(reason)))).toBe(true);
    const cli = join(import.meta.dir, "../../../apps/cli/src/index.ts");
    const outcome = Bun.spawnSync([process.execPath, cli, "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    console.info(JSON.stringify({ name, cliExitCode: outcome.exitCode })); expect(outcome.exitCode).toBe(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);

for (const [name, depContent, consumer] of [
  ["unused", "export const FLAG=true;", "import {FLAG} from './dep';export function run(){return 1;}"],
  ["type-only", "export const FLAG=true;", "import type {FLAG} from './dep';export type Mode=typeof FLAG;export function run(){return 1;}"],
  ["modeled namespace", "export function FLAG(){return 1;}", "import * as dep from './dep';export function run(){return dep.FLAG();}"],
] as const) test(`qualified runtime import positive ${name}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-import-positive-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    const dep = join(root, "src/dep.ts"); writeFileSync(dep, depContent);
    writeFileSync(join(root, "src/consumer.ts"), consumer);
    writeFileSync(join(root, "src/consumer.test.ts"), name === "modeled namespace"
      ? "import * as dep from './dep';export function check(){return dep.FLAG();}"
      : "import {run} from './consumer';export function check(){return run();}");
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" }); if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"] });
    writeFileSync(dep, depContent.replace("true", "false").replace("return 1", "return 2")); indexRepository(root, "2026-10-11T10:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    expect(report.analysisAdmission?.status).toBe("admitted");
    if (name === "modeled namespace") expect(report.recommendedTests.some(test => test.file === "src/consumer.test.ts")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);
