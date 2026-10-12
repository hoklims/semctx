import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexHealth, indexRepository, runVerify } from "../src";

for (const [path, content, include, expected] of [
  ["migrations/step.ts", "export function step() { return 1; }", ["**/*"], "MIGRATION_SOURCE_UNSUPPORTED"],
  ["migrations/step.tsx", "export function step() { return 1; }", ["**/*"], "MIGRATION_SOURCE_UNSUPPORTED"],
  ["migrations/step.ts", "export function step() { return 1; }", ["src/**/*"], "MIGRATION_SOURCE_UNSUPPORTED"],
  ["src/view.tsx", "export const view = <div/>;", ["**/*"], "AUTOMATIC_JSX_RUNTIME_UNSUPPORTED"],
  ["hidden.jsx", "export const view = <div/>;", ["src/**/*"], "AUTOMATIC_JSX_RUNTIME_UNSUPPORTED"],
] as const) test(`qualified scope refuses unmodeled ${path} with ${include.join(",")}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-qualified-mode-"));
  try {
    mkdirSync(join(root, "src")); mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    writeFileSync(join(root, path), content);
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { jsx: "react-jsx", jsxImportSource: "@fixture/runtime" } }));
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: [...include], languages: { typescript: "on", javascript: "on" } });
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
    indexRepository(root, "2026-10-10T10:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    console.info(JSON.stringify({ path, observed: report.analysisAdmission?.status }));
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.reasons.some(reason => reason.includes(expected))).toBe(true);
    if (include[0] === "**/*" && path.startsWith("migrations")) expect(indexHealth(root).candidates.find(candidate => candidate.path === path)?.analysisReasons).toContain("SOURCE_MIGRATION_SOURCE_UNSUPPORTED");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
