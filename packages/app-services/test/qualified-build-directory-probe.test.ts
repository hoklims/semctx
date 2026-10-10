import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDefaultConfig, createGlobSelectionConfig } from "@semantic-context/core";
import { discoverRepository, isPathSelected } from "@semantic-context/ts-analyzer";
import { initWorkspace, loadConfig, openStore } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";
import { captureQualifiedAnalysisInputs, CONTROL_INDEX_SNAPSHOT_META_KEY } from "../src/freshness";

for (const [hidden, content] of [
  ["tooling/build/hidden.ts", "export { main } from '../../src/main';"],
  ["dist/hidden.mjs", "export { main } from '../src/main.ts';"],
]) for (const explicitlyIncluded of [false, true]) {
  test(`tracked ${hidden}, explicit include ${explicitlyIncluded}, cannot disappear from scope`, () => {
    const physicalRoot = mkdtempSync(join(tmpdir(), "semctx-authored-build-scope-"));
    const aliasParent = mkdtempSync(join(tmpdir(), "semctx-build-scope-alias-"));
    const root = join(aliasParent, "checkout");
    symlinkSync(physicalRoot, root, process.platform === "win32" ? "junction" : "dir");
    const git = (...args: string[]): string => {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
      return new TextDecoder().decode(result.stdout).trim();
    };
    try {
      mkdirSync(join(root, "src")); mkdirSync(dirname(join(root, hidden!)), { recursive: true });
      writeFileSync(join(root, ".gitignore"), ".semctx/\n");
      writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
      writeFileSync(join(root, hidden!), content!);
      git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
      const config = { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1" as const, analysisProfile: "modelo-suite-static-v1" as const, include: ["src/**/*.ts", ...(explicitlyIncluded ? [hidden!] : [])], languages: { typescript: "on" as const, javascript: "on" as const } };
      initWorkspace(root, config);
      indexRepository(root, "2026-10-09T10:00:00.000Z");
      writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
      indexRepository(root, "2026-10-09T10:01:00.000Z");
      const report = runVerify(root, { kind: "working-tree" }).report;
      const cli = Bun.spawnSync(["bun", join(import.meta.dir, "../../../apps/cli/src/index.ts"), "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { stdout: "pipe", stderr: "pipe" });
      const discovery = discoverRepository(config);
      expect(git("ls-files", "--", hidden!).length > 0).toBe(true);
      expect(isPathSelected(config, hidden!)).toBe(explicitlyIncluded);
      expect(discovery.candidates).toContainEqual(expect.objectContaining({ relPath: hidden, selectionDecision: explicitlyIncluded ? "selected" : "excluded" }));
      // The index binds the canonical configuration loaded by its workspace, including
      // physical roots such as macOS /private/var and Windows directory junctions.
      const inputs = captureQualifiedAnalysisInputs(loadConfig(root));
      expect(inputs.files).toContainEqual(expect.objectContaining({ path: hidden }));
      const store = openStore(root);
      try { expect(JSON.parse(store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY)!).analysisInputHash).toBe(inputs.digest); }
      finally { store.close(); }
      expect(report.analysisAdmission?.changeCoverage.expected).toContain(hidden!);
      expect(report.analysisAdmission?.status).toBe(explicitlyIncluded ? "admitted" : "rejected");
      expect(cli.exitCode).toBe(explicitlyIncluded ? 0 : 3);
      expect(JSON.parse(new TextDecoder().decode(cli.stdout)).analysisAdmission?.status).toBe(explicitlyIncluded ? "admitted" : "rejected");
      if (explicitlyIncluded) {
        expect(discovery.files.some((file) => file.relPath === hidden)).toBe(true);
        expect(report.analysisAdmission?.changeCoverage.analyzed).toEqual([hidden!, "src/main.ts"].sort());
      }
      else expect(report.analysisAdmission?.changeCoverage.files).toContainEqual(expect.objectContaining({ path: hidden, status: "excluded" }));
      writeFileSync(join(root, hidden!), `${content}\n// drift after indexing\n`);
      const stale = runVerify(root, { kind: "working-tree" }).report;
      expect(stale.analysisAdmission?.status).toBe("rejected");
      expect(stale.analysisAdmission?.indexFreshness.verdict).toBe("STALE");
    } finally {
      rmSync(aliasParent, { recursive: true, force: true });
      rmSync(physicalRoot, { recursive: true, force: true });
    }
  }, 60_000);
}

for (const selected of [false, true]) {
  test(`ignored untracked generated source respects the actual selector: ${selected}`, () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-ignored-build-scope-"));
    try {
      mkdirSync(join(root, "src")); mkdirSync(join(root, "build"));
      writeFileSync(join(root, ".gitignore"), ".semctx/\nbuild/\n");
      writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
      const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
        if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
      };
      git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
      // Unsupported runtime code must not pollute qualification when outside the real selector.
      writeFileSync(join(root, "build/generated.ts"), "export function generated() { return eval('1'); }\n");
      const config = { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1" as const, analysisProfile: "modelo-suite-static-v1" as const, include: ["src/**/*.ts", ...(selected ? ["build/**/*.ts"] : [])] };
      initWorkspace(root, config);
      writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
      indexRepository(root, "2026-10-09T10:00:00.000Z");
      const discovery = discoverRepository(config);
      expect(discovery.candidates).toContainEqual(expect.objectContaining({ relPath: "build/generated.ts", selectionDecision: selected ? "selected" : "excluded", reason: selected ? "SELECTED" : "IGNORED_GENERATED_OUTPUT" }));
      expect(discovery.files.some(file => file.relPath === "build/generated.ts")).toBe(selected);
      const before = captureQualifiedAnalysisInputs(config);
      expect(before.files.some(file => file.path === "build/generated.ts")).toBe(selected);
      expect(before.files.some(file => file.path === ".gitignore")).toBe(true);
      const admission = runVerify(root, { kind: "working-tree" }).report.analysisAdmission;
      expect(admission?.status).toBe(selected ? "rejected" : "admitted");
      if (!selected) expect(admission?.changeCoverage.expected).not.toContain("build/generated.ts");
      writeFileSync(join(root, "build/generated.ts"), "export function generated() { return eval('2'); }\n");
      expect(captureQualifiedAnalysisInputs(config).digest === before.digest).toBe(!selected);
      writeFileSync(join(root, ".gitignore"), ".semctx/\n");
      expect(captureQualifiedAnalysisInputs(config).digest).not.toBe(before.digest);
      expect(runVerify(root, { kind: "working-tree" }).report.analysisAdmission?.status).toBe("rejected");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
}

test("untracked authored outputs remain obligations and legacy profiles retain directory exclusions", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-untracked-build-scope-"));
  try {
    mkdirSync(join(root, "src")); mkdirSync(join(root, "build"));
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    };
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    writeFileSync(join(root, "build/consumer.ts"), "export { main } from '../src/main';\n");
    const config = { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1" as const, analysisProfile: "modelo-suite-static-v1" as const, include: ["src/**/*.ts"] };
    initWorkspace(root, config);
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
    indexRepository(root, "2026-10-09T10:00:00.000Z");
    const admission = runVerify(root, { kind: "working-tree" }).report.analysisAdmission;
    expect(admission?.status).toBe("rejected");
    expect(admission?.changeCoverage.files).toContainEqual(expect.objectContaining({ path: "build/consumer.ts", status: "excluded" }));
    for (const legacy of [createDefaultConfig(root), { ...createGlobSelectionConfig(root), include: ["**/*.ts"] }]) {
      expect(discoverRepository(legacy).candidates.some(candidate => candidate.relPath === "build/consumer.ts")).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test("ignored compiler configuration symlinks are explicitly refused", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-build-config-link-"));
  try {
    mkdirSync(join(root, "build"));
    writeFileSync(join(root, ".gitignore"), ".semctx/\nbuild/**\n");
    writeFileSync(join(root, "build/main.ts"), "export function main() { return 1; }\n");
    writeFileSync(join(root, "compiler-base.json"), '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"}}');
    const result = Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    symlinkSync(join(root, "compiler-base.json"), join(root, "build/tsconfig.json"), "file");
    const config = { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1" as const, analysisProfile: "modelo-suite-static-v1" as const, include: ["build/**/*.ts"] };
    expect(() => captureQualifiedAnalysisInputs(config)).toThrow(expect.objectContaining({ code: "INVALID_TASK_INPUT" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const inherited of [false, true]) test(`ignored build configuration cannot fall back to qualified defaults: inherited ${inherited}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-build-configuration-"));
  try {
    mkdirSync(join(root, "build"));
    writeFileSync(join(root, ".gitignore"), ".semctx/\nbuild/**\n");
    writeFileSync(join(root, "build/main.ts"), "export function main() { return 1; }\n");
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    };
    git("init", "-q"); git("add", ".gitignore"); git("add", "-f", "build/main.ts");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    const unsupported = '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"}}';
    writeFileSync(join(root, "build/tsconfig.json"), inherited ? '{"extends":"./config-base.json"}' : unsupported);
    if (inherited) writeFileSync(join(root, "build/config-base.json"), unsupported);
    writeFileSync(join(root, "build/package.json"), '{"type":"module"}');
    writeFileSync(join(root, "build/cache.json"), '{"generated":true}');
    const config = { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1" as const, analysisProfile: "modelo-suite-static-v1" as const, include: ["build/**/*.ts"] };
    initWorkspace(root, config);
    writeFileSync(join(root, "build/main.ts"), "export function main() { return 2; }\n");
    indexRepository(root, "2026-10-09T10:00:00.000Z");
    const inputs = captureQualifiedAnalysisInputs(config);
    const report = runVerify(root, { kind: "working-tree" }).report;
    const cli = Bun.spawnSync(["bun", join(import.meta.dir, "../../../apps/cli/src/index.ts"), "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { stdout: "pipe", stderr: "pipe" });
    console.info(JSON.stringify({ inherited, captured: inputs.files.map(file => file.path), admission: report.analysisAdmission?.status, cliExit: cli.exitCode }));
    expect(inputs.files.some(file => file.path === "build/tsconfig.json")).toBe(true);
    expect(inputs.files.some(file => file.path === "build/package.json")).toBe(true);
    expect(inputs.files.some(file => file.path === "build/cache.json")).toBe(false);
    if (inherited) expect(inputs.files.some(file => file.path === "build/config-base.json")).toBe(true);
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(cli.exitCode).toBe(3);
    expect(report.analysisAdmission?.reasons.some(reason => reason.endsWith("SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:NodeNext"))).toBe(true);
    if (inherited) {
      rmSync(join(root, "build/config-base.json"));
      indexRepository(root, "2026-10-09T10:01:00.000Z");
      const missing = runVerify(root, { kind: "working-tree" }).report.analysisAdmission;
      expect(missing?.status).toBe("rejected");
      expect(missing?.reasons.some(reason => reason.includes("SOURCE_CONFIGURATION_INVALID"))).toBe(true);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test("ignore and attribute controls inside ignored outputs stay sealed", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-build-ignore-controls-"));
  try {
    mkdirSync(join(root, "src")); mkdirSync(join(root, "build"));
    writeFileSync(join(root, ".gitignore"), ".semctx/\nbuild/\n");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    };
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    writeFileSync(join(root, "build/.gitignore"), "*.ts\n");
    writeFileSync(join(root, "build/.gitattributes"), "*.ts text\n");
    const config = { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1" as const, analysisProfile: "modelo-suite-static-v1" as const, include: ["src/**/*.ts"] };
    initWorkspace(root, config);
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
    indexRepository(root, "2026-10-09T10:00:00.000Z");
    expect(runVerify(root, { kind: "working-tree" }).report.analysisAdmission?.status).toBe("admitted");
    for (const path of ["build/.gitignore", "build/.gitattributes"]) {
      const before = captureQualifiedAnalysisInputs(config);
      expect(before.files.some(file => file.path === path)).toBe(true);
      writeFileSync(join(root, path), "# changed control\n");
      expect(captureQualifiedAnalysisInputs(config).digest).not.toBe(before.digest);
      const stale = runVerify(root, { kind: "working-tree" }).report.analysisAdmission;
      expect(stale?.status).toBe("rejected");
      expect(stale?.indexFreshness.verdict).toBe("STALE");
      indexRepository(root, "2026-10-09T10:01:00.000Z");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
