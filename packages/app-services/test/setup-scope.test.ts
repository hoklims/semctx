import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { configPath, initWorkspace } from "@semantic-context/repository-store";
import { discoverRepository, type DiscoveryCandidate } from "@semantic-context/ts-analyzer";
import { planSetupRepository, setupRepository } from "../src/setup";
import { projectSetupScope, SETUP_SCOPE_LIMITS } from "../src/setup-scope";

const roots: string[] = [];
const paths = ["apps/host/src/index.ts", "domains/sample/api/src/index.ts", "domains/sample/web/src/index.ts", "platform/shared/src/index.ts"];
function fixture(files = paths): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-scope-"));
  roots.push(root);
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "export const value = 1;\n");
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["apps/*", "domains/*/api", "domains/*/web", "platform/*"], scripts: { prepare: "throw never run" } }));
  return root;
}
function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
    const file = join(entry.parentPath, entry.name);
    return [file, readFileSync(file).toString("base64")];
  }));
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + "\\") && !resolve(root).startsWith(resolve(tmpdir()) + "/")) throw new Error("fixture outside temp root");
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup plan exposes the four observed roots without broadening selection or writing", () => {
  const root = fixture();
  const before = snapshot(root);
  const plan = planSetupRepository(root, { polyglot: true });
  expect(plan.kind).toBe("setup_plan");
  if (plan.kind !== "setup_plan") throw new Error("unexpected refusal");
  expect(plan.selection.selectedFiles).toBe(1);
  expect(plan.selection.excluded).toBe(4); // package.json is also a discovery candidate
  expect(plan).toHaveProperty("scope");
  expect(plan.scope?.counts).toEqual({ observed: 4, selected: 1, excluded: 3, unavailable: 0 });
  expect(plan.scope?.roots.map((row) => row.root)).toEqual(["apps/host", "domains/sample/api", "domains/sample/web", "platform/shared"]);
  expect(plan.scope?.proposedIncludes).toEqual(paths.slice(1));
  expect(snapshot(root)).toEqual(before);
  expect(existsSync(join(root, ".semctx"))).toBe(false);
  expect(plan.index).toEqual({ status: "not-run", reason: "dry-run" });
  expect(plan.setupReady).toBe("unknown");
  const config = createGlobSelectionConfig(root);
  expect(discoverRepository({ ...config, include: [...config.include, ...plan.scope!.proposedIncludes] }).files).toHaveLength(4);
});

test("simple src scope and completed setup retain selection and saved config bytes", () => {
  const root = fixture(["src/index.ts"]);
  const plan = planSetupRepository(root, { polyglot: true });
  if (plan.kind !== "setup_plan") throw new Error("unexpected refusal");
  expect(plan.scope?.roots[0]?.root).toBe(".");
  expect(plan.scope?.proposedIncludes).toEqual([]);
  const completed = setupRepository(root, { polyglot: true });
  if (completed.kind !== "setup") throw new Error("unexpected refusal");
  expect(completed.scope).toEqual(plan.scope);
  const before = readFileSync(configPath(root));
  planSetupRepository(root, { polyglot: true });
  expect(readFileSync(configPath(root))).toEqual(before);
});

test.each([{ include: [] }, { include: [paths[0]!] }])("existing empty or restricted includes remain untouched: %j", ({ include }) => {
  const root = fixture();
  initWorkspace(root, { ...createGlobSelectionConfig(root), include: [...include] });
  const before = readFileSync(configPath(root));
  const plan = planSetupRepository(root, { polyglot: true });
  if (plan.kind !== "setup_plan") throw new Error("unexpected refusal");
  expect(plan.selection.selectedFiles).toBe(include.length);
  expect(plan.scope?.counts.excluded).toBe(4 - include.length);
  expect(readFileSync(configPath(root))).toEqual(before);
});

test("explicit excludes, disabled language misses and refused links never become proposals", () => {
  const root = fixture([...paths, "domains/python/src/main.py"]);
  const outside = fixture(["src/outside.ts"]);
  symlinkSync(join(outside, "src"), join(root, "linked.ts"), process.platform === "win32" ? "junction" : "dir");
  const config = { ...createGlobSelectionConfig(root), exclude: [paths[1]!], languages: { typescript: "on" as const, python: "off" as const } };
  const discovery = discoverRepository(config);
  expect(discovery.candidates.find((candidate) => candidate.relPath === "linked.ts")?.reason).toBe("SOURCE_LINK_OUTSIDE_REPOSITORY");
  const scope = projectSetupScope(config, discovery);
  expect(scope.proposedIncludes).toEqual(paths.slice(2));
  expect(scope.counts).toEqual({ observed: 6, selected: 1, excluded: 4, unavailable: 1 });
  expect(scope.reasonCounts).toContainEqual({ reason: "EXCLUDE_MATCH", count: 1 });
  expect(scope.reasonCounts).toContainEqual({ reason: "SOURCE_LINK_OUTSIDE_REPOSITORY", count: 1 });
  const applied = discoverRepository({ ...config, include: [...config.include, ...scope.proposedIncludes] });
  expect(applied.files).toHaveLength(3);
  expect(applied.candidates.find((entry) => entry.relPath === paths[1])?.reason).toBe("EXCLUDE_MATCH");
  const selectedDisabled = projectSetupScope({ ...config, include: ["**/*.py"] }, discoverRepository({ ...config, include: ["**/*.py"] }));
  expect(selectedDisabled.reasonCounts).toContainEqual({ reason: "LANGUAGE_DISABLED", count: 1 });
  expect(selectedDisabled.counts.unavailable).toBe(2); // selected disabled Python plus refused link
  expect(selectedDisabled.proposedIncludes).not.toContain("domains/python/src/main.py");
});

