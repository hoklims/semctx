import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

for (const extension of ["ts", "mjs"]) for (const selected of [true, false]) test(`qualified data navigation ${extension} selected ${selected} refuses hidden execution`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-inert-navigation-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, `src/hidden.${extension}`), "export function hidden(){return 1;}");
    writeFileSync(join(root, `src/consumer.${extension}`),
      `export function run(){location.href="data:text/html,<script type='module'>import('./hidden.${extension}')</script>";}`);
    writeFileSync(join(root, `src/consumer.test.${extension}`), `import {run} from './consumer.${extension}';export function check(){return run();}`);
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw Error(new TextDecoder().decode(result.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: selected ? ["src/**/*"] : [`src/hidden.${extension}`], languages: { typescript: "on", javascript: "on" } });
    writeFileSync(join(root, `src/hidden.${extension}`), "export function hidden(){return 2;}");
    indexRepository(root, "2026-10-12T00:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.binding.status).toBe("valid");
    expect([...report.analysisAdmission?.reasons ?? [], ...report.analysisAdmission?.changeCoverage.files.flatMap(file => file.reasons) ?? []].some(reason => reason.includes("SCRIPT_NAVIGATION_UNSUPPORTED"))).toBe(true);
    const cli = join(import.meta.dir, "../../../apps/cli/src/index.ts");
    const result = Bun.spawnSync([process.execPath, cli, "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);
