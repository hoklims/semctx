import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, VerifyReportSchema } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

const cases = [
  [
    "Number.call",
    "const value={valueOf:hidden};",
    "Number.call(null,value)"
  ],
  [
    "String.call",
    "const value={toString:hidden};",
    "String.call(null,value)"
  ],
  [
    "Math.max.call",
    "const value={valueOf:hidden};",
    "Math.max.call(null,value,0)"
  ],
  [
    "Array.join.call",
    "const value={toString:hidden};",
    "Array.prototype.join.call([value])"
  ]
] as const;
for (const extension of ["ts", "mjs"]) for (const selected of [true, false]) test(`qualified SDK helper coercion ${extension} selected ${selected} binds the imported helper-only change`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-helper-coercion-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    const hidden = join(root, `src/hidden.${extension}`); writeFileSync(hidden, "export function hidden(){return 1;}\n");
    const subjects = cases.map(([name, setup, call], index) => {
      const path = `${selected ? "src/" : ""}subject-${index}.${extension}`;
      writeFileSync(join(root, path), `import {hidden} from '${selected ? "./" : "./src/"}hidden.${extension}';${setup}export function run(){return ${call};}`);
      return { name, path };
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
    for (const { path } of subjects) expect(report.analysisAdmission?.reasons).toContain(`DEPENDENCY_SCOPE_CONFIGURATION:${path}:SOURCE_COERCION_UNSUPPORTED`);
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
    for (const { path } of subjects) expect(parsed.data.analysisAdmission?.reasons).toContain(`DEPENDENCY_SCOPE_CONFIGURATION:${path}:SOURCE_COERCION_UNSUPPORTED`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);

for (const extension of ["ts", "mjs"]) test(`qualified pristine SDK primitive helpers ${extension} remain admitted`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-helper-primitives-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    const hidden = join(root, `src/hidden.${extension}`); writeFileSync(hidden, "export function hidden(){return 1;}\n");
    const body = "export function number(){return Number.call(null,1);}export function max(){return Math.max.call(null,1,0);}export function text(){return String.call(null,'value');}export function joined(){return Array.prototype.join.call([1,2]);}";
    writeFileSync(join(root, `src/main.${extension}`), `import {hidden} from './hidden.${extension}';${body}`);
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
}, 180_000);