function miss(relPath: string): DiscoveryCandidate {
  return { relPath, language: "typescript", selectionDecision: "excluded", analysisOutcome: "not_applicable", reason: "INCLUDE_MISS" };
}

test("scope output is deterministic, bounded and honest about omitted roots samples and includes", () => {
  const config = createGlobSelectionConfig("unused");
  const candidates = Array.from({ length: 25 }, (_, index) => miss(`domains/d${String(index).padStart(2, "0")}/src/index.ts`));
  candidates.push(...Array.from({ length: 5 }, (_, index) => miss(`domains/d00/src/extra${index}.ts`)));
  candidates.push(miss(`${"界".repeat(81)}/src/index.ts`));
  candidates.push(miss(`domains/d00/src/${"界".repeat(81)}.ts`));
  const result = projectSetupScope(config, { files: [], candidates });
  expect(result).toEqual(projectSetupScope(config, { files: [], candidates: [...candidates].reverse() }));
  expect(result.counts).toEqual({ observed: 32, selected: 0, excluded: 32, unavailable: 0 });
  expect(result.roots).toHaveLength(SETUP_SCOPE_LIMITS.roots);
  expect(result.rootsTotal).toBe(26);
  expect(result.rootsOmitted).toBe(6);
  expect(result.roots[0]?.samplePaths).toHaveLength(3);
  expect(result.roots[0]?.samplePathsOmitted).toBe(4);
  expect(result.proposedIncludes).toHaveLength(20);
  expect(result.proposedIncludesTotal).toBe(30);
  expect(result.proposedIncludesOmitted).toBe(10);
  expect(result.unproposableIncludeMisses).toBe(2);
  for (const row of result.roots) {
    expect(Buffer.byteLength(row.root)).toBeLessThanOrEqual(240);
    for (const path of row.samplePaths) expect(Buffer.byteLength(path)).toBeLessThanOrEqual(240);
  }
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16000);
});

test("unsafe literals and unavailable selected candidates stay unknown without escaped or broad proposals", () => {
  const unsafe = ["domains/[x]/src/a.ts", "domains/{x,y}/src/a.ts", "domains/(x)/src/a.ts", "domains/!x/src/a.ts", "domains/?.ts", "domains/*.ts", "domains/\\x.ts", "../outside.ts", "/absolute.ts", "C:/absolute.ts", "domains/\nfile.ts", "domains/../a.ts"];
  const unavailable: DiscoveryCandidate[] = [
    { ...miss("failed/src/a.ts"), selectionDecision: "selected", analysisOutcome: "failed", reason: "READ_FAILED" },
    { ...miss("unsupported/src/a.ts"), selectionDecision: "selected", analysisOutcome: "unsupported", reason: "LANGUAGE_UNSUPPORTED" },
    { ...miss("disabled/src/a.ts"), selectionDecision: "selected", analysisOutcome: "disabled", reason: "LANGUAGE_DISABLED" },
  ];
  const result = projectSetupScope(createGlobSelectionConfig("unused"), { files: [], candidates: [...unsafe.map(miss), ...unavailable] });
  expect(result.proposedIncludes).toEqual([]);
  expect(result.unproposableIncludeMisses).toBe(unsafe.length);
  expect(result.counts.unavailable).toBe(3);
  expect(result.applyRequired).toBe(true);
});

test("observed Python test-family misses propose exact paths with parent-directory roots", () => {
  const root = fixture(["services/sample/test_main.py"]);
  const config = createGlobSelectionConfig(root);
  const scope = projectSetupScope(config, discoverRepository(config));
  expect(scope.counts).toEqual({ observed: 1, selected: 0, excluded: 1, unavailable: 0 });
  expect(scope.roots[0]?.root).toBe("services/sample");
  expect(scope.proposedIncludes).toEqual(["services/sample/test_main.py"]);
  expect(discoverRepository({ ...config, include: [...config.include, ...scope.proposedIncludes] }).files).toHaveLength(1);
});

test("applying an unread include miss still refuses outside imports through existing discovery", () => {
  const root = fixture(["domains/sample/src/index.ts"]);
  const outside = fixture(["outside.ts"]);
  const sourcePath = join(root, "domains/sample/src/index.ts");
  const importPath = relative(dirname(sourcePath), join(outside, "outside")).replaceAll("\\", "/");
  writeFileSync(sourcePath, `import { value } from ${JSON.stringify(importPath)};\nexport { value };\n`);
  const config = createGlobSelectionConfig(root);
  const discovery = discoverRepository(config);
  expect(discovery.candidates[0]?.reason).toBe("INCLUDE_MISS");
  const scope = projectSetupScope(config, discovery);
  expect(scope.proposedIncludes).toEqual(["domains/sample/src/index.ts"]);
  const applied = discoverRepository({ ...config, include: [...config.include, ...scope.proposedIncludes] });
  expect(applied.files).toHaveLength(0);
  expect(applied.candidates.find((candidate) => candidate.relPath.endsWith("index.ts"))?.reason).toBe("IMPORT_OUTSIDE_REPOSITORY");
  expect(projectSetupScope(config, applied).proposedIncludes).toEqual([]);
});
