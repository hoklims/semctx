import { rejects } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { prepare } from "./t00-ts7-q-boundary-admission";
import { applicationObservations, compareApplicationRuntime, compareApplicationRefusal, compareDynamicApplication, type ApplicationExpectation, type DynamicApplicationExpectation } from "./t00-ts7-q-boundary-application";
import { isolatedEnvironment, type Context, type Execution, type Json } from "./t00-ts7-q-boundary-common";

const producerSha256 = "a".repeat(64), helperSha256 = "b".repeat(64);
const producer = { identity: "@semantic-context/ts-analyzer/experimental-native-ts7", version: `7.1.0-dev/sha256:${producerSha256}` };
const paths = ["src/island.ts", "src/leaf.ts", "src/main.ts"];
const symbols = paths.map(path => ({ name: path === "src/main.ts" ? "main" : path === "src/leaf.ts" ? "leaf" : "island", kind: "function", relPath: path, scope: [], startLine: 1, endLine: 1, exported: true, markers: [] }));
const oracle = { modules: paths, symbols, imports: [{ fromRelPath: "src/main.ts", moduleSpecifier: "./leaf", resolvedRelPath: "src/leaf.ts", names: ["leaf"], line: 1 }], calls: [{ callerRelPath: "src/main.ts", callerSymbolPath: "main", calleeName: "leaf", calleeRelPath: "src/leaf.ts", calleeSymbolPath: "leaf", line: 1 }] };
const request = { cwd: "/project", roots: paths.map(path => `/project/${path}`), files: { "/project/src/island.ts": "export function island() { return 3; }\n", "/project/src/leaf.ts": "export function leaf() { return 1; }\n", "/project/src/main.ts": "import { leaf } from './leaf'; export function main() { return leaf(); }\n" } };
const expected: ApplicationExpectation = { mode: "qualified-retained", oracle, request, workers: 2, producerSha256, helperSha256 };
const evidence = (filePath: string, line?: number) => [{ filePath, ...(line === undefined ? {} : { startLine: line }), sourceKind: "code" }];
const repository = { id: "repo:project", kind: "repository", name: "project", evidence: [], tags: [], metadata: { root: "/project" } };
const nodes = [repository, ...paths.map(path => ({ id: `mod:${path}`, kind: "module", name: path.split("/").at(-1), filePath: path, evidence: evidence(path), tags: [], metadata: {} })), ...symbols.map(symbol => ({ id: `sym:function:${symbol.relPath}:${symbol.name}`, kind: "function", name: symbol.name, filePath: symbol.relPath, exported: true, evidence: [{ filePath: symbol.relPath, startLine: 1, endLine: 1, sourceKind: "code" }], tags: [], metadata: { exported: true } }))];
const edges = [
  ...paths.map(path => ({ kind: "belongs_to", from: `mod:${path}`, to: "repo:project", evidence: evidence(path), metadata: {} })),
  ...symbols.map(symbol => ({ kind: "declares", from: `mod:${symbol.relPath}`, to: `sym:function:${symbol.relPath}:${symbol.name}`, evidence: evidence(symbol.relPath, 1), metadata: {} })),
  { kind: "imports", from: "mod:src/main.ts", to: "mod:src/leaf.ts", evidence: evidence("src/main.ts", 1), metadata: { specifiers: "./leaf" } },
  { kind: "calls", from: "sym:function:src/main.ts:main", to: "sym:function:src/leaf.ts:leaf", evidence: evidence("src/main.ts", 1), metadata: {} },
];
const scope = (path?: string) => ({ language: path === undefined ? "repository" : "typescript", selectedPaths: path === undefined ? [] : [path], ...(path === undefined ? {} : { dialectVersion: "7.1.0-dev" }) });

