import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "../packages/core/node_modules/zod";
import type { RepositoryGraph } from "@semantic-context/core";

const [baseline, inputPath, outputPath] = process.argv.slice(2);
if (!baseline || !inputPath || !outputPath) throw new Error("baseline, input and output required");
const core = await import(resolve(baseline, "packages/core/src/index.ts")) as typeof import("../packages/core/src/index");
const store = await import(resolve(baseline, "packages/repository-store/src/index.ts")) as typeof import("../packages/repository-store/src/index");
const indexing = await import(resolve(baseline, "packages/app-services/src/indexing.ts")) as typeof import("../packages/app-services/src/indexing");
const verify = await import(resolve(baseline, "packages/app-services/src/verify.ts")) as typeof import("../packages/app-services/src/verify");
const freshness = await import(resolve(baseline, "packages/app-services/src/freshness.ts")) as typeof import("../packages/app-services/src/freshness");
const controls = await import(resolve(baseline, "packages/app-services/src/control.ts")) as typeof import("../packages/app-services/src/control");
const qualified = await import(resolve(baseline, "packages/app-services/src/qualified-analysis.ts")) as typeof import("../packages/app-services/src/qualified-analysis");
const analyzer = await import(resolve(baseline, "packages/ts-analyzer/src/index.ts")) as typeof import("../packages/ts-analyzer/src/index");
const typescript = await import(resolve(baseline, "node_modules/typescript/lib/typescript.js")) as { default: typeof import("typescript") };
const ts = typescript.default;
if (ts.version !== "5.9.3") throw new Error("TypeScript 5.9.3 required");
const input = z.object({ units: z.array(z.object({ id: z.string(), root: z.string() })).nonempty() }).parse(JSON.parse(readFileSync(inputPath, "utf8")) as unknown);
const units = [];
for (const unit of input.units) {
  const config = Object.assign(core.createGlobSelectionConfig(unit.root), { selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*.ts"] });
  store.initWorkspace(unit.root, config);
  indexing.indexRepository(unit.root, "2026-10-23T10:01:00.000Z");
  const consumed = freshness.captureQualifiedAnalysisInputs(config);
  const retained = (): Map<string, string> => new Map(consumed.files.map(file => [resolve(unit.root, file.path), Buffer.from(file.bytes).toString("utf8")]));
  const compilerInputs = retained(); const main = resolve(unit.root, "src/main.ts");
  const beforeAnalysis = analyzer.inspectModuleConfiguration(main, unit.root, compilerInputs);
  const { graph } = analyzer.analyzeRepository(config, undefined, compilerInputs);
  const afterAnalysis = analyzer.inspectModuleConfiguration(main, unit.root, compilerInputs);
  const removedGraph: RepositoryGraph = { ...graph, edges: [] };
  analyzer.registerOpaqueCallbackOwnership(compilerInputs, removedGraph, unit.root);
  const afterGraphEdgesRemoved = analyzer.inspectModuleConfiguration(main, unit.root, compilerInputs);
  const computation = verify.runVerify(unit.root, { kind: "working-tree" });
  const status = controls.controlStatus(unit.root);
  const bindingInput: Parameters<typeof qualified.bindOpaqueCallbackGraph>[0] = { graph, actualFactsHash: computation.analyzedRepositoryFactsHash, freshness: status, consumedHash: consumed.digest, expectedHash: consumed.digest, bindingValid: true, buildComplete: true, checkChanged: false };
  const variants = ["fresh-valid", "dirty-known-only-working-tree", "missing-freshness-seal", "invalid-binding", "incomplete-build", "check-changed", "stale", "dirty-other-reason", "sealed-facts-mismatch", "indexed-facts-mismatch", "sealed-input-mismatch", "indexed-input-mismatch", "expected-input-mismatch", "forged-receipt-provenance", "post-receipt-graph-mutation", "post-receipt-capture-mutation"];
  const tokenGuards = [];
  for (const id of variants) {
    const current = structuredClone(bindingInput);
    const observed = current.freshness;
    const seal = observed?.freshnessSeal;
    if (id === "dirty-known-only-working-tree" && observed) { observed.verdict = "DIRTY_KNOWN"; observed.reasons = ["WORKING_TREE_DIRTY"]; }
    if (id === "missing-freshness-seal" && observed) observed.freshnessSeal = null;
    if (id === "invalid-binding") current.bindingValid = false;
    if (id === "incomplete-build") current.buildComplete = false;
    if (id === "check-changed") current.checkChanged = true;
    if (id === "stale" && observed) observed.verdict = "STALE";
    if (id === "dirty-other-reason" && observed) { observed.verdict = "DIRTY_KNOWN"; observed.reasons = ["HEAD_MISMATCH"]; }
    const mismatch = `sha256:${"0".repeat(64)}` as const;
    if (id === "sealed-facts-mismatch" && seal) seal.repositoryGraphHash = mismatch;
    if (id === "indexed-facts-mismatch" && seal) seal.indexedRepositoryGraphHash = mismatch;
    if (id === "sealed-input-mismatch" && seal) seal.analysisInputHash = mismatch;
    if (id === "indexed-input-mismatch" && seal) seal.indexedAnalysisInputHash = mismatch;
    if (id === "expected-input-mismatch") current.expectedHash = mismatch;
    let token = qualified.bindOpaqueCallbackGraph(current);
    if (id === "forged-receipt-provenance" && token) token = { ...token };
    const currentGraph = id === "post-receipt-graph-mutation" ? removedGraph : graph;
    const currentConsumed = id === "post-receipt-capture-mutation" ? { ...consumed, digest: mismatch } : consumed;
    const scope = qualified.inspectRetainedQualifiedScope({ config, graph: currentGraph, consumedInputs: currentConsumed, expectedInputHash: current.expectedHash, checkChanged: current.checkChanged, opaqueGraphBinding: token, retainedCompilerInputs: retained() });
    tokenGuards.push({ id, issued: token !== undefined, opaqueReasonPresent: scope.reasons.some(reason => reason.endsWith(":SOURCE_OPAQUE_CALLBACK_UNSUPPORTED")), scope });
  }
  units.push({ id: unit.id, phases: { beforeAnalysis, afterAnalysis, afterGraphEdgesRemoved }, graph, consumedDigest: consumed.digest, retainedPaths: consumed.files.map(file => file.path), admission: computation.report.analysisAdmission, actualFactsHash: computation.analyzedRepositoryFactsHash, observedFreshness: status, tokenGuards });
}
const digest = createHash("sha256").update(readFileSync(resolve(baseline, "packages/app-services/src/qualified-analysis.ts"))).digest("hex");
writeFileSync(outputPath, JSON.stringify({ typescript: ts.version, baseline, baselineQualifiedAnalysisSha256: digest, units }, null, 2) + "\n");
