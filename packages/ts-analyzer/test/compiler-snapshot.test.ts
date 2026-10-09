import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractionContext, extractTypeScript, extractTypeScriptParallel } from "../src/ts-symbols";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { analyzeRepository, discoverRepository } from "../src";
import { inspectJavaScriptSource } from "../src/javascript-diagnostics";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("retains source and configuration bytes across an ABA compiler read", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-compiler-aba-")); roots.push(root);
  const source = join(root, "entry.mjs"); const config = join(root, "tsconfig.json");
  const leaf = join(root, "leaf.mjs"); const other = join(root, "other.mjs");
  const a = "import { leaf } from '@fixture/leaf'; export function retainedA() { return leaf(); }";
  const configA = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@fixture/leaf": ["./leaf.mjs"] } } });
  const snapshot = new Map([[source, a], [config, configA], [leaf, "export function leaf() { return 1; }"], [other, "export function leaf() { return 2; }"]]);
  for (const [path, content] of snapshot) writeFileSync(path, content);
  const original = extractionContext.createProgram;
  const hook = spyOn(extractionContext, "createProgram").mockImplementation((paths, supplied) => {
    writeFileSync(source, "import { leaf } from '@fixture/leaf'; export function transientB() { return leaf(); }");
    writeFileSync(config, JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@fixture/leaf": ["./other.mjs"] } } }));
    const program = original(paths, supplied);
    writeFileSync(source, a); writeFileSync(config, configA);
    return program;
  });
  try {
    const result = extractTypeScript([source, leaf, other], root, snapshot);
    expect(result.symbols.some(symbol => symbol.name === "retainedA")).toBe(true);
    expect(result.symbols.some(symbol => symbol.name === "transientB")).toBe(false);
    expect(result.imports.find(item => item.fromRelPath === "entry.mjs")?.resolvedRelPath).toBe("leaf.mjs");
    expect(result.calls.find(item => item.callerSymbolPath === "retainedA")?.calleeRelPath).toBe("leaf.mjs");
  } finally { hook.mockRestore(); }
});
it("forces retained TS-only inputs through a single Program on the worker entrypoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-ts-worker-snapshot-")); roots.push(root);
  const path = join(root, "entry.ts");
  writeFileSync(path, "export function transientB() { return 2; }");
  const snapshot = new Map([[path, "export function retainedA() { return 1; }"]]);
  const result = await extractTypeScriptParallel([path], root, 2, snapshot);
  expect(result.extraction.symbols[0]!.name).toBe("retainedA");
  expect(result.parallelism).toMatchObject({ requested: 2, used: 1, mode: "preflight-fallback", reason: "retained compiler input snapshot requires one semantic Program" });
});
it("reports declared third-party dependency boundaries while retaining unresolved workspace aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-external-snapshot-")); roots.push(root);
  const path = join(root, "test.mjs"); const content = "import { test } from 'vitest'; import { leaf } from '@fixture/local';";
  const snapshot = new Map([[path, content], [join(root, "package.json"), JSON.stringify({ devDependencies: { vitest: "4.0.0", "@fixture/local": "workspace:*" } })]]);
  const inspected = inspectJavaScriptSource(path, content, root, snapshot);
  expect(inspected.staticModuleLinks).toContainEqual({ specifier: "vitest", resolution: "external" });
  expect(inspected.reasons).not.toContain("JAVASCRIPT_IMPORT_UNRESOLVED:vitest");
  expect(inspected.reasons).toContain("JAVASCRIPT_IMPORT_UNRESOLVED:@fixture/local");
});
it("refuses discovery metadata inconsistent with the retained raw source map", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-discovery-snapshot-")); roots.push(root);
  const path = join(root, "script.mjs");
  writeFileSync(path, "export function retainedA() { return 1; }");
  const config = { ...createGlobSelectionConfig(root), include: ["**/*.mjs"], exclude: [], languages: { javascript: "on" as const } };
  const files = discoverRepository(config).files;
  const snapshot = new Map([[path, files[0]!.content]]);
  expect(() => analyzeRepository(config, [{ ...files[0]!, content: "export function transientB() { return 2; }" }], snapshot)).toThrow("SOURCE_SNAPSHOT_MISMATCH");
});
it("assembles a retained source graph instead of sealing transient compiler input", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-bound-snapshot-")); roots.push(root);
  const path = join(root, "script.mjs"); const retained = "export function retainedA() { return 1; }";
  writeFileSync(path, retained);
  const config = { ...createGlobSelectionConfig(root), include: ["**/*.mjs"], exclude: [], languages: { javascript: "on" as const } };
  const discovery = discoverRepository(config);
  const original = extractionContext.createProgram;
  const hook = spyOn(extractionContext, "createProgram").mockImplementation((paths, snapshot) => {
    writeFileSync(path, "export function transientB() { return 2; }");
    const program = original(paths, snapshot);
    writeFileSync(path, retained);
    return program;
  });
  try {
    const result = analyzeRepository(config, discovery.files, new Map([[path, retained]]));
    expect(result.graph.nodes.some(node => node.name === "retainedA")).toBe(true);
    expect(result.graph.nodes.some(node => node.name === "transientB")).toBe(false);
  } finally { hook.mockRestore(); }
});
