import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

const cases = [
  ["cached generator", "export function* values(){yield 1;}", "export function* values(){yield 2;}", "import {values} from './dep';const iterator=values();export function run(){return iterator.next().value;}", "import {run} from './consumer';export const observed=run();"],
  ["borrowed RegExp", "export const matcher={exec(){return null;}};", "export const matcher={exec(){return undefined;}};", "import {matcher} from './dep';export function run(){return RegExp.prototype[Symbol.match].call(matcher as RegExp,'x');}", "import {run} from './consumer';export const observed=run();"],
  ["constant test binding", "export const SECURITY_MODE=true;", "export const SECURITY_MODE=false;", "export function run(){return 1;}", "import {SECURITY_MODE} from './dep';export const observed=SECURITY_MODE;"],
  ["excluded cached generator", "export function* values(){yield 1;}", "export function* values(){yield 1;}", "import {values} from '../dep';const iterator=values();export function run(){return iterator.next().value;}", "import {run} from './consumer';export const observed=run();"],
] as const;
for (const [name, before, after, consumer, testContent] of cases) test(`qualified causal change ${name}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-resumption-binding-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    const dep = join(root, name === "excluded cached generator" ? "dep.ts" : "src/dep.ts"); writeFileSync(dep, before);
    if (name === "excluded cached generator") writeFileSync(join(root, "src/changed.ts"), "export function changed(){return 1;}");
    writeFileSync(join(root, "src/consumer.ts"), consumer); writeFileSync(join(root, "src/consumer.test.ts"), testContent);
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" }); if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"] });
    if (name === "excluded cached generator") writeFileSync(join(root, "src/changed.ts"), "export function changed(){return 2;}");
    else writeFileSync(dep, after);
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    console.info(JSON.stringify({ name, admission: report.analysisAdmission, recommendedTests: report.recommendedTests }));
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.binding.status).toBe("valid");
    if (name.includes("cached generator")) expect(report.analysisAdmission?.reasons.some(reason => reason.includes("ITERATION_UNSUPPORTED"))).toBe(true);
    if (name === "borrowed RegExp") expect(report.analysisAdmission?.reasons.some(reason => reason.includes("consumer.ts:SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"))).toBe(true);
    if (name === "constant test binding") expect(report.analysisAdmission?.changeCoverage.files.some(file => file.reasons.some(reason => reason.includes("QUALIFIED_TEST_BINDING_MISSING:src/dep.ts:SECURITY_MODE")))).toBe(true);
    const cli = join(import.meta.dir, "../../../apps/cli/src/index.ts");
    const outcome = Bun.spawnSync([process.execPath, cli, "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    console.info(JSON.stringify({ name, cliExitCode: outcome.exitCode }));
    expect(outcome.exitCode).toBe(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);
