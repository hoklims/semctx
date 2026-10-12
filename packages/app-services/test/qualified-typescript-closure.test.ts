import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(new TextDecoder().decode(result.stderr));
}
function fixture(hidden?: string, inheritedModule?: string, inheritedResolution = inheritedModule) {
  const root = mkdtempSync(join(tmpdir(), "semctx-ts-qualified-")); roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
  if (hidden) writeFileSync(join(root, "hidden.ts"), hidden);
  if (inheritedModule) {
    writeFileSync(join(root, "base.json"), JSON.stringify({ compilerOptions: { module: inheritedModule, moduleResolution: inheritedResolution } }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ extends: "./base.json" }));
  }
  git(root, "init", "-q"); git(root, "add", ".");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture");
  initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", include: ["src/**/*.ts"], analysisProfile: "modelo-suite-static-v1" });
  writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
  indexRepository(root, "2026-10-09T10:01:00.000Z");
  return root;
}
test("qualified profile retains its explicitly inherited ESNext/Bundler configuration", () => {
  const root = fixture(undefined, "ESNext", "Bundler");
  expect(runVerify(root, { kind: "working-tree" }).report.analysisAdmission?.status).toBe("admitted");
  expect(verifyExit(root)).toBe(0);
});
function verifyExit(root: string) {
  return Bun.spawnSync(["bun", join(import.meta.dir, "../../../apps/cli/src/index.ts"), "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { stdout: "pipe", stderr: "pipe" }).exitCode;
}
for (const hidden of ["export { main } from './src/main';\n", "export async function load() { return import('./src/main'); }\n"]) {
  test(`qualified TS-only scope refuses excluded static dependent: ${hidden.trim()}`, () => {
    const root = fixture(hidden);
    const computation = runVerify(root, { kind: "working-tree" });
    const actualExit = verifyExit(root);
    expect({ admission: computation.report.analysisAdmission?.status, verdict: computation.result.verdict, exitCode: actualExit }).toEqual({ admission: "rejected", verdict: "BLOCK", exitCode: 3 });
    expect(computation.report.analysisAdmission?.changeCoverage.files).toContainEqual(expect.objectContaining({ path: "hidden.ts", status: "excluded" }));
  });
}
for (const module of ["NodeNext", "Node16"]) {
  test(`qualified profile refuses inherited ${module} rather than reinterpreting it`, () => {
    const root = fixture(undefined, module);
    const computation = runVerify(root, { kind: "working-tree" });
    const actualExit = verifyExit(root);
    expect({ admission: computation.report.analysisAdmission?.status, verdict: computation.result.verdict, exitCode: actualExit }).toEqual({ admission: "rejected", verdict: "BLOCK", exitCode: 3 });
    for (const code of ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED", "SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED"]) {
      expect(computation.report.analysisAdmission?.reasons.some(reason => reason.endsWith(`${code}:${module}`))).toBe(true);
    }
  });
}
