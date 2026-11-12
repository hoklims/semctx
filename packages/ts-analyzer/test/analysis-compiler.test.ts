import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { getPlaneASidecar } from "@semantic-context/plane-a-internal";
import { createRepositoryAnalyzer, getQualifiedCallIntegrityReasons, type TypeScriptAnalysisCompiler, type TsExtraction, type DiscoveredFile } from "../src";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "semctx-analysis-compiler-"));
  roots.push(root);
  const files: DiscoveredFile[] = [
    { absPath: join(root, "main.ts"), relPath: "main.ts", role: "source", language: "typescript", content: "export const mainBytes = 1;\n" },
    { absPath: join(root, "leaf.ts"), relPath: "leaf.ts", role: "source", language: "typescript", content: "export function leaf() { return 1; }\n" },
    { absPath: join(root, "leaf.test.ts"), relPath: "leaf.test.ts", role: "test", language: "typescript", content: "export const testBytes = 1;\n" },
  ];
  for (const file of files) writeFileSync(file.absPath, file.content);
  const snapshot = new Map(files.map(file => [file.absPath, file.content]));
  const config = { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1" as const, analysisProfile: "public-monorepo-static-v1" as const };
  return { root, files, snapshot, config };
}

function facts(): TsExtraction {
  return {
    modules: ["leaf.ts", "main.ts", "leaf.test.ts"],
    symbols: [
      { name: "leaf", kind: "function", relPath: "leaf.ts", scope: [], startLine: 1, endLine: 1, exported: true, markers: [] },
      { name: "backendEntry", kind: "function", relPath: "main.ts", scope: [], startLine: 1, endLine: 1, exported: true, markers: [] },
    ],
    imports: [
      { fromRelPath: "main.ts", moduleSpecifier: "./leaf", resolvedRelPath: "leaf.ts", names: ["leaf"], line: 1 },
      { fromRelPath: "leaf.test.ts", moduleSpecifier: "./leaf", resolvedRelPath: "leaf.ts", names: ["leaf"], line: 1 },
    ],
    calls: [
      { callerRelPath: "main.ts", callerSymbolPath: "backendEntry", calleeName: "leaf", calleeRelPath: "leaf.ts", calleeSymbolPath: "leaf", line: 1 },
      { callerRelPath: "main.ts", callerSymbolPath: "backendEntry", calleeName: "missing", calleeRelPath: "leaf.ts", calleeSymbolPath: "missing", line: 1 },
    ],
  };
}

function inMemoryCompiler(extraction = facts()): TypeScriptAnalysisCompiler {
  return {
    producerIdentity: language => ({ identity: `fixture-compiler/${language}`, version: "fixture-identity-1" }),
    dialectVersion: "fixture-dialect-1",
    resolutionSemantics: language => `fixture-${language}-resolution`,
    extract: () => extraction,
    extractParallel: async (_paths, _root, workers = "auto") => ({ extraction, parallelism: { requested: workers, used: 1, mode: "single" } }),
    dynamicTestImports: () => new Set(["leaf.test.ts:1:./leaf"]),
    registerOpaqueCallbackOwnership: () => {},
    readRetained: (snapshot, path) => snapshot.get(path),
    inspectJavaScriptSource: () => ({ parseFailed: false, reasons: [], staticExports: [], staticModuleLinks: [] }),
  };
}

