import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, VerifyReportSchema } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

for (const extension of ["ts", "mjs"]) for (const selected of [true, false]) test(`qualified callee binding origins ${extension} selected ${selected} reject a hidden-only edit for the intended reasons`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-callee-bindings-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "package.json"), '{"dependencies":{"opaque":"1.0.0"}}');
    const hidden = join(root, `src/hidden.${extension}`); writeFileSync(hidden, "export function hidden(){return 1;}\n");
    const bodies: [string, string, string][] = [
      ["async identifier loop", "async function load(){return 1;}export async function run(){for(load of [()=>({then:hidden})]){}await load();return 1;}", "SOURCE_AWAIT_UNSUPPORTED"],
      ["async destructuring loop", "async function load(){return 1;}export async function run(){for([load] of [[()=>({then:hidden})]]){}await load();return 1;}", "SOURCE_AWAIT_UNSUPPORTED"],
      ["opaque primitive-return loop", "import {write} from 'opaque';function value(){return 1;}export function run(){for(value of [()=>hidden]){}return write(value());}", "SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"],
    ];
    if (extension === "ts") bodies.push(["SDK-shaped local member", "const env:typeof globalThis={parseInt:hidden} as unknown as typeof globalThis;export function run(){return env.parseInt('1');}", "SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED"]);
    const subjects = bodies.map(([name, body, reason], index) => {
      const path = `${selected ? "src/" : ""}subject-${index}.${extension}`;
      writeFileSync(join(root, path), `import {hidden} from '${selected ? "./" : "./src/"}hidden.${extension}';${body}`);
      return { name, path, reason };
    });
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const child = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
    writeFileSync(hidden, "export function hidden(){return 2;}\n"); indexRepository(root, "2026-10-12T09:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    console.info(JSON.stringify({ extension, selected, subjects, report }));
    expect(VerifyReportSchema.safeParse(report).success).toBe(true);
    expect(report.analysisAdmission?.binding.status).toBe("valid");
    expect(report.analysisAdmission?.indexFreshness.verdict).toBe("DIRTY_KNOWN");
    expect(report.analysisAdmission?.checkFreshness.status).toBe("current");
    expect(report.analysisAdmission?.changeCoverage.analyzed).toContain(`src/hidden.${extension}`);
    for (const { path, reason } of subjects) expect(report.analysisAdmission?.reasons).toContain(`DEPENDENCY_SCOPE_CONFIGURATION:${path}:${reason}`);
    expect(report.analysisAdmission?.status).toBe("rejected"); expect(report.verdict).toBe("BLOCK");
    const cli = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../../apps/cli/src/index.ts"), "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const stdout = new TextDecoder().decode(cli.stdout); const stderr = new TextDecoder().decode(cli.stderr);
    console.info(JSON.stringify({ extension, selected, cli: { exitCode: cli.exitCode, stdout, stderr } }));
    expect(cli.exitCode).toBe(3);
    const parsed = VerifyReportSchema.safeParse(JSON.parse(stdout)); expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("invalid CLI report");
    expect(parsed.data.verdict).toBe("BLOCK"); expect(parsed.data.analysisAdmission?.status).toBe("rejected");
    expect(parsed.data.analysisAdmission?.binding.status).toBe("valid");
    expect(parsed.data.analysisAdmission?.checkFreshness.status).toBe("current");
    for (const { path, reason } of subjects) expect(parsed.data.analysisAdmission?.reasons).toContain(`DEPENDENCY_SCOPE_CONFIGURATION:${path}:${reason}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const extension of ["ts", "mjs"]) test(`qualified pristine and retained own member plus unwritten loop controls ${extension} remain admitted`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-callee-binding-controls-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    const hidden = join(root, `src/hidden.${extension}`); writeFileSync(hidden, "export function hidden(){return 1;}\n");
    writeFileSync(join(root, `src/main.${extension}`), `import * as env from './hidden.${extension}';export function own(){return env.hidden('1');}export function sdk(){return globalThis.parseInt('1');}async function load(){return 1;}export async function run(){for(const load of [1]){}await load();return 1;}`);
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const child = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
    writeFileSync(hidden, "export function hidden(){return 2;}\n"); indexRepository(root, "2026-10-12T09:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report; console.info(JSON.stringify({ extension, control: true, report }));
    expect(VerifyReportSchema.safeParse(report).success).toBe(true); expect(report.analysisAdmission?.binding.status).toBe("valid");
    expect(report.analysisAdmission?.checkFreshness.status).toBe("current"); expect(report.analysisAdmission?.changeCoverage.analyzed).toContain(`src/hidden.${extension}`);
    expect(report.analysisAdmission?.status).toBe("admitted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