function positive(workers: 1 | 2 = 2, mode: ApplicationExpectation["mode"] = "qualified-retained"): Execution {
  const batches = [undefined, ...paths].map((path, index) => {
    const facts = [...nodes.filter(node => "filePath" in node ? node.filePath === path : path === undefined).map(node => ({ ...node, factType: "node" })), ...edges.filter(edge => edge.evidence[0]?.filePath === path).map(edge => ({ ...edge, factType: "edge" }))];
    const factKinds = [...new Set(facts.map(fact => fact.kind))].sort();
    return { scope: scope(path), producer, batchId: `batch:${index}`, evidenceContract: "source-lines-v1", factKinds, facts, capabilityProfileIds: factKinds.map(kind => `${path}:${kind}`) };
  });
  const profiles = batches.flatMap(batch => batch.factKinds.map(kind => ({ profileId: `${batch.scope.selectedPaths[0]}:${kind}`, scope: batch.scope, factKind: kind, producer, evidenceContract: "source-lines-v1", resolutionSemantics: batch.scope.language === "repository" ? "structural-source-v1" : "typescript-static-ts7-experimental-v1", soundnessClaim: "best-effort-static", completenessClaim: "producer-declared", negativeEvidenceEligible: false, label: "structural" })));
  const ledger = paths.map(path => ({ candidateIdentity: `typescript:${path}`, scope: scope(path), selectionDecision: "selected", analysisOutcome: "analyzed", selectionReasons: [], analysisReasons: [], selectedProducer: producer }));
  const parallelism = mode === "qualified-retained"
    ? { requested: workers, used: 1, mode: "preflight-fallback", reason: "retained compiler input snapshot requires one semantic Program" }
    : { requested: workers, used: workers, mode: workers === 1 ? "single" : "parallel" };
  const workerObservation = mode === "qualified-retained"
    ? { executed: false, selectionSource: "retained-native-Program", parallelism, extraction: oracle, jobs: [], producer_artifact_id: `sha256:${producerSha256}` }
    : { executed: true, unsupported: [], globalAdmissionInferred: false, parallelism, extraction: oracle, producer_artifact_id: `sha256:${producerSha256}`, helperArtifactId: `sha256:${helperSha256}`, jobs: workers === 1 ? [] : [["src/island.ts"], ["src/leaf.ts", "src/main.ts"]].map(paths => ({ request: { repoRoot: "/project", emitAbsPaths: paths.map(path => `/project/${path}`) }, responseAccepted: true, transportError: null, outcome: { kind: "success", exit_code: 0 } })) };
  const value = { executed: true, analysis: { graph: { nodes, edges } }, integrityReasons: {}, sidecar: { scope: { language: "repository", selectedPaths: paths }, factBatches: batches, capabilityProfiles: profiles, discoveryLedger: ledger, producerResults: batches.map(batch => ({ status: "completed", scope: batch.scope, producer, factBatchId: batch.batchId })) }, discoveryLedger: ledger, parallelism, nativeObservation: { native_compiler_version: "7.1.0-dev", engine_revision: "780dc512d64f40afebffa6a7028207649fb7ed1c", sdk_version: "7.1.0-dev", complete: true, producer_artifact_id: `sha256:${producerSha256}`, raw_extraction: oracle, test_dynamic_import_keys: [] }, workerObservation, ...(mode === "qualified-retained" ? { ownershipObservation: { phase: "ownership", accepted: true, subjects: paths.map(path => ({ path, reasons: [] })) } } : {}), finalReceiptRevalidated: mode === "qualified-retained" };
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: "", value: structuredClone(value), evidence: [] };
}
const passes = (result: Execution, expectation = expected) => {
  const properties = compareApplicationRuntime("application", structuredClone(expectation), result);
  expect(properties.length).toBeGreaterThan(0);
  return properties.every(property => property.pass);
};
const obj = (value: unknown): Json => value as Json;
const arr = (value: unknown): Json[] => value as Json[];

test("application comparison accepts retained Program fallback, graph and provenance", () => {
  expect(passes(positive())).toBe(true);
  expect(passes(positive(1), { ...expected, workers: 1 })).toBe(true);
});

test("application comparison refuses omitted graph facts, sidecar facts, profiles and producer results", () => {
  for (const mutate of [
    (value: Json) => { obj(obj(value.analysis).graph).edges = structuredClone(edges.filter(edge => edge.kind !== "calls")); },
    (value: Json) => { arr(obj(value.sidecar).factBatches).find(batch => arr(batch.facts).some(fact => fact.kind === "calls"))!.facts = []; },
    (value: Json) => { obj(value.sidecar).capabilityProfiles = arr(obj(value.sidecar).capabilityProfiles).slice(1); },
    (value: Json) => { obj(value.sidecar).producerResults = []; },
  ]) {
    expect(passes(positive())).toBe(true);
    const result = positive(); mutate(result.value); expect(passes(result)).toBe(false);
    expect(passes(positive())).toBe(true);
  }
});

test("application comparison refuses changed compiler provenance, dialect or repository dialect claims", () => {
  for (const mutate of [
    (value: Json) => { obj(arr(obj(value.sidecar).factBatches)[0]!.producer).identity = "legacy"; },
    (value: Json) => { obj(arr(obj(value.sidecar).capabilityProfiles).find(profile => obj(profile.scope).language === "typescript")!.scope).dialectVersion = "5.9.3"; },
    (value: Json) => { obj(obj(value.sidecar).scope).dialectVersion = "7.1.0-dev"; },
    (value: Json) => { obj(value.workerObservation).executed = true; },
  ]) {
    expect(passes(positive())).toBe(true);
    const result = positive(); mutate(result.value); expect(passes(result)).toBe(false);
    expect(passes(positive())).toBe(true);
  }
});

test("application comparison refuses missing actual integrity reasons, receipt revalidation and ownership", () => {
  for (const mutate of [
    (value: Json) => { delete value.integrityReasons; },
    (value: Json) => { value.integrityReasons = { "src/main.ts": ["unproven"] }; },
    (value: Json) => { value.finalReceiptRevalidated = false; },
    (value: Json) => { obj(value.workerObservation).jobs = [{}]; },
    (value: Json) => { obj(value.ownershipObservation).accepted = false; },
    (value: Json) => { obj(value.workerObservation).parallelism = { requested: 2, used: 1, mode: "preflight-fallback" }; },
    (value: Json) => { arr(obj(value.sidecar).discoveryLedger)[0]!.analysisReasons = ["unexpected"]; },
  ]) {
    expect(passes(positive())).toBe(true);
    const result = positive(); mutate(result.value); expect(passes(result)).toBe(false);
    expect(passes(positive())).toBe(true);
  }
});

