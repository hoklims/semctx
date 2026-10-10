import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexHealth, indexRepository, runVerify } from "../src";

for (const [expression, selected] of [["(flag ? helper : fallback)()", true], ["(flag ? helper : fallback)()", false], ["(() => helper())()", true], ["(0, helper)()", true]] as const) test(`qualified TS refuses unmodeled call ${expression}, selected ${selected}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-call-shape-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    const path = selected ? "src/caller.ts" : "hidden.ts";
    writeFileSync(join(root, path), `export function helper() { return 1; } function fallback() { return 2; } export function caller(flag: boolean) { return ${expression}; }\n`);
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on" } });
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
    indexRepository(root, "2026-10-10T10:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    console.info(JSON.stringify({ path, observed: report.analysisAdmission?.status, reasons: report.analysisAdmission?.reasons }));
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.reasons.some(reason => reason.includes("SOURCE_DYNAMIC_CALL_UNSUPPORTED"))).toBe(true);
    if (selected) expect(indexHealth(root).candidates.find(candidate => candidate.path === path)?.analysisOutcome).not.toBe("analyzed");
    const cli = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../../apps/cli/src/index.ts"), "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { stdout: "pipe", stderr: "pipe" });
    expect(cli.exitCode).toBe(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
