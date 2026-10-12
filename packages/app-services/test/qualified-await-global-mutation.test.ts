import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, VerifyReportSchema } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

const cases = [
  [
    "reassigned async",
    "SOURCE_AWAIT_UNSUPPORTED",
    "async function load(){return 1;}load=()=>({then:hidden});export async function run(){await load();return 1;}"
  ],
  [
    "for await thenable",
    "SOURCE_AWAIT_UNSUPPORTED",
    "export async function run(){for await(const item of [{then:hidden}]){}return 1;}"
  ],
  [
    "plural global descriptor",
    "SOURCE_SDK_GLOBAL_MUTATION_UNSUPPORTED",
    "Object.defineProperties(globalThis,{Math:{value:{random:hidden}}});export function run(){return Math.random();}"
  ],
  [
    "reflect global set",
    "SOURCE_SDK_GLOBAL_MUTATION_UNSUPPORTED",
    "Reflect.set(globalThis,'Math',{random:hidden});export function run(){return Math.random();}"
  ],
  [
    "assign global namespace",
    "SOURCE_SDK_GLOBAL_MUTATION_UNSUPPORTED",
    "Object.assign(globalThis,{Math:{random:hidden}});export function run(){return Math.random();}"
  ]
] as const;
const controls = [
  ["unaltered async", "async function load(){return 1;}export async function run(){await load();return 1;}"],
  ["primitive for-await", "export async function run(){for await(const item of [1,2]){}return 1;}"],
  ["local/data mutations", "const globalThis={Math:{random:()=>1}};Object.defineProperties(globalThis,{Math:{value:{random:()=>2}}});Reflect.set(globalThis,'Math',{random:()=>3});Object.assign(globalThis,{Math:{random:()=>4}});export function run(){return 1;}"],
] as const;

for (const extension of ["ts", "mjs"]) for (const [name, reason, body] of [...cases, ...controls.map(([name, body]) => [name, undefined, body] as const)]) {
  test(`qualified ${name} ${extension} binds hidden-only edit and its intended reason`, () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-await-global-"));
    try {
      mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
      const hidden = join(root, `src/hidden.${extension}`);
      writeFileSync(hidden, "export function hidden(){return 1;}\n");
      writeFileSync(join(root, `src/main.${extension}`), `import {hidden} from './hidden.${extension}';${body}`);
      for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
        const child = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
        if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
      }
      initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
      writeFileSync(hidden, "export function hidden(){return 2;}\n");
      indexRepository(root, "2026-10-12T08:00:00.000Z");
      const report = runVerify(root, { kind: "working-tree" }).report;
      console.info(JSON.stringify({ name, extension, report }));
      expect(VerifyReportSchema.safeParse(report).success).toBe(true);
      expect(report.analysisAdmission?.binding.status).toBe("valid");
      expect(report.analysisAdmission?.indexFreshness.verdict).toBe("DIRTY_KNOWN");
      expect(report.analysisAdmission?.checkFreshness.status).toBe("current");
      expect(report.analysisAdmission?.changeCoverage.analyzed).toContain(`src/hidden.${extension}`);
      if (reason === undefined) {
        expect(report.analysisAdmission?.status).toBe("admitted");
      } else {
        expect(report.analysisAdmission?.reasons).toContain(`DEPENDENCY_SCOPE_CONFIGURATION:src/main.${extension}:${reason}`);
        expect(report.analysisAdmission?.status).toBe("rejected");
        expect(report.verdict).toBe("BLOCK");
        const cli = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../../apps/cli/src/index.ts"), "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { cwd: root, stdout: "pipe", stderr: "pipe" });
        const stdout = new TextDecoder().decode(cli.stdout); const stderr = new TextDecoder().decode(cli.stderr);
        console.info(JSON.stringify({ name, extension, cli: { exitCode: cli.exitCode, stdout, stderr } }));
        expect(cli.exitCode).toBe(3);
        const parsed = VerifyReportSchema.safeParse(JSON.parse(stdout));
        expect(parsed.success).toBe(true);
        if (!parsed.success) throw new Error("invalid CLI report");
        expect(parsed.data.verdict).toBe("BLOCK");
        expect(parsed.data.analysisAdmission?.status).toBe("rejected");
        expect(parsed.data.analysisAdmission?.binding.status).toBe("valid");
        expect(parsed.data.analysisAdmission?.indexFreshness.verdict).toBe("DIRTY_KNOWN");
        expect(parsed.data.analysisAdmission?.checkFreshness.status).toBe("current");
        expect(parsed.data.analysisAdmission?.changeCoverage.analyzed).toContain(`src/hidden.${extension}`);
        expect(parsed.data.analysisAdmission?.reasons).toContain(`DEPENDENCY_SCOPE_CONFIGURATION:src/main.${extension}:${reason}`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 180_000);
}