test("application witness requires the oracle to activate import/call and the separate island component", () => {
  const properties = compareApplicationRuntime("application", { ...expected, oracle: { ...oracle, imports: [], calls: [] } }, positive());
  const activation = properties.filter(property => property.name.includes(".oracle.activation."));
  expect(activation.length).toBeGreaterThan(0);
  expect(activation.every(property => property.pass)).toBe(false);
});


test("ordinary application comparison requires worker observations without retained ownership or receipt", () => {
  const ordinary = { ...expected, mode: "ordinary" as const };
  expect(passes(positive(1, "ordinary"), { ...ordinary, workers: 1 })).toBe(true);
  expect(passes(positive(2, "ordinary"), ordinary)).toBe(true);
  for (const mutate of [
    (value: Json) => { obj(value.workerObservation).jobs = []; },
    (value: Json) => { obj(value.workerObservation).helperArtifactId = `sha256:${"c".repeat(64)}`; },
    (value: Json) => { value.finalReceiptRevalidated = true; },
    (value: Json) => { value.ownershipObservation = { phase: "ownership", accepted: true }; },
  ]) {
    expect(passes(positive(2, "ordinary"), ordinary)).toBe(true);
    const result = positive(2, "ordinary"); mutate(result.value); expect(passes(result, ordinary)).toBe(false);
    expect(passes(positive(2, "ordinary"), ordinary)).toBe(true);
  }
});


test("application snapshot refusal requires exact owner error and no successful output", () => {
  const error = "SOURCE_SNAPSHOT_MISMATCH: src/main.ts";
  const execution: Execution = { exitCode: 1, stdout: "", stderr: JSON.stringify({ error }) + "\n", value: {}, evidence: [] };
  const properties = compareApplicationRefusal("application.snapshot", error, execution);
  expect(properties.length).toBeGreaterThan(0);
  expect(properties.every(property => property.pass)).toBe(true);
  for (const changed of [{ ...execution, exitCode: 0 }, { ...execution, stdout: '{"executed":true}' }, { ...execution, stderr: '{"error":"wrong"}' }]) {
    expect(compareApplicationRefusal("application.snapshot", error, execution).every(property => property.pass)).toBe(true);
    expect(compareApplicationRefusal("application.snapshot", error, changed).every(property => property.pass)).toBe(false);
    expect(compareApplicationRefusal("application.snapshot", error, execution).every(property => property.pass)).toBe(true);
  }
});

const dynamicCoverage = ["covers:test:src/main.test.ts:main.test.ts->function:src/main.ts:main", "tested_by:function:src/main.ts:main->test:src/main.test.ts:main.test.ts"];
const dynamicNodes = [
  { id: "repo:project", kind: "repository", name: "project", evidence: [] },
  { id: "test", kind: "test", filePath: "src/main.test.ts", name: "main.test.ts", evidence: [{ filePath: "src/main.test.ts", sourceKind: "test" }] },
  { id: "module", kind: "module", filePath: "src/main.ts", name: "main.ts", evidence: [{ filePath: "src/main.ts", sourceKind: "code" }] },
  { id: "main", kind: "function", filePath: "src/main.ts", name: "main", exported: true, evidence: [{ filePath: "src/main.ts", startLine: 1, endLine: 1, sourceKind: "code" }] },
  { id: "spec", kind: "function", filePath: "src/main.test.ts", name: "spec", exported: true, evidence: [{ filePath: "src/main.test.ts", startLine: 1, endLine: 1, sourceKind: "code" }] },
];
const dynamicEdges = [{ kind: "covers", from: "test", to: "main", evidence: [{ filePath: "src/main.test.ts", startLine: 1, sourceKind: "test" }] }, { kind: "tested_by", from: "main", to: "test", evidence: [{ filePath: "src/main.test.ts", startLine: 1, sourceKind: "test" }] }];
const dynamicCoreEdges = [
  { kind: "belongs_to", from: "test", to: "repo:project", evidence: [{ filePath: "src/main.test.ts", sourceKind: "code" }] },
  { kind: "belongs_to", from: "module", to: "repo:project", evidence: [{ filePath: "src/main.ts", sourceKind: "code" }] },
  { kind: "declares", from: "test", to: "spec", evidence: [{ filePath: "src/main.test.ts", startLine: 1, sourceKind: "code" }] },
  { kind: "declares", from: "module", to: "main", evidence: [{ filePath: "src/main.ts", startLine: 1, sourceKind: "code" }] },
  { kind: "imports", from: "test", to: "module", evidence: [{ filePath: "src/main.test.ts", startLine: 1, sourceKind: "code" }] },
];
const dynamicCallEdge = { kind: "calls", from: "spec", to: "main", evidence: [{ filePath: "src/main.test.ts", startLine: 1, sourceKind: "code" }] };
const dynamicOracle = { modules: ["src/main.test.ts", "src/main.ts"], symbols: [{ kind: "function", relPath: "src/main.ts", name: "main", scope: [], startLine: 1, endLine: 1, exported: true, markers: [] }, { kind: "function", relPath: "src/main.test.ts", name: "spec", scope: [], startLine: 1, endLine: 1, exported: true, markers: [] }], imports: [{ fromRelPath: "src/main.test.ts", moduleSpecifier: "./main", resolvedRelPath: "src/main.ts", names: [], line: 1 }], calls: [] };
const staticDynamicOracle = { ...dynamicOracle, imports: [{ ...dynamicOracle.imports[0]!, names: ["main"] }], calls: [{ callerRelPath: "src/main.test.ts", callerSymbolPath: "spec", calleeName: "main", calleeRelPath: "src/main.ts", calleeSymbolPath: "main", line: 1 }] };
const literalIntegrity = { "src/main.test.ts": ["QUALIFIED_TEST_DYNAMIC_IMPORT_BINDING_UNPROVEN:src/main.ts"] };

