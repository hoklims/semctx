import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

for (const [name, body, changedName, reason] of [
  ["Date valueOf", "import {helper} from './helper.EXT';const value={valueOf:helper};export function run(){return new Date(value);}", "helper", "SOURCE_COERCION_UNSUPPORTED"],
  ["cluster executable", "import cluster from 'node:cluster';export function run(){cluster.setupPrimary({exec:'./src/hidden.EXT'});return cluster.fork();}", "hidden", "SOURCE_PROCESS_LAUNCH_UNSUPPORTED"],
  ["document.write", "export function run(){document.write('<script src=\"./hidden.EXT\"></script>');}", "hidden", "SOURCE_DOCUMENT_WRITE_UNSUPPORTED"],
  ["document.writeln", "export function run(){document.writeln('<script src=\"./hidden.EXT\"></script>');}", "hidden", "SOURCE_DOCUMENT_WRITE_UNSUPPORTED"],
] as const) for (const extension of ["ts", "mjs"]) for (const selection of ["selected", "excluded"]) test(`qualified ${name} ${extension} ${selection} rejects a hidden source change`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-date-cluster-write-"));
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