function assertAssembled(analysis: ReturnType<ReturnType<typeof createRepositoryAnalyzer>["analyzeRepository"]>): void {
  expect(analysis.graph.nodes.some(node => node.id === "sym:function:main.ts:backendEntry")).toBe(true);
  expect(analysis.graph.edges.filter(edge => edge.kind === "calls").map(edge => [edge.from, edge.to])).toEqual([["sym:function:main.ts:backendEntry", "sym:function:leaf.ts:leaf"]]);
  expect(analysis.graph.edges.filter(edge => edge.kind === "imports").map(edge => [edge.from, edge.to]).sort()).toEqual([["mod:main.ts", "mod:leaf.ts"], ["test:leaf.test.ts", "mod:leaf.ts"]]);
  expect(analysis.graph.edges.some(edge => edge.kind === "tested_by" && edge.from === "sym:function:leaf.ts:leaf" && edge.to === "test:leaf.test.ts")).toBe(true);
  expect(analysis.graph.edges.some(edge => edge.kind === "covers" && edge.from === "test:leaf.test.ts" && edge.to === "sym:function:leaf.ts:leaf")).toBe(true);
  expect(getQualifiedCallIntegrityReasons(analysis).get("main.ts")).toEqual(["QUALIFIED_CALL_COORDINATE_CALLEE_MISSING:leaf.ts:missing"]);
  expect(getQualifiedCallIntegrityReasons(analysis).get("leaf.test.ts")).toEqual(["QUALIFIED_TEST_DYNAMIC_IMPORT_BINDING_UNPROVEN:leaf.ts"]);
  const sidecar = getPlaneASidecar(analysis)!;
  expect(sidecar.factBatches.filter(batch => batch.scope.language === "typescript").every(batch => batch.scope.dialectVersion === "fixture-dialect-1" && batch.producer.identity === "fixture-compiler/typescript" && batch.producer.version === "fixture-identity-1")).toBe(true);
  expect(sidecar.producerResults.every(result => result.producer.identity === "fixture-compiler/typescript")).toBe(true);
  const profiles = sidecar.capabilityProfiles.filter(profile => profile.scope.language === "typescript");
  expect(profiles.length).toBeGreaterThan(0);
  expect(profiles.every(profile => profile.producer.identity === "fixture-compiler/typescript" && profile.resolutionSemantics === "fixture-typescript-resolution" && profile.negativeEvidenceEligible === false)).toBe(true);
  expect(sidecar.capabilityProfiles.filter(profile => profile.scope.language === "repository").every(profile => profile.resolutionSemantics === "structural-source-v1")).toBe(true);
}

test("analyzer instance assembles injected compiler facts, integrity reasons and producer provenance", () => {
  const value = fixture();
  const analyzer = createRepositoryAnalyzer(inMemoryCompiler());
  assertAssembled(analyzer.analyzeRepository(value.config, value.files, value.snapshot));
});

test("direct instance assembly uses the owning graph and sidecar path without re-extraction", () => {
  const value = fixture();
  const compiler = inMemoryCompiler();
  compiler.extract = () => { throw Error("direct assembly must not extract"); };
  const analyzer = createRepositoryAnalyzer(compiler);
  assertAssembled(analyzer.assembleRepository(value.config, value.files, facts(), value.snapshot));
});

test("async instance selection uses its compiler operation and preserves worker selection", async () => {
  const value = fixture();
  const compiler = inMemoryCompiler();
  compiler.extract = () => { throw Error("asynchronous analysis must use its asynchronous compiler operation"); };
  compiler.extractParallel = async (_paths, _root, workers = "auto") => ({ extraction: facts(), parallelism: { requested: workers, used: 2, mode: "parallel" } });
  const result = await createRepositoryAnalyzer(compiler).analyzeRepositoryAsync(value.config, value.files, 2, value.snapshot);
  assertAssembled(result.analysis);
  expect(result.parallelism).toEqual({ requested: 2, used: 2, mode: "parallel" });
});

test("retained guards reject a compiler-specific missing or changed source before extraction", async () => {
  const value = fixture();
  for (const text of [undefined, "changed retained bytes"]) {
    const compiler = inMemoryCompiler();
    compiler.readRetained = () => text;
    const analyzer = createRepositoryAnalyzer(compiler);
    expect(() => analyzer.analyzeRepository(value.config, value.files, value.snapshot)).toThrow("SOURCE_SNAPSHOT_MISMATCH: main.ts");
    const failure = await analyzer.analyzeRepositoryAsync(value.config, value.files, 2, value.snapshot).then(() => undefined, (error: unknown) => error);
    expect(failure).toEqual(expect.objectContaining({ message: "SOURCE_SNAPSHOT_MISMATCH: main.ts" }));
  }
});