function dynamicExecution(outcome: "composed" | "ownership-refused"): Execution {
  const keys = outcome === "composed" ? [] : ["src/main.test.ts:1:./main"];
  const graph = { nodes: dynamicNodes, edges: outcome === "composed" ? [...dynamicCoreEdges, dynamicCallEdge, ...dynamicEdges] : dynamicCoreEdges };
  const extraction = outcome === "composed" ? staticDynamicOracle : dynamicOracle;
  const selected = [["src/main.test.ts"], ["src/main.ts"]];
  const sidecar = structuredClone({ factBatches: [{ facts: [...dynamicNodes.map(node => ({ ...node, factType: "node" })), ...graph.edges.map(edge => ({ ...edge, factType: "edge" }))] }], discoveryLedger: selected.map(selectedPaths => ({ scope: { language: "typescript", selectedPaths }, selectionDecision: "selected", analysisOutcome: "analyzed", analysisReasons: outcome === "ownership-refused" && selectedPaths[0] === "src/main.test.ts" ? literalIntegrity["src/main.test.ts"] : [] })), capabilityProfiles: selected.map(selectedPaths => ({ scope: { language: "typescript", selectedPaths }, completenessClaim: outcome === "ownership-refused" && selectedPaths[0] === "src/main.test.ts" ? "partial" : "producer-declared", negativeEvidenceEligible: false, label: outcome === "ownership-refused" && selectedPaths[0] === "src/main.test.ts" ? "partial" : "structural" })) });
  const value = { executed: true, analysis: { graph }, sidecar, integrityReasons: outcome === "composed" ? {} : literalIntegrity, nativeObservation: { raw_extraction: extraction, test_dynamic_import_keys: keys, native_compiler_version: "7.1.0-dev", engine_revision: "780dc512d64f40afebffa6a7028207649fb7ed1c", sdk_version: "7.1.0-dev", complete: true, producer_artifact_id: `sha256:${producerSha256}` }, workerObservation: { executed: false, selectionSource: "retained-native-Program", jobs: [], extraction, parallelism: { requested: 2, used: 1, mode: "preflight-fallback", reason: "retained compiler input snapshot requires one semantic Program" }, producer_artifact_id: `sha256:${producerSha256}` } };
  return outcome === "composed"
    ? { exitCode: 0, stdout: "{}", stderr: "", value: structuredClone({ ...value, ownershipObservation: { phase: "ownership", accepted: true }, finalReceiptRevalidated: true }), evidence: [] }
    : { exitCode: 1, stdout: "", stderr: JSON.stringify({ error: "APPLICATION_SESSION_EOF:RefusalHasNoOwnership", diagnosticAssembly: { ...value, stage: "application-composition-refused" }, finalReceiptRevalidated: false }), value: {}, evidence: [] };
}
function dynamicExpectation(outcome: DynamicApplicationExpectation["outcome"]): DynamicApplicationExpectation {
  return structuredClone(outcome === "composed"
    ? { outcome, oracle: staticDynamicOracle, keys: [], integrityReasons: {}, ledgerReasons: {}, coverage: dynamicCoverage, producerSha256 }
    : { outcome, oracle: dynamicOracle, keys: ["src/main.test.ts:1:./main"], integrityReasons: literalIntegrity, ledgerReasons: literalIntegrity, coverage: [], producerSha256 });
}
const dynamicPasses = (execution: Execution, expectation: DynamicApplicationExpectation = dynamicExpectation("ownership-refused")) => {
  const properties = compareDynamicApplication("dynamic.application", expectation, execution);
  expect(properties.length).toBeGreaterThan(0);
  return properties.every(property => property.pass);
};
function assertDynamicBaseline(outcome: DynamicApplicationExpectation["outcome"]): void {
  expect(dynamicPasses(dynamicExecution(outcome), dynamicExpectation(outcome))).toBe(true);
}

test("dynamic application diagnostic comparison accepts coherent refusal and successful static composition separately", () => {
  expect(dynamicPasses(dynamicExecution("ownership-refused"))).toBe(true);
  const properties = compareDynamicApplication("dynamic.static", dynamicExpectation("composed"), dynamicExecution("composed"));
  expect(properties.length).toBeGreaterThan(0);
  expect(properties.every(property => property.pass)).toBe(true);
});

