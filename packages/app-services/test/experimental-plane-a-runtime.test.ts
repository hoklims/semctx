import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, type SemctxConfig } from "@semantic-context/core";
import { createRepositoryAnalyzer, discoverRepository, type AnalysisCompiler, type TsExtraction, type DiscoveryResult, type CompilerInputSnapshot } from "@semantic-context/ts-analyzer";
import { analyzePlaneARuntimeAsync, type AsyncPlaneARuntimeResult } from "../src/plane-a-runtime";
import type { ExperimentalTypeScriptRuntime } from "../src/experimental-typescript-runtime";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "semctx-experimental-owner-")));
  roots.push(root);
  mkdirSync(join(root, "src"));
  const path = join(root, "src/value.ts");
  const text = "export function value() { return 1; }\n";
  writeFileSync(path, text);
  const config: SemctxConfig = { ...createGlobSelectionConfig(root), include: ["src/**/*"], selectionMode: "qualified-static-v1", analysisProfile: "public-monorepo-static-v1" };
  const discovery = discoverRepository({ ...config, selectionMode: "globs-v1", analysisProfile: undefined });
  const inputs = new Map([[path, text]]);
  const extraction: TsExtraction = { modules: ["src/value.ts"], symbols: [{ name: "value", kind: "function", relPath: "src/value.ts", scope: [], startLine: 1, endLine: 1, exported: true, markers: [] }], imports: [], calls: [] };
  const compiler: AnalysisCompiler = {
    producerIdentity: () => ({ identity: "t00/experimental-native-ts7", version: "fixture-7.1.0-dev" }),
    dialectVersion: "7.1.0-dev",
    resolutionSemantics: () => "typescript-static-ts7-experimental-v1",
    extract: () => extraction,
    extractParallel: async (_paths, _root, workers) => ({ extraction, parallelism: { requested: workers ?? "auto", used: 1, mode: "single" } }),
    dynamicTestImports: () => new Set(),
    readRetained: (snapshot, file) => snapshot.get(file),
    registerOpaqueCallbackOwnership: () => {},
    inspectJavaScriptSource: () => { throw Error("UNEXPECTED_JAVASCRIPT_COMPILER_OPERATION"); },
  };
  const runtime: ExperimentalTypeScriptRuntime = {
    analyzer: createRepositoryAnalyzer(compiler),
    sourceParsingReasons: () => [],
    configurationReasons: () => [],
    analysisReasons: () => ["EXPERIMENTAL_NATIVE_REASON"],
    bindOwnership: async () => {},
    revalidate: async () => {},
  };
  return { config, discovery, inputs, runtime };
}

const run: (config: SemctxConfig, discovery: DiscoveryResult, workers: number, inputs: CompilerInputSnapshot, runtime: ExperimentalTypeScriptRuntime) => Promise<AsyncPlaneARuntimeResult> = analyzePlaneARuntimeAsync;

test("explicit compiler instance reaches the application owner with its dialect, producer and attached reasons", async () => {
  const { config, discovery, inputs, runtime } = fixture();
  const result = await run(config, discovery, 2, inputs, runtime);
  const profiles = result.sidecar.capabilityProfiles.filter(profile => profile.scope.language === "typescript");
  expect(profiles.length).toBeGreaterThan(0);
  expect([...new Set(profiles.map(profile => profile.scope.dialectVersion))]).toEqual(["7.1.0-dev"]);
  expect([...new Set(profiles.map(profile => profile.producer.identity))]).toEqual(["t00/experimental-native-ts7"]);
  expect(profiles.every(profile => profile.resolutionSemantics === "typescript-static-ts7-experimental-v1" && !profile.negativeEvidenceEligible)).toBe(true);
  expect(result.discoveryLedger.find(entry => entry.scope.selectedPaths.includes("src/value.ts"))?.analysisReasons).toEqual(["EXPERIMENTAL_NATIVE_REASON"]);
  expect(result.analysis.graph.nodes.some(node => node.id === "sym:function:src/value.ts:value")).toBe(true);
});

test("application composition refuses when the ownership receipt cannot be used", async () => {
  const { config, discovery, inputs, runtime } = fixture();
  const error: unknown = await run(config, discovery, 2, inputs, { ...runtime, bindOwnership: async () => { throw Error("OWNERSHIP_RECEIPT_REQUIRED"); } }).catch((failure: unknown) => failure);
  expect(error).toEqual(expect.objectContaining({ message: "OWNERSHIP_RECEIPT_REQUIRED" }));
});

test("application emission refuses when final validation of the same receipt fails", async () => {
  const { config, discovery, inputs, runtime } = fixture();
  const error: unknown = await run(config, discovery, 2, inputs, { ...runtime, revalidate: async () => { throw Error("RECEIPT_CHANGED_AFTER_COMPOSITION"); } }).catch((failure: unknown) => failure);
  expect(error).toEqual(expect.objectContaining({ message: "RECEIPT_CHANGED_AFTER_COMPOSITION" }));
});

test("ordinary retained application composition does not claim qualified receipt ownership", async () => {
  const { config, discovery, inputs, runtime } = fixture();
  const ordinary = { ...config, selectionMode: "globs-v1" as const, analysisProfile: undefined };
  const result = await run(ordinary, discovery, 2, inputs, {
    ...runtime,
    bindOwnership: async () => { throw Error("ORDINARY_HAS_NO_QUALIFIED_OWNERSHIP"); },
    revalidate: async () => { throw Error("ORDINARY_HAS_NO_QUALIFIED_RECEIPT"); },
  });
  expect(result.analysis.graph.nodes.some(node => node.name === "value")).toBe(true);
  expect(result.sidecar.capabilityProfiles.filter(profile => profile.scope.language === "typescript").every(profile => profile.scope.dialectVersion === "7.1.0-dev")).toBe(true);
});
