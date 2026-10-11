import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository } from "@semantic-context/app-services";
import { typeScriptLibraryDirectory } from "@semantic-context/ts-analyzer";
import { assertQualifiedReportOutput } from "../src/commands/verify";

const cli = join(import.meta.dir, "../src/index.ts");
function fixture(): { parent: string; root: string } {
  const parent = mkdtempSync(join(tmpdir(), "semctx-qualified-output-")); const root = join(parent, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".semctx/\nreport.json\n");
  writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  }
  initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
  writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
  return { parent, root };
}
test("qualified output cannot overwrite workspace configuration", () => {
  const { parent, root } = fixture();
  try {
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const output = join(root, ".semctx/config.json");
    const original = readFileSync(output, "utf8");
    const result = Bun.spawnSync([process.execPath, cli, "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none", "--output", output], { cwd: root, stdout: "pipe", stderr: "pipe" });
    console.info(JSON.stringify({ exitCode: result.exitCode, changed: readFileSync(output, "utf8") !== original }));
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(output, "utf8")).toBe(original);
  } finally { rmSync(parent, { recursive: true, force: true }); }
}, 60_000);
for (const destination of ["state", "git"] as const) test(`qualified output protects ${destination} control paths`, () => {
  const { parent, root } = fixture();
  try {
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const output = destination === "state" ? join(root, ".semctx/verification-state.json") : join(root, ".git/round18-report.json");
    expect(existsSync(output)).toBe(false);
    const result = Bun.spawnSync([process.execPath, cli, "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none", "--output", output], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
}, 60_000);
test("qualified SDK output decision refuses before any writer is invoked", () => {
  const { parent, root } = fixture();
  try {
    expect(() => assertQualifiedReportOutput(root, join(typeScriptLibraryDirectory(), "round18-report.json"))).toThrow("cannot change SDK inputs");
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
test("qualified output protects external worktree and common Git directories", () => {
  const { parent, root } = fixture(); const linkedRoot = join(parent, "linked");
  try {
    expect(Bun.spawnSync(["git", "worktree", "add", "--detach", linkedRoot, "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    initWorkspace(linkedRoot, { ...createGlobSelectionConfig(linkedRoot), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
    writeFileSync(join(linkedRoot, "src/main.ts"), "export function main() { return 2; }\n");
    indexRepository(linkedRoot, "2026-10-11T10:00:00.000Z");
    for (const args of [["--absolute-git-dir"], ["--path-format=absolute", "--git-common-dir"]]) {
      const gitDir = new TextDecoder().decode(Bun.spawnSync(["git", "rev-parse", ...args], { cwd: linkedRoot, stdout: "pipe" }).stdout).trim();
      const output = join(gitDir, "round18-report.json");
      const result = Bun.spawnSync([process.execPath, cli, "verify", "diff", "--root", linkedRoot, "--format", "json", "--fail-on", "none", "--output", output], { cwd: linkedRoot, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(result.stderr)).toContain("cannot change Git control inputs");
      expect(existsSync(output)).toBe(false);
    }
  } finally { rmSync(parent, { recursive: true, force: true }); }
}, 60_000);
for (const control of ["reports", "dependency"] as const) test(`qualified ${control} junction preserves its outside fixture`, () => {
  const { parent, root } = fixture(); const outside = join(parent, "outside");
  const linked = join(root, control === "reports" ? ".semctx/reports" : "node_modules");
  try {
    mkdirSync(outside); writeFileSync(join(outside, "sentinel.json"), "unchanged");
    symlinkSync(outside, linked, "junction"); indexRepository(root, "2026-10-11T10:00:00.000Z");
    const output = control === "reports" ? join(linked, "sentinel.json") : join(outside, "sentinel.json");
    const result = Bun.spawnSync([process.execPath, cli, "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none", "--output", output], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(outside, "sentinel.json"), "utf8")).toBe("unchanged");
  } finally { if (existsSync(linked)) unlinkSync(linked); rmSync(parent, { recursive: true, force: true }); }
}, 60_000);
for (const existing of [false, true]) test(`qualified output cannot ${existing ? "replace" : "create"} a retained input`, () => {
  const { parent, root } = fixture();
  try {
    const output = join(root, "report.json"); const original = '{"sentinel":true}\n';
    if (existing) writeFileSync(output, original);
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const result = Bun.spawnSync([process.execPath, cli, "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none", "--output", output], { cwd: root, stdout: "pipe", stderr: "pipe" });
    console.info(JSON.stringify({ existing, exitCode: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) }));
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain("qualified report output cannot change repository inputs");
    if (existing) expect(readFileSync(output, "utf8")).toBe(original);
    else expect(existsSync(output)).toBe(false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
}, 60_000);

test("qualified prospective output through a checkout alias is still a retained input", () => {
  const { parent, root } = fixture(); const alias = join(parent, "alias");
  try {
    symlinkSync(parent, alias, "junction"); indexRepository(root, "2026-10-11T10:00:00.000Z");
    const output = join(root, "report.json");
    const result = Bun.spawnSync([process.execPath, cli, "verify", "diff", "--root", join(alias, "repo"), "--format", "json", "--fail-on", "none", "--output", output], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain("qualified report output cannot change repository inputs");
    expect(existsSync(output)).toBe(false);
  } finally { if (existsSync(alias)) unlinkSync(alias); rmSync(parent, { recursive: true, force: true }); }
}, 60_000);
for (const location of ["internal", "outside"] as const) test(`qualified output ${location} preserves report publication`, () => {
  const { parent, root } = fixture();
  try {
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const output = location === "internal" ? join(root, ".semctx/reports/verify.json") : join(parent, "verify.json");
    const result = Bun.spawnSync([process.execPath, cli, "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none", "--output", output], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8")).analysisAdmission.status).toBe("admitted");
  } finally { rmSync(parent, { recursive: true, force: true }); }
}, 60_000);
