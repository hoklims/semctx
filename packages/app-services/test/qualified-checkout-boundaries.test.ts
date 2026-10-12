import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";
function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}
test("selected changed Python remains outside qualified TS/JS closure despite an excluded Python importer", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-qualified-python-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/core.py"), "def core():\n    return 1\n");
    writeFileSync(join(root, "hidden.py"), "from src.core import core\ndef hidden():\n    return core()\n");
    git(root, "init", "-q"); git(root, "add", "."); git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { python: "on" } });
    writeFileSync(join(root, "src/core.py"), "def core():\n    return 2\n"); indexRepository(root, "2026-10-10T10:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    console.info(JSON.stringify({ case: "Python", status: report.analysisAdmission?.status, reasons: report.analysisAdmission?.reasons, coverage: report.analysisAdmission?.changeCoverage.files }));
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.changeCoverage.files).toContainEqual(expect.objectContaining({ path: "src/core.py", status: "unsupported", reasons: ["OUTSIDE_BOUNDED_ESM_TYPESCRIPT_PROFILE"] }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
for (const mode of ["skip", "skip-assume", "assume", "sparse"]) test(`qualified working-tree refuses incomplete checkout mode ${mode}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-qualified-checkout-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    mkdirSync(join(root, "hidden"));
    writeFileSync(join(root, "hidden/consumer.ts"), "import { main } from '../src/main'; export function hidden() { return main(); }\n");
    git(root, "init", "-q"); git(root, "add", "."); git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    if (mode === "sparse") { git(root, "sparse-checkout", "init", "--cone"); git(root, "sparse-checkout", "set", "src"); }
    else { if (mode !== "assume") git(root, "update-index", "--skip-worktree", "hidden/consumer.ts"); if (mode === "skip-assume" || mode === "assume") git(root, "update-index", "--assume-unchanged", "hidden/consumer.ts"); }
    rmSync(join(root, "hidden/consumer.ts"), { force: true });
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on" } });
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n"); indexRepository(root, "2026-10-10T10:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    console.info(JSON.stringify({ case: mode, status: report.analysisAdmission?.status, reasons: report.analysisAdmission?.reasons }));
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.reasons.some(reason => reason.includes("SKIP_WORKTREE_UNSUPPORTED") || reason.includes("ASSUME_UNCHANGED_UNSUPPORTED") || reason === "QUALIFIED_SPARSE_CHECKOUT_UNSUPPORTED")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