test("assembly diagnostics and opaque ownership belong to the injected JavaScript compiler", () => {
  const value = fixture();
  const file: DiscoveredFile = { absPath: join(value.root, "module.js"), relPath: "module.js", role: "source", language: "javascript", content: "const native = require('node:fs');\n" };
  writeFileSync(file.absPath, file.content);
  const snapshot = new Map([[file.absPath, file.content]]);
  const compiler = inMemoryCompiler({ modules: ["module.js"], symbols: [{ name: "backendJavaScript", kind: "function", relPath: "module.js", scope: [], startLine: 1, endLine: 1, exported: true, markers: [] }], imports: [], calls: [] });
  let hasOwnership = false;
  compiler.registerOpaqueCallbackOwnership = (inputs, graph, root) => { hasOwnership = inputs === snapshot && root === value.root && graph.nodes.some(node => node.name === "backendJavaScript"); };
  compiler.inspectJavaScriptSource = () => ({ parseFailed: false, reasons: [hasOwnership ? "IN_MEMORY_OWNERSHIP_REGISTERED" : "IN_MEMORY_OWNERSHIP_MISSING"], staticExports: [{ name: "nativeJavaScript", declarationKind: "function" }], staticModuleLinks: [{ specifier: "./virtual", resolution: "external" }] });
  const analysis = createRepositoryAnalyzer(compiler).analyzeRepository(value.config, [file], snapshot);
  const module = analysis.graph.nodes.find(node => node.id === "mod:module.js")!;
  expect(module.metadata["staticExports"]).toBe('[{"name":"nativeJavaScript","declarationKind":"function"}]');
  expect(module.metadata["staticModuleLinks"]).toBe('[{"specifier":"./virtual","resolution":"external"}]');
  const sidecar = getPlaneASidecar(analysis)!;
  expect(sidecar.discoveryLedger.find(row => row.scope.language === "javascript")?.analysisReasons).toEqual(["IN_MEMORY_OWNERSHIP_REGISTERED"]);
  expect(sidecar.factBatches.find(batch => batch.scope.language === "javascript")?.producer).toEqual({ identity: "fixture-compiler/javascript", version: "fixture-identity-1" });
  expect(sidecar.capabilityProfiles.filter(profile => profile.scope.language === "javascript").every(profile => profile.resolutionSemantics === "fixture-javascript-resolution" && profile.scope.dialectVersion === "fixture-dialect-1")).toBe(true);
});

test("separate analyzer instances preserve their graph and producer identity", () => {
  const value = fixture();
  const first = createRepositoryAnalyzer(inMemoryCompiler());
  const secondCompiler = inMemoryCompiler();
  secondCompiler.producerIdentity = language => ({ identity: `second-compiler/${language}`, version: "second-identity" });
  const second = createRepositoryAnalyzer(secondCompiler);
  const firstAnalysis = first.analyzeRepository(value.config, value.files, value.snapshot);
  const secondAnalysis = second.analyzeRepository(value.config, value.files, value.snapshot);
  assertAssembled(firstAnalysis);
  expect(getPlaneASidecar(secondAnalysis)?.factBatches.every(batch => batch.producer.identity === "second-compiler/typescript")).toBe(true);
  expect(getPlaneASidecar(firstAnalysis)?.factBatches.every(batch => batch.producer.identity === "fixture-compiler/typescript")).toBe(true);
});

test("injected extraction cannot seal facts after live source changes", () => {
  const value = fixture();
  const compiler = inMemoryCompiler();
  compiler.extract = () => {
    writeFileSync(value.files[0]!.absPath, "export const changedLiveBytes = 2;\n");
    return facts();
  };
  expect(() => createRepositoryAnalyzer(compiler).analyzeRepository(value.config, value.files, value.snapshot)).toThrow(expect.objectContaining({ code: "CAPTURE_CHANGED_DURING_ANALYSIS", coordinate: "sourceDigest" }));
});