test("dynamic diagnostic comparison refuses missing diagnostics, integrity, sidecar or incorrect coverage", () => {
  for (const mutate of [
    (value: Json) => { delete value.diagnosticAssembly; },
    (value: Json) => { delete obj(value.diagnosticAssembly).stage; },
    (value: Json) => { delete obj(value.diagnosticAssembly).integrityReasons; },
    (value: Json) => { delete obj(value.diagnosticAssembly).sidecar; },
    (value: Json) => { obj(obj(value.diagnosticAssembly).sidecar).capabilityProfiles = []; },
    (value: Json) => { arr(obj(obj(value.diagnosticAssembly).sidecar).discoveryLedger)[0]!.analysisReasons = ["JAVASCRIPT_UNSUPPORTED"]; },
    (value: Json) => { obj(obj(obj(value.diagnosticAssembly).analysis).graph).edges = structuredClone(dynamicEdges); },
    (value: Json) => { obj(obj(value.diagnosticAssembly).nativeObservation).test_dynamic_import_keys = []; },
    (value: Json) => { value.error = "application graph differs from received extraction"; },
    (value: Json) => { value.finalReceiptRevalidated = true; },
  ]) {
    assertDynamicBaseline("ownership-refused");
    const execution = dynamicExecution("ownership-refused");
    const value = JSON.parse(execution.stderr) as Json;
    mutate(value);
    execution.stderr = JSON.stringify(value);
    expect(dynamicPasses(execution)).toBe(false);
    assertDynamicBaseline("ownership-refused");
  }
});


