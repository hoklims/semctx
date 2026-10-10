import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexHealth, indexRepository, runVerify } from "../src";

for (const content of [
  "export interface Repository { save(): void } export function confirm(repo: Repository) { repo.save(); }",
  "export function confirm(callback: () => void) { callback(); }",
  "export function save() { return 1; } export interface Repository { save(): number } export function confirm(repo: Repository) { return repo.save(); }",
  "export function save() { return 1; } const repository = { save() { return 2; } }; export function confirm() { return repository.save(); }",
  "export function save() { return 1; } const repository = { save: () => 2 }; export function confirm() { return repository.save(); }",
  "export function save() { return 1; } const repository = { save }; export function confirm() { return repository.save(); }",
  "export function save() { return 1; } export function helper() { return 2; } const repository = { save() { return helper(); } }; export {};",
  "export function helper() { return 1; } const repository = { save: (() => helper()) }; export {};",
  "export function helper() { return 1; } const repository = { save: ((() => helper()) as () => number) }; export {};",
]) test(`qualified extracted local call without a modeled coordinate cannot admit: ${content}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-call-coordinate-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/main.ts"), `${content}\n`);
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
    writeFileSync(join(root, "src/main.ts"), `${content}\n\n`);
    indexRepository(root, "2026-10-10T10:00:00.000Z");
    const candidate = indexHealth(root).candidates.find(candidate => candidate.path === "src/main.ts")!;
    const report = runVerify(root, { kind: "working-tree" }).report;
    console.info(JSON.stringify({ case: content, observedAdmission: report.analysisAdmission?.status, reasons: candidate.analysisReasons }));
    expect(report.analysisAdmission?.status).toBe("rejected");
    const cli = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../../apps/cli/src/index.ts"), "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { stdout: "pipe", stderr: "pipe" });
    expect(cli.exitCode).toBe(3);
    expect(candidate.analysisReasons.some(reason => reason.startsWith("QUALIFIED_CALL_COORDINATE_CALLEE_MISSING:") || reason.startsWith("QUALIFIED_CALL_COORDINATE_CALLEE_UNMODELED:") || reason.startsWith("QUALIFIED_CALL_COORDINATE_CALLER_UNMODELED:"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
