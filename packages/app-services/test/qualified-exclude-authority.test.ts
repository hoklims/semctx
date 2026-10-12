import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace, loadConfig } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";
import { captureQualifiedAnalysisInputs } from "../src/freshness";

for (const authority of ["info/exclude", "core.excludesFile"]) test(`retained untracked source hidden by ${authority}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-exclude-authority-"));
  const git = (...args: string[]): string => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout);
  };
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    if (authority === "info/exclude") writeFileSync(join(root, ".git/info/exclude"), "src/new.ts\n");
    else { const path = join(root, ".git/owned-excludes"); writeFileSync(path, "src/new.ts\n"); git("config", "--local", "core.excludesFile", path); }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"] });
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
    writeFileSync(join(root, "src/new.ts"), "export function added() { return 1; }\n");
    expect(git("ls-files", "--others", "--exclude-standard", "-z")).not.toContain("src/new.ts");
    expect(captureQualifiedAnalysisInputs(loadConfig(root)).files.some(file => file.path === "src/new.ts")).toBe(true);
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const admission = runVerify(root, { kind: "working-tree" }).report.analysisAdmission;
    console.info(JSON.stringify({ authority, admission }));
    expect(admission?.status).toBe("rejected");
    expect(admission?.reasons).toContain("QUALIFIED_WORKING_TREE_UNTRACKED_INPUT:src/new.ts");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);
