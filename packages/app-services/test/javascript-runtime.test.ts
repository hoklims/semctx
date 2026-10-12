import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { discoverRepository } from "@semantic-context/ts-analyzer";
import { analyzePlaneARuntime } from "../src/plane-a-runtime";
import { resolvePlaneACapabilityRequirement } from "../src/plane-a-capability-requirements";
import { GraphIndex } from "@semantic-context/context-engine";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function analyze(path: string, content: string) {
  const root = mkdtempSync(join(tmpdir(), "semctx-js-runtime-")); roots.push(root);
  writeFileSync(join(root, path), content);
  const config = { ...createGlobSelectionConfig(root), include: ["**/*"], exclude: [], languages: { javascript: "on" as const } };
  return analyzePlaneARuntime(config, discoverRepository(config));
}
it("binds genuine ESM facts to an explicit JS producer and compiler dialect", () => {
  const result = analyze("script.mjs", "export function run() { return 1; }");
  expect(result.discoveryLedger[0]).toMatchObject({ analysisOutcome: "analyzed", analysisReasons: [], scope: { language: "javascript", dialectVersion: "5.9.3" }, selectedProducer: { identity: "@semantic-context/ts-analyzer/javascript", version: "0.1.0" } });
  expect(result.sidecar.capabilityProfiles.find(p => p.factKind === "function")).toMatchObject({ completenessClaim: "producer-declared", resolutionSemantics: "javascript-static-esm-v1", negativeEvidenceEligible: false });
});
it("records parsing failure instead of completing a recovered AST", () => {
  const result = analyze("script.mjs", "export function broken( {");
  expect(result.discoveryLedger[0]!.analysisOutcome).toBe("failed");
  expect(result.discoveryLedger[0]!.analysisReasons.some(r => r.startsWith("JAVASCRIPT_PARSE_ERROR:"))).toBe(true);
  expect(result.sidecar.factBatches.some(b => b.scope.language === "javascript")).toBe(false);
});
it("records TypeScript parsing failure in the opt-in runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-ts-runtime-")); roots.push(root);
  writeFileSync(join(root, "bad.ts"), "export function broken( {");
  const config = { ...createGlobSelectionConfig(root), include: ["**/*.ts"], exclude: [] };
  const result = analyzePlaneARuntime(config, discoverRepository(config));
  expect(result.discoveryLedger[0]!.analysisOutcome).toBe("failed");
  expect(result.discoveryLedger[0]!.analysisReasons.some(r => r.startsWith("SOURCE_PARSE_ERROR:"))).toBe(true);
});
it("refuses TypeScript-only annotations disguised by an mjs extension", () => {
  const result = analyze("script.mjs", "export function run(value: number) { return value; }");
  expect(result.discoveryLedger[0]!.analysisOutcome).toBe("failed");
  expect(result.discoveryLedger[0]!.analysisReasons.some(r => r.startsWith("JAVASCRIPT_PARSE_ERROR:8010"))).toBe(true);
});
it("keeps inherited analyzer configuration outside the repository diagnostic-only", () => {
  const parent = mkdtempSync(join(tmpdir(), "semctx-config-boundary-")); roots.push(parent);
  const root = join(parent, "repository"); mkdirSync(root);
  writeFileSync(join(parent, "base.json"), JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ extends: "../base.json" }));
  writeFileSync(join(root, "script.mjs"), "export function run() { return 1; }");
  const config = { ...createGlobSelectionConfig(root), include: ["**/*.mjs"], exclude: [], languages: { javascript: "on" as const } };
  const result = analyzePlaneARuntime(config, discoverRepository(config));
  expect(result.discoveryLedger.find(e => e.scope.language === "javascript")!.analysisReasons).toContain("SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY");
  expect(result.sidecar.capabilityProfiles.find(p => p.scope.language === "javascript")!.completenessClaim).toBe("partial");
});
it("resolves aliases, inherited tsconfig, declarations and TS/JS transitive calls under a nested monorepo", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-js-mixed-")); roots.push(root);
  mkdirSync(join(root, "suite", "packages", "lib", "src"), { recursive: true });
  const files = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@fixture/lib/*": ["suite/packages/lib/src/*"] } } }),
    "suite/tsconfig.json": JSON.stringify({ extends: "../tsconfig.json" }),
    "suite/packages/lib/src/base.ts": "export function base() { return 1; }",
    "suite/packages/lib/src/leaf.mjs": "import { base } from './base.ts'; function leaf() { return base(); } export { leaf }; export const amount = 1;",
    "suite/packages/lib/src/leaf.d.mts": "export declare function leaf(): number;",
    "suite/packages/lib/src/main.ts": "import { leaf } from '@fixture/lib/leaf.mjs'; export function main() { return leaf(); }",
    "suite/packages/lib/src/entry.mjs": "import { main } from './main.ts'; export function entry() { return main(); } export async function load() { return import('./leaf.mjs'); }",
  };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  const config = { ...createGlobSelectionConfig(root), include: ["**/*.{ts,mjs,mts}"], exclude: [], languages: { typescript: "on" as const, javascript: "on" as const } };
  const result = analyzePlaneARuntime(config, discoverRepository(config));
  const graph = result.analysis.graph;
  const index = new GraphIndex(graph);
  const base = graph.nodes.find(n => n.kind === "function" && n.name === "base")!;
  const entry = graph.nodes.find(n => n.kind === "function" && n.name === "entry")!;
  expect(index.distancesFrom([base.id], ["calls"], "in").get(entry.id)).toBe(3);
  expect(graph.nodes.find(n => n.name === "leaf" && n.kind === "function")!.exported).toBe(true);
  const leafModule = graph.nodes.find(n => n.kind === "module" && n.filePath?.endsWith("leaf.mjs"))!;
  expect(JSON.parse(String(leafModule.metadata.staticExports))).toContainEqual({ name: "amount", declarationKind: "variable" });
  expect(result.discoveryLedger.filter(e => e.scope.language === "javascript").every(e => e.analysisReasons.length === 0)).toBe(true);
  expect(graph.edges.some(e => e.kind === "imports" && e.from.includes("entry.mjs") && e.to === leafModule.id)).toBe(true);
});
for (const [path, source, reason] of [
  ["script.cjs", "module.exports = require('./missing.js');", "JAVASCRIPT_COMMONJS_UNSUPPORTED"],
  ["script.mjs", "export function run(path) { return import(path); }", "JAVASCRIPT_DYNAMIC_IMPORT_UNSUPPORTED"],
  ["script.js", "export { missing } from './missing.mjs';", "JAVASCRIPT_IMPORT_UNRESOLVED:./missing.mjs"],
  ["script.js", "import { missing } from '@fixture/missing';", "JAVASCRIPT_IMPORT_UNRESOLVED:@fixture/missing"],
]) {
  it(`keeps ${reason} explicit and excludes partial capability admission`, () => {
    const result = analyze(path!, source!);
    expect(result.discoveryLedger[0]!.analysisReasons).toContain(reason!);
    const profile = result.sidecar.capabilityProfiles.find(p => p.scope.language === "javascript")!;
    expect(profile.completenessClaim).toBe("partial");
    expect(resolvePlaneACapabilityRequirement({ configVersion: 2, producerConfigurationDigest: result.sidecar.producerConfigurationDigest, task: "verify", operation: "change", language: "javascript", factKind: profile.factKind, completenessClaim: profile.completenessClaim })).toBeNull();
  });
}
