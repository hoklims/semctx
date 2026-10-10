import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

for (const doc of ["/** @type {import('./src/main.ts').Value} */", "/** @import { Value } from './src/main.ts' */"]) test(`excluded semantic JSDoc dependency rejects qualified closure: ${doc}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-jsdoc-scope-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/main.ts"), "export class Value { value = 1; }\n");
    writeFileSync(join(root, "hidden.mjs"), `${doc}\nexport const hidden = 1;\n`);
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
    writeFileSync(join(root, "src/main.ts"), "export class Value { value = 2; }\n");
    indexRepository(root, "2026-10-10T10:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.reasons.some(reason => reason.includes("JSDOC_IMPORT_UNSUPPORTED"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
