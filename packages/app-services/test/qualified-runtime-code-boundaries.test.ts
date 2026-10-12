import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

for (const [name, body, changedName, reason] of [
  ["wasm start", "import {helper} from './helper.EXT';const bytes=new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,2,12,1,3,101,110,118,4,104,111,111,107,0,0,8,1,0]);export function run(){return WebAssembly.instantiate(bytes,{env:{hook:helper}});}", "helper", "SOURCE_WASM_INSTANTIATION_UNSUPPORTED"],
  ["script insertion", "export function run(){const script=document.createElement('script');script.src='./hidden.EXT';document.head.append(script);}", "hidden", "SOURCE_SCRIPT_INSERTION_UNSUPPORTED"],
] as const) for (const extension of ["ts", "mjs"]) for (const selection of ["selected", "excluded"]) test(`qualified ${name} ${extension} ${selection} rejects a hidden source change`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-runtime-code-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    const changed = join(root, `src/${changedName}.${extension}`);
    writeFileSync(changed, "export function helper(){return 1;}");
    writeFileSync(join(root, `src/consumer.${extension}`), body.replaceAll("EXT", extension));
    writeFileSync(join(root, `src/consumer.test.${extension}`), `import {run} from './consumer.${extension}';export function check(){return run();}`);
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw Error(new TextDecoder().decode(result.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: selection === "selected" ? ["src/**/*"] : [`src/${changedName}.${extension}`], languages: { typescript: "on", javascript: "on" } });
    writeFileSync(changed, "export function helper(){return 2;}");
    indexRepository(root, "2026-10-12T00:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    console.info(JSON.stringify({ name, extension, selection, admission: report.analysisAdmission, recommendedTests: report.recommendedTests }));
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.binding.status).toBe("valid");
    expect([...report.analysisAdmission?.reasons ?? [], ...report.analysisAdmission?.changeCoverage.files.flatMap(file => file.reasons) ?? []].some(item => item.includes(reason))).toBe(true);
    const cli = join(import.meta.dir, "../../../apps/cli/src/index.ts");
    const result = Bun.spawnSync([process.execPath, cli, "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);