test("application fixture establishes a local Git commit before oracle or qualified discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "t00-application-git-"));
  try {
    const context: Context = {
      root, sdk: {}, platform: "macos", producerSha256, helperSha256, helper: "/helper",
      producerArtifact: { path: "/producer", sha256: producerSha256, bytes: 1 }, oracleArtifact: { path: "/oracle", sha256: producerSha256, bytes: 1 },
      receiveIdentity: async () => { throw Error("unexpected identity receiver execution"); },
      analysis: () => ({}), save: async () => ({ path: "/proof", sha256: producerSha256, bytes: 1 }),
      run: async () => { throw Error("unexpected producer execution"); },
      applicationRuntime: async () => { throw Error("unexpected application execution"); },
      extractionOracle: async () => { throw Error("STOP_AFTER_FIXTURE_GIT"); },
      oracle: async () => { throw Error("unexpected compiler execution"); },
    };
    await rejects(applicationObservations(context), /STOP_AFTER_FIXTURE_GIT/);
    const directory = join(root, "application-composition");
    const git = Bun.spawnSync(["git", "-C", directory, "rev-parse", "--verify", "HEAD"], { env: isolatedEnvironment(directory) });
    expect(git.exitCode).toBe(0);
    expect(git.stdout.toString().trim()).toMatch(/^[a-f0-9]{40}$/);
    const tracked = Bun.spawnSync(["git", "-C", directory, "ls-files"], { env: isolatedEnvironment(directory) });
    expect(tracked.exitCode).toBe(0);
    expect(tracked.stdout.toString().trim().split("\n")).toEqual(["src/island.ts", "src/leaf.ts", "src/main.ts"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dynamic comparison keeps excluded configuration scopes outside local TypeScript reason claims", () => {
  const execution = dynamicExecution("composed");
  arr(obj(execution.value.sidecar).discoveryLedger).push({ scope: { language: "unknown", selectedPaths: ["base.json"] }, selectionDecision: "excluded", analysisOutcome: "not_applicable", analysisReasons: [] });
  const properties = compareDynamicApplication("dynamic.static", dynamicExpectation("composed"), execution);
  expect(properties.every(property => property.pass)).toBe(true);
});


test("dynamic comparison with only known local reasons cannot claim independent exact reason closure", () => {
  const properties = compareDynamicApplication("dynamic.unknown", { ...dynamicExpectation("ownership-refused"), ledgerReasons: undefined }, dynamicExecution("ownership-refused"));
  expect(properties.find(property => property.name.endsWith(".independent-exact-reasons-available"))?.pass).toBe(false);
  expect(properties.filter(property => !property.name.endsWith(".independent-exact-reasons-available")).every(property => property.pass)).toBe(true);
});

test("dynamic comparison rejects an empty graph despite an unchanged refusal and extraction", () => {
  assertDynamicBaseline("ownership-refused");
  const execution = dynamicExecution("ownership-refused");
  const value = JSON.parse(execution.stderr) as Json;
  obj(obj(value.diagnosticAssembly).analysis).graph = { nodes: [], edges: [] };
  execution.stderr = JSON.stringify(value);
  expect(dynamicPasses(execution)).toBe(false);
  assertDynamicBaseline("ownership-refused");
});

test("dynamic comparison rejects empty sidecar facts despite an unchanged refusal and graph", () => {
  assertDynamicBaseline("ownership-refused");
  const execution = dynamicExecution("ownership-refused");
  const value = JSON.parse(execution.stderr) as Json;
  obj(obj(value.diagnosticAssembly).sidecar).factBatches = [{ facts: [] }];
  execution.stderr = JSON.stringify(value);
  expect(dynamicPasses(execution)).toBe(false);
  assertDynamicBaseline("ownership-refused");
});

test("dynamic full graph comparison rejects omissions, additions and changed provenance in graph and sidecar", () => {
  const mutations: ((graph: Json) => void)[] = [
    graph => { graph.nodes = arr(graph.nodes).filter(node => node.id !== "spec"); },
    graph => { graph.nodes = [...arr(graph.nodes), { id: "extra", kind: "function", filePath: "src/main.ts", name: "extra", exported: true, evidence: [{ filePath: "src/main.ts", startLine: 1, endLine: 1, sourceKind: "code" }] }]; },
    graph => { graph.edges = arr(graph.edges).filter(edge => edge.kind !== "imports"); },
    graph => { graph.edges = [...arr(graph.edges), { kind: "calls", from: "main", to: "spec", evidence: [{ filePath: "src/main.ts", startLine: 1, sourceKind: "code" }] }]; },
    graph => { arr(arr(graph.nodes).find(node => node.id === "spec")!.evidence)[0]!.startLine = 2; },
    graph => { arr(arr(graph.nodes).find(node => node.id === "test")!.evidence)[0]!.sourceKind = "code"; },
    graph => { arr(graph.nodes).find(node => node.id === "test")!.kind = "module"; },
    graph => { arr(arr(graph.edges).find(edge => edge.kind === "imports")!.evidence)[0]!.startLine = 9; },
    graph => { arr(arr(graph.edges).find(edge => edge.kind === "belongs_to")!.evidence)[0]!.sourceKind = "test"; },
  ];
  for (const outcome of ["composed", "ownership-refused"] as const) for (const target of ["graph", "facts"] as const) for (const mutate of [...mutations, ...(outcome === "composed" ? [(graph: Json) => { graph.edges = arr(graph.edges).filter(edge => edge.kind !== "calls"); }] : [])]) {
    assertDynamicBaseline(outcome);
    const execution = dynamicExecution(outcome);
    const report = outcome === "composed" ? execution.value : JSON.parse(execution.stderr) as Json;
    const value = outcome === "composed" ? report : obj(report.diagnosticAssembly);
    const companion = structuredClone(target === "graph" ? value.sidecar : value.analysis);
    if (target === "graph") mutate(obj(obj(value.analysis).graph));
    else {
      const facts = arr(arr(obj(value.sidecar).factBatches)[0]!.facts);
      const graph = { nodes: facts.filter(fact => fact.factType === "node"), edges: facts.filter(fact => fact.factType === "edge") };
      mutate(graph);
      arr(obj(value.sidecar).factBatches)[0]!.facts = [...graph.nodes.map(node => ({ ...node, factType: "node" })), ...graph.edges.map(edge => ({ ...edge, factType: "edge" }))];
    }
    if (outcome === "ownership-refused") execution.stderr = JSON.stringify(report);
    expect(target === "graph" ? value.sidecar : value.analysis).toEqual(companion);
    const properties = compareDynamicApplication("dynamic.full", dynamicExpectation(outcome), execution);
    expect(properties.every(property => property.pass)).toBe(false);
    assertDynamicBaseline(outcome);
  }
});

test("dynamic full graph comparison requires static call and test relation evidence and refuses untyped facts", () => {
  for (const target of ["graph", "facts"] as const) for (const kind of ["calls", "covers", "tested_by"]) {
    assertDynamicBaseline("composed");
    const execution = dynamicExecution("composed");
    const value = execution.value;
    const companion = structuredClone(target === "graph" ? value.sidecar : value.analysis);
    const graph = target === "graph" ? obj(obj(value.analysis).graph) : { nodes: arr(arr(obj(value.sidecar).factBatches)[0]!.facts).filter(fact => fact.factType === "node"), edges: arr(arr(obj(value.sidecar).factBatches)[0]!.facts).filter(fact => fact.factType === "edge") };
    arr(arr(graph.edges).find(edge => edge.kind === kind)!.evidence)[0]!.sourceKind = "document";
    expect(target === "graph" ? value.sidecar : value.analysis).toEqual(companion);
    const properties = compareDynamicApplication("dynamic.full", dynamicExpectation("composed"), execution);
    expect(properties.every(property => property.pass)).toBe(false);
    assertDynamicBaseline("composed");
  }
  assertDynamicBaseline("ownership-refused");
  const execution = dynamicExecution("ownership-refused");
  const report = JSON.parse(execution.stderr) as Json;
  arr(arr(obj(obj(report.diagnosticAssembly).sidecar).factBatches)[0]!.facts).push({ factType: "unrecognized" });
  execution.stderr = JSON.stringify(report);
  expect(dynamicPasses(execution)).toBe(false);
  assertDynamicBaseline("ownership-refused");
});

test("fresh composed baseline remains valid after all preceding adversarial mutations", () => {
  const properties = compareDynamicApplication("dynamic.fresh.composed", dynamicExpectation("composed"), dynamicExecution("composed"));
  expect(properties.every(property => property.pass)).toBe(true);
});

test("fresh refused baseline remains valid after all preceding adversarial mutations", () => {
  expect(dynamicPasses(dynamicExecution("ownership-refused"))).toBe(true);
});

test("adversarial graph mutation leaves sibling sidecar and independent oracle unchanged", () => {
  assertDynamicBaseline("composed");
  const execution = dynamicExecution("composed");
  const expectation = dynamicExpectation("composed");
  const sidecar = structuredClone(execution.value.sidecar);
  const expectedOracle = structuredClone(expectation.oracle);
  arr(arr(obj(obj(execution.value.analysis).graph).nodes).find(node => node.id === "spec")!.evidence)[0]!.startLine = 2;
  expect(execution.value.sidecar).toEqual(sidecar);
  expect(expectation.oracle).toEqual(expectedOracle);
  assertDynamicBaseline("composed");
});

test("adversarial compiler observation cannot rewrite the independent expected oracle or next baseline", () => {
  assertDynamicBaseline("composed");
  const execution = dynamicExecution("composed");
  const expectation = dynamicExpectation("composed");
  const expectedOracle = structuredClone(expectation.oracle);
  arr(obj(obj(execution.value.nativeObservation).raw_extraction).symbols)[0]!.name = "changedActualDeclaration";
  expect(expectation.oracle).toEqual(expectedOracle);
  expect(dynamicPasses(execution, expectation)).toBe(false);
  assertDynamicBaseline("composed");
});


test("application campaign obtains separate native expectations for retained and ordinary extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "t00-application-oracle-modes-"));
  const retainedOracle = structuredClone(oracle);
  Object.assign(retainedOracle.imports[0]!, { bindingTargets: [{ relPath: "src/leaf.ts", symbolPath: "leaf", runtimeUsed: true }] });
  try {
    const context: Context = {
      root, sdk: {}, platform: "macos", producerSha256, helperSha256, helper: "/helper",
      producerArtifact: { path: "/producer", sha256: producerSha256, bytes: 1 }, oracleArtifact: { path: "/oracle", sha256: producerSha256, bytes: 1 },
      receiveIdentity: async () => { throw Error("unexpected identity receiver execution"); },
      analysis: () => ({}), save: async () => ({ path: "/proof", sha256: producerSha256, bytes: 1 }),
      run: async () => { throw Error("unexpected producer execution"); },
      oracle: async () => { throw Error("unexpected compiler execution"); },
      extractionOracle: async (_label, input) => ({ exitCode: 0, stdout: "", stderr: "", value: structuredClone(input.retained === true ? retainedOracle : oracle), evidence: [] }),
      applicationRuntime: async (_label, input, workers) => {
        const retained = input.retained === true;
        const execution = positive(workers as 1 | 2, retained ? "qualified-retained" : "ordinary");
        obj(execution.value.nativeObservation).raw_extraction = structuredClone(retained ? retainedOracle : oracle);
        obj(execution.value.workerObservation).extraction = structuredClone(retained ? retainedOracle : oracle);
        return execution;
      },
    };
    const observed = await applicationObservations(context);
    const imports = observed.properties.filter(property => /application\.(qualified-retained|ordinary)\.workers-[12]\.(native|worker)\.extraction\.imports\.exact$/.test(property.name));
    expect(imports).toHaveLength(8);
    expect(imports.every(property => property.pass)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});


const arrPaths = (value: unknown): string[] => obj(value).selectedPaths as string[];

function failedDynamicFixture() {
  const execution = dynamicExecution("ownership-refused");
  const report = JSON.parse(execution.stderr) as Json;
  const assembly = obj(report.diagnosticAssembly);
  const graph = obj(obj(assembly.analysis).graph);
  graph.edges = arr(graph.edges).filter(edge => edge.kind !== "imports");
  const extraction = { ...structuredClone(dynamicOracle), imports: [] };
  obj(assembly.nativeObservation).raw_extraction = structuredClone(extraction);
  obj(assembly.nativeObservation).test_dynamic_import_keys = [];
  obj(assembly.workerObservation).extraction = structuredClone(extraction);
  assembly.integrityReasons = {};
  const sidecar = obj(assembly.sidecar);
  sidecar.factBatches = [{ facts: [...arr(graph.nodes).filter(node => node.filePath !== "src/main.test.ts").map(node => ({ ...node, factType: "node" })), ...arr(graph.edges).filter(edge => arr(edge.evidence)[0]?.filePath !== "src/main.test.ts").map(edge => ({ ...edge, factType: "edge" }))] }];
  sidecar.capabilityProfiles = arr(sidecar.capabilityProfiles).filter(profile => arrPaths(profile.scope)[0] !== "src/main.test.ts");
  const failedLedger = arr(sidecar.discoveryLedger).find(entry => arrPaths(entry.scope)[0] === "src/main.test.ts")!;
  failedLedger.analysisOutcome = "failed";
  failedLedger.analysisReasons = ["PRODUCER_FAILED", "SOURCE_ASYNC_RETURN_UNSUPPORTED"];
  execution.stderr = JSON.stringify(report);
  return { execution, expectation: { ...dynamicExpectation("ownership-refused"), oracle: extraction, keys: [], integrityReasons: {}, ledgerReasons: { "src/main.test.ts": ["PRODUCER_FAILED", "SOURCE_ASYNC_RETURN_UNSUPPORTED"] }, failedPaths: ["src/main.test.ts"] } };
}

test("dynamic configuration refusal preserves native graph while excluding failed producer facts and profiles", () => {
  const { execution, expectation } = failedDynamicFixture();
  expect(dynamicPasses(execution, expectation)).toBe(true);
});

test("dynamic configuration refusal requires the exact failed ledger and denies profiles for its failed scope", () => {
  for (const mutate of [
    (sidecar: Json) => { arr(sidecar.discoveryLedger)[0]!.analysisReasons = ["SOURCE_ASYNC_RETURN_UNSUPPORTED"]; },
    (sidecar: Json) => { arr(sidecar.discoveryLedger)[0]!.analysisOutcome = "analyzed"; },
    (sidecar: Json) => { arr(sidecar.capabilityProfiles).push({ scope: { language: "typescript", selectedPaths: ["src/main.test.ts"] }, negativeEvidenceEligible: false, completenessClaim: "partial", label: "partial" }); },
    (sidecar: Json) => { arr(arr(sidecar.factBatches)[0]!.facts).push({ ...structuredClone(dynamicNodes[1]!), factType: "node" }); },
  ]) {
    const { execution, expectation } = failedDynamicFixture();
    expect(dynamicPasses(execution, expectation)).toBe(true);
    const report = JSON.parse(execution.stderr) as Json;
    mutate(obj(obj(report.diagnosticAssembly).sidecar));
    execution.stderr = JSON.stringify(report);
    expect(dynamicPasses(execution, expectation)).toBe(false);
    const baseline = failedDynamicFixture();
    expect(dynamicPasses(baseline.execution, baseline.expectation)).toBe(true);
  }
});


function mjsDynamicFixture(outcome: DynamicApplicationExpectation["outcome"] = "ownership-refused") {
  const convert = <T>(value: T): T => JSON.parse(JSON.stringify(value)
    .replaceAll("src/main.test.ts", "src/target.test.mjs")
    .replaceAll("src/main.ts", "src/target.mjs")
    .replaceAll("main.test.ts", "target.test.mjs")
    .replaceAll('"main.ts"', '"target.mjs"')
    .replaceAll("./main", "./target.mjs")
    .replaceAll("typescript", "javascript")) as T;
  const execution = dynamicExecution(outcome);
  const converted = convert(execution);
  if (outcome === "ownership-refused") converted.stderr = JSON.stringify(convert(JSON.parse(execution.stderr) as Json));
  return { execution: converted, expectation: { ...convert(dynamicExpectation(outcome)), fixture: { sourcePath: "src/target.mjs", testPath: "src/target.test.mjs", language: "javascript" as const } } };
}

test("dynamic MJS comparison exercises its own exact source paths and JavaScript scopes", () => {
  for (const outcome of ["composed", "ownership-refused"] as const) {
    const { execution, expectation } = mjsDynamicFixture(outcome);
    expect(dynamicPasses(execution, expectation)).toBe(true);
  }
});

test("dynamic MJS comparison rejects a missing binding refusal and an unexpected TypeScript scope", () => {
  for (const mutate of [
    (assembly: Json) => { assembly.integrityReasons = {}; },
    (assembly: Json) => { arr(obj(assembly.sidecar).discoveryLedger).push({ scope: { language: "typescript", selectedPaths: ["src/target.test.mjs"] }, selectionDecision: "selected", analysisOutcome: "analyzed", analysisReasons: [] }); },
  ]) {
    const { execution, expectation } = mjsDynamicFixture();
    expect(dynamicPasses(execution, expectation)).toBe(true);
    const report = JSON.parse(execution.stderr) as Json;
    mutate(obj(report.diagnosticAssembly));
    execution.stderr = JSON.stringify(report);
    expect(dynamicPasses(execution, expectation)).toBe(false);
    const baseline = mjsDynamicFixture();
    expect(dynamicPasses(baseline.execution, baseline.expectation)).toBe(true);
  }
});


test("MJS campaign fixture captures only its declared source paths and retains its initial control", async () => {
  const root = await mkdtemp(join(tmpdir(), "t00-mjs-fixture-"));
  const context = {
    root, analysis: () => ({}), save: async () => ({ path: "/proof", sha256: producerSha256, bytes: 1 }),
  } as unknown as Context;
  try {
    const fixture = await prepare(context, "mjs-shape", { "src/target.mjs": "export function helper(){return 1;}\n", "src/target.test.mjs": "export async function check(){const dep=await import('./target.mjs');return dep.helper();}\n", "package.json": '{"name":"qualified-fixture","type":"module"}\n' }, { "src/target.test.mjs": "export function check(){return 1;}\n" });
    const tracked = Bun.spawnSync(["git", "-C", fixture.root, "ls-files"], { env: isolatedEnvironment(fixture.root) });
    expect(tracked.exitCode).toBe(0);
    expect(tracked.stdout.toString().trim().split("\n").filter(path => path.startsWith("src/"))).toEqual(["src/target.mjs", "src/target.test.mjs"]);
    const initial = Bun.spawnSync(["git", "-C", fixture.root, "show", `${fixture.baseCommit}:src/target.test.mjs`], { env: isolatedEnvironment(fixture.root) });
    expect(initial.exitCode).toBe(0);
    expect(initial.stdout.toString()).toBe("export function check(){return 1;}\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
