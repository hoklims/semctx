import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compareExtraction, compareSimpleGraph, compareTestRelations } from "./t00-ts7-q-boundary-extraction";
import { isolatedEnvironment, type Context, type Evidence, type Execution, type Json, type Property } from "./t00-ts7-q-boundary-common";

export type ApplicationExpectation = { mode: "qualified-retained" | "ordinary"; oracle: Json; request: Json; workers: 1 | 2; producerSha256: string; helperSha256: string };
const contract = "Independent ts_goport 7.1.0-dev Program; consumer-contracts indices 2/3/4/235; accepted ADR0010 provenance and experimental application composition contract";
const record = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const rows = (value: unknown): Json[] => list(value).map(record);
const check = (name: string, expected: unknown, actual: unknown): Property => ({ name, expected, actual, pass: isDeepStrictEqual(expected, actual), oracle: contract });
const ordered = (values: unknown[]): unknown[] => values.toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
const scope = (value: unknown): Json => {
  const input = record(value);
  return { language: input.language, selectedPaths: input.selectedPaths, dialectVersion: input.dialectVersion };
};
const expectedScope = (path?: string): Json => ({ language: path === undefined ? "repository" : "typescript", selectedPaths: path === undefined ? [] : [path], dialectVersion: path === undefined ? undefined : "7.1.0-dev" });

function expectedKinds(oracle: Json): Map<string, string[]> {
  const kinds = new Map<string, Set<string>>(list(oracle.modules).map(path => [String(path), new Set(["module", "belongs_to"])]));
  for (const symbol of rows(oracle.symbols)) {
    kinds.get(String(symbol.relPath))?.add(String(symbol.kind));
    kinds.get(String(symbol.relPath))?.add("declares");
  }
  for (const entry of rows(oracle.imports)) if (kinds.has(String(entry.resolvedRelPath))) kinds.get(String(entry.fromRelPath))?.add("imports");
  const hasSymbol = (path: unknown, coordinate: unknown): boolean => rows(oracle.symbols).some(symbol => symbol.relPath === path && [...list(symbol.scope), symbol.name].join(".") === coordinate);
  for (const call of rows(oracle.calls)) if (hasSymbol(call.calleeRelPath, call.calleeSymbolPath) && (call.callerSymbolPath === undefined || hasSymbol(call.callerRelPath, call.callerSymbolPath))) kinds.get(String(call.callerRelPath))?.add("calls");
  kinds.set("", new Set(["repository"]));
  return new Map([...kinds].map(([path, values]) => [path, [...values].sort()]));
}

export function compareApplicationRuntime(label: string, expected: ApplicationExpectation, execution: Execution): Property[] {
  const value = execution.value, graph = record(record(value.analysis).graph), sidecar = record(value.sidecar);
  const native = record(value.nativeObservation), worker = record(value.workerObservation), ownership = record(value.ownershipObservation);
  const producer = { identity: "@semantic-context/ts-analyzer/experimental-native-ts7", version: `7.1.0-dev/sha256:${expected.producerSha256}` };
  const paths = list(expected.oracle.modules).map(String).sort();
  const kinds = expectedKinds(expected.oracle), batches = rows(sidecar.factBatches), profiles = rows(sidecar.capabilityProfiles), results = rows(sidecar.producerResults);
  const retained = expected.mode === "qualified-retained";
  const parallelism = retained
    ? { requested: expected.workers, used: 1, mode: "preflight-fallback", reason: "retained compiler input snapshot requires one semantic Program" }
    : { requested: expected.workers, used: expected.workers, mode: expected.workers === 1 ? "single" : "parallel" };
  const facts = batches.flatMap(batch => rows(batch.facts));
  const graphWithReasons = { ...graph, integrityReasons: value.integrityReasons };
  const projectedFacts = { nodes: facts.filter(fact => fact.factType === "node"), edges: facts.filter(fact => fact.factType === "edge"), integrityReasons: value.integrityReasons };
  const ledger = paths.map(path => ({ candidateIdentity: `typescript:${path}`, scope: expectedScope(path), selectionDecision: "selected", analysisOutcome: "analyzed", selectionReasons: [], analysisReasons: [], selectedProducer: producer }));
  const projectLedger = (entries: unknown): unknown[] => ordered(rows(entries).map(entry => ({ candidateIdentity: entry.candidateIdentity, scope: scope(entry.scope), selectionDecision: entry.selectionDecision, analysisOutcome: entry.analysisOutcome, selectionReasons: entry.selectionReasons, analysisReasons: entry.analysisReasons, selectedProducer: entry.selectedProducer })));
  const expectedProfiles = [...kinds].flatMap(([path, values]) => values.map(factKind => ({ scope: expectedScope(path || undefined), factKind, producer, evidenceContract: "source-lines-v1", resolutionSemantics: path ? "typescript-static-ts7-experimental-v1" : "structural-source-v1", soundnessClaim: "best-effort-static", completenessClaim: "producer-declared", negativeEvidenceEligible: false, label: "structural" })));
  const nodeMetadata: Json[] = rows(expected.oracle.symbols).map(symbol => ({ kind: symbol.kind, path: symbol.relPath, name: symbol.name, tags: [], metadata: { exported: symbol.exported } }));
  nodeMetadata.push(...paths.map(path => ({ kind: "module", path, name: path.split("/").at(-1), tags: [], metadata: {} })), { kind: "repository", path: undefined, name: String(expected.request.cwd).split("/").at(-1), tags: [], metadata: { root: expected.request.cwd } });
  const properties = [
    check(`${label}.exit`, 0, execution.exitCode),
    check(`${label}.executed`, true, value.executed),
    check(`${label}.receipt.final-revalidated`, retained, value.finalReceiptRevalidated),
    check(`${label}.native.compiler`, "7.1.0-dev", native.native_compiler_version),
    check(`${label}.native.revision`, "780dc512d64f40afebffa6a7028207649fb7ed1c", native.engine_revision),
    check(`${label}.native.sdk`, "7.1.0-dev", native.sdk_version),
    check(`${label}.native.complete`, true, native.complete),
    check(`${label}.native.producer-artifact`, `sha256:${expected.producerSha256}`, native.producer_artifact_id),
    check(`${label}.native.dynamic-test-imports`, [], native.test_dynamic_import_keys),
    check(`${label}.oracle.activation.modules`, ["src/island.ts", "src/leaf.ts", "src/main.ts"], [...paths]),
    check(`${label}.oracle.activation.import`, [{ from: "src/main.ts", to: "src/leaf.ts", specifier: "./leaf" }], rows(expected.oracle.imports).map(entry => ({ from: entry.fromRelPath, to: entry.resolvedRelPath, specifier: entry.moduleSpecifier }))),
    check(`${label}.oracle.activation.call`, [{ from: "src/main.ts", caller: "main", to: "src/leaf.ts", callee: "leaf" }], rows(expected.oracle.calls).map(call => ({ from: call.callerRelPath, caller: call.callerSymbolPath, to: call.calleeRelPath, callee: call.calleeSymbolPath }))),
    ...compareExtraction(`${label}.native.extraction`, expected.oracle, record(native.raw_extraction)),
    ...compareSimpleGraph(`${label}.graph`, expected.oracle, graphWithReasons),
    ...compareSimpleGraph(`${label}.sidecar.facts`, expected.oracle, projectedFacts),
    check(`${label}.graph.node-metadata`, ordered(nodeMetadata), ordered(rows(graph.nodes).map(node => ({ kind: node.kind, path: node.filePath, name: node.name, tags: node.tags, metadata: node.metadata })))),
    check(`${label}.parallelism`, parallelism, value.parallelism),
    check(`${label}.worker.executed`, !retained, worker.executed),
    check(`${label}.worker.unsupported`, retained ? undefined : [], worker.unsupported),
    check(`${label}.worker.global-admission`, retained ? undefined : false, worker.globalAdmissionInferred),
    check(`${label}.worker.producer-artifact`, `sha256:${expected.producerSha256}`, worker.producer_artifact_id),
    check(`${label}.worker.selection`, parallelism, worker.parallelism),
    check(`${label}.worker.jobs`, retained || expected.workers === 1 ? [] : [
      { paths: ["src/island.ts"], root: expected.request.cwd, accepted: true, transportError: null, outcome: { kind: "success", exitCode: 0 } },
      { paths: ["src/leaf.ts", "src/main.ts"], root: expected.request.cwd, accepted: true, transportError: null, outcome: { kind: "success", exitCode: 0 } },
    ], rows(worker.jobs).map(job => ({ paths: list(record(job.request).emitAbsPaths).map(path => relative(String(expected.request.cwd), String(path))).sort(), root: record(job.request).repoRoot, accepted: job.responseAccepted, transportError: job.transportError, outcome: { kind: record(job.outcome).kind, exitCode: record(job.outcome).exit_code } })).sort((left, right) => JSON.stringify(left.paths).localeCompare(JSON.stringify(right.paths)))),
    ...compareExtraction(`${label}.worker.extraction`, expected.oracle, record(worker.extraction)),
    check(`${label}.sidecar.repository-scope`, { language: "repository", selectedPaths: paths, dialectVersion: undefined }, scope(sidecar.scope)),
    check(`${label}.sidecar.batches`, ordered([...kinds].map(([path, factKinds]) => ({ scope: expectedScope(path || undefined), producer, factKinds, evidenceContract: "source-lines-v1" }))), ordered(batches.map(batch => ({ scope: scope(batch.scope), producer: batch.producer, factKinds: batch.factKinds, evidenceContract: batch.evidenceContract })))),
    check(`${label}.sidecar.profiles`, ordered(expectedProfiles), ordered(profiles.map(profile => ({ scope: scope(profile.scope), factKind: profile.factKind, producer: profile.producer, evidenceContract: profile.evidenceContract, resolutionSemantics: profile.resolutionSemantics, soundnessClaim: profile.soundnessClaim, completenessClaim: profile.completenessClaim, negativeEvidenceEligible: profile.negativeEvidenceEligible, label: profile.label })))),
    check(`${label}.sidecar.results`, ordered([...kinds.keys()].map(path => ({ scope: expectedScope(path || undefined), producer, status: "completed" }))), ordered(results.map(result => ({ scope: scope(result.scope), producer: result.producer, status: result.status })))),
    check(`${label}.sidecar.batch-result-binding`, true, batches.length === kinds.size && new Set(batches.map(batch => batch.batchId)).size === kinds.size && batches.every(batch => typeof batch.batchId === "string" && results.filter(result => result.factBatchId === batch.batchId && isDeepStrictEqual(result.scope, batch.scope)).length === 1)),
    check(`${label}.sidecar.batch-profile-binding`, true, batches.every(batch => isDeepStrictEqual(ordered(list(batch.capabilityProfileIds)), ordered(profiles.filter(profile => isDeepStrictEqual(profile.scope, batch.scope)).map(profile => profile.profileId))))),
    check(`${label}.sidecar.fact-owner-scopes`, true, batches.every(batch => rows(batch.facts).every(fact => isDeepStrictEqual(record(batch.scope).selectedPaths, typeof fact.filePath === "string" ? [fact.filePath] : typeof rows(fact.evidence)[0]?.filePath === "string" ? [rows(fact.evidence)[0]!.filePath] : [])))),
    check(`${label}.ledger`, ordered(ledger), projectLedger(value.discoveryLedger)),
    check(`${label}.sidecar.ledger`, ordered(ledger), projectLedger(sidecar.discoveryLedger)),
  ];
  if (retained) properties.push(
    check(`${label}.worker.retained-selection-source`, "retained-native-Program", worker.selectionSource),
    check(`${label}.worker.retained-no-helper`, undefined, worker.helperArtifactId),
    check(`${label}.ownership.phase`, "ownership", ownership.phase),
    check(`${label}.ownership.accepted`, true, ownership.accepted),
    check(`${label}.ownership.subjects`, paths.map(path => ({ path, reasons: [] })), rows(ownership.subjects).map(subject => ({ path: subject.path, reasons: subject.reasons })).sort((left, right) => String(left.path).localeCompare(String(right.path)))),
  );
  else properties.push(check(`${label}.ownership.not-claimed`, undefined, value.ownershipObservation));
  if (!retained && expected.workers === 2) properties.push(check(`${label}.worker.helper-artifact`, `sha256:${expected.helperSha256}`, worker.helperArtifactId));
  return properties;
}

export async function applicationObservations(context: Context): Promise<{ properties: Property[]; evidence: Evidence[] }> {
  const root = resolve(context.root, "application-composition");
  const files = { "src/leaf.ts": "export function leaf() { return 1; }\n", "src/main.ts": "import { leaf } from './leaf'; export function main() { return leaf(); }\n", "src/island.ts": "export function island() { return 3; }\n" };
  for (const [path, text] of Object.entries(files)) {
    const destination = resolve(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, text);
  }
  const fixtureEvidence: Evidence[] = [];
  const gitSteps = [["init", "-q"], ["add", "--", "."], ["-c", "user.name=T00Fixture", "-c", "user.email=t00@example.test", "commit", "-qm", "application fixture"]];
  for (const [index, args] of gitSteps.entries()) {
    const argv = ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args];
    const child = Bun.spawn(argv, { cwd: root, env: { ...isolatedEnvironment(root), GIT_AUTHOR_DATE: "2026-10-23T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-23T00:00:00Z" }, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    fixtureEvidence.push(await context.save(`application-fixture-git-${index + 1}`, { argv, cwd: root, exitCode, stdout, stderr }));
    if (exitCode !== 0) throw Error(`APPLICATION_FIXTURE_GIT_FAILED:${index + 1}:${stderr}`);
  }
  const request: Json = { ...context.analysis(files), cwd: root, files: Object.fromEntries(Object.entries(files).map(([path, text]) => [resolve(root, path), text])), roots: Object.keys(files).map(path => resolve(root, path)).sort() };
  const properties: Property[] = [], evidence: Evidence[] = [...fixtureEvidence];
  for (const mode of ["qualified-retained", "ordinary"] as const) {
    const retained = mode === "qualified-retained";
    const independent = await context.extractionOracle(`application-composition-${mode}`, { files: request.files, roots: request.roots, repoRoot: root, options: request.options, retained });
    properties.push(check(`application.${mode}.oracle.exit`, 0, independent.exitCode));
    evidence.push(...independent.evidence);
    for (const workers of [1, 2] as const) {
      const selectedRequest = { ...request, qualified: retained, retained };
      const execution = await context.applicationRuntime(`application-composition-${mode}-workers-${workers}`, selectedRequest, workers);
      const compared = compareApplicationRuntime(`application.${mode}.workers-${workers}`, { mode, oracle: independent.value, request: selectedRequest, workers, producerSha256: context.producerSha256, helperSha256: context.helperSha256 }, execution);
      properties.push(...compared);
      evidence.push(...execution.evidence, await context.save(`application-composition-${mode}-workers-${workers}-comparison`, compared));
    }
  }
  const missing = await context.applicationRuntime("application-snapshot-missing", { ...request, qualified: true, retained: false }, 2);
  const incompleteFiles = { ...record(request.files) };
  delete incompleteFiles[resolve(root, "src/main.ts")];
  const mismatch = await context.applicationRuntime("application-snapshot-mismatch", { ...request, files: incompleteFiles, qualified: true, retained: true }, 2);
  const refused = [
    ...compareApplicationRefusal("application.snapshot.missing", "SOURCE_SNAPSHOT_REQUIRED: qualified analysis requires retained source and configuration inputs", missing),
    ...compareApplicationRefusal("application.snapshot.mismatch", "SOURCE_SNAPSHOT_MISMATCH: src/main.ts", mismatch),
  ];
  properties.push(...refused);
  evidence.push(...missing.evidence, ...mismatch.evidence, await context.save("application-snapshot-refusals-comparison", refused));
  return { properties, evidence };
}

export function compareApplicationRefusal(label: string, error: string, execution: Execution): Property[] {
  let stderr: unknown;
  try { stderr = JSON.parse(execution.stderr) as unknown; } catch { stderr = execution.stderr; }
  return [check(`${label}.exit`, 1, execution.exitCode), check(`${label}.stdout`, "", execution.stdout), check(`${label}.error`, { error }, stderr)];
}

export type DynamicApplicationExpectation = { fixture?: { sourcePath: string; testPath: string; language: "typescript" | "javascript" }; outcome: "composed" | "ownership-refused"; oracle: Json; keys: readonly string[]; integrityReasons: Json; ledgerReasons: Readonly<Record<string, readonly string[]>> | undefined; failedPaths?: readonly string[]; coverage: readonly string[]; producerSha256: string };

const dynamicFixture = (expected: DynamicApplicationExpectation) => expected.fixture ?? { sourcePath: "src/main.ts", testPath: "src/main.test.ts", language: "typescript" as const };

function compareDynamicGraph(label: string, expected: DynamicApplicationExpectation, graph: Json, integrityReasons: unknown, excludedPaths: readonly string[] = []): Property[] {
  const nodes = rows(graph.nodes), edges = rows(graph.edges);
  const modulePaths = list(expected.oracle.modules).map(String).sort();
  const fixture = dynamicFixture(expected);
  const included = (path: unknown): boolean => typeof path === "string" && !excludedPaths.includes(path);
  const graphOracle = { ...expected.oracle, modules: modulePaths.filter(included), symbols: rows(expected.oracle.symbols).filter(symbol => included(symbol.relPath)), imports: rows(expected.oracle.imports).filter(entry => included(entry.fromRelPath) && (entry.resolvedRelPath === undefined || included(entry.resolvedRelPath))), calls: rows(expected.oracle.calls).filter(call => included(call.callerRelPath) && (call.calleeRelPath === undefined || included(call.calleeRelPath))) };
  const roleNodes = modulePaths.filter(included).map(path => ({ kind: path === fixture.testPath ? "test" : "module", filePath: path, name: path.split("/").at(-1), evidence: [{ filePath: path, sourceKind: path === fixture.testPath ? "test" : "code" }] }));
  const normalized = {
    ...graph,
    nodes: nodes.map(node => node.kind === "test" ? { ...node, kind: "module", evidence: rows(node.evidence).map(evidence => ({ ...evidence, sourceKind: "code" })) } : node),
    edges: edges.filter(edge => edge.kind !== "tested_by" && edge.kind !== "covers"),
    integrityReasons,
  };
  return [
    check(`${label}.fixture-modules`, [fixture.sourcePath, fixture.testPath].sort(), modulePaths),
    check(`${label}.original-role-nodes`, ordered(roleNodes), ordered(nodes.filter(node => node.kind === "module" || node.kind === "test").map(node => ({ kind: node.kind, filePath: node.filePath, name: node.name, evidence: node.evidence })))),
    ...compareSimpleGraph(`${label}.core`, graphOracle, normalized).map(property => property.name === `${label}.core.integrity-reasons` ? check(property.name, expected.integrityReasons, integrityReasons) : property),
    ...compareTestRelations(label, [...expected.coverage], graph, { path: fixture.testPath, line: 1 }),
  ];
}

export function compareDynamicApplication(label: string, expected: DynamicApplicationExpectation, execution: Execution): Property[] {
  const composed = expected.outcome === "composed";
  let errorReport: Json;
  try { errorReport = record(JSON.parse(execution.stderr) as unknown); } catch { errorReport = {}; }
  const value = composed ? execution.value : record(errorReport.diagnosticAssembly);
  const graph = record(record(value.analysis).graph), sidecar = record(value.sidecar), native = record(value.nativeObservation), worker = record(value.workerObservation);
  const paths = list(expected.oracle.modules).map(String).sort();
  const fixture = dynamicFixture(expected);
  const failedPaths = expected.failedPaths ?? [];
  const analyzedPaths = paths.filter(path => !failedPaths.includes(path));
  const localLedger = rows(sidecar.discoveryLedger).filter(entry => record(entry.scope).language === fixture.language);
  const localProfiles = rows(sidecar.capabilityProfiles).filter(profile => record(profile.scope).language === fixture.language);
  const facts = rows(sidecar.factBatches).flatMap(batch => rows(batch.facts));
  const properties = [
    check(`${label}.exit`, composed ? 0 : 1, execution.exitCode),
    check(`${label}.assembly.available`, true, Array.isArray(graph.nodes) && Array.isArray(graph.edges) && Array.isArray(sidecar.factBatches) && Array.isArray(sidecar.discoveryLedger)),
    check(`${label}.integrity`, expected.integrityReasons, value.integrityReasons),
    check(`${label}.native.compiler`, "7.1.0-dev", native.native_compiler_version),
    check(`${label}.native.revision`, "780dc512d64f40afebffa6a7028207649fb7ed1c", native.engine_revision),
    check(`${label}.native.sdk`, "7.1.0-dev", native.sdk_version),
    check(`${label}.native.complete`, true, native.complete),
    check(`${label}.native.producer-artifact`, `sha256:${expected.producerSha256}`, native.producer_artifact_id),
    check(`${label}.native.dynamic-keys`, [...expected.keys], native.test_dynamic_import_keys),
    ...compareExtraction(`${label}.native.extraction`, expected.oracle, record(native.raw_extraction)),
    ...compareExtraction(`${label}.retained.extraction`, expected.oracle, record(worker.extraction)),
    ...compareDynamicGraph(`${label}.graph`, expected, graph, value.integrityReasons),
    check(`${label}.sidecar.fact-types`, true, facts.every(fact => fact.factType === "node" || fact.factType === "edge")),
    ...compareDynamicGraph(`${label}.sidecar`, expected, { nodes: facts.filter(fact => fact.factType === "node"), edges: facts.filter(fact => fact.factType === "edge") }, value.integrityReasons, failedPaths),
    check(`${label}.sidecar.local-${fixture.language}-scopes`, ordered(paths.map(path => ({ selectedPaths: [path], selectionDecision: "selected", analysisOutcome: failedPaths.includes(path) ? "failed" : "analyzed" }))), ordered(localLedger.map(entry => ({ selectedPaths: record(entry.scope).selectedPaths, selectionDecision: entry.selectionDecision, analysisOutcome: entry.analysisOutcome })))),
    check(`${label}.sidecar.local-${fixture.language}-reasons-included`, true, localLedger.every(entry => Array.isArray(entry.analysisReasons) && entry.analysisReasons.every(reason => typeof reason === "string") && list(expected.integrityReasons[String(list(record(entry.scope).selectedPaths)[0])]).every(reason => list(entry.analysisReasons).includes(reason)))),
    check(`${label}.sidecar.independent-exact-reasons-available`, true, expected.ledgerReasons !== undefined),
    check(`${label}.sidecar.profiles.present-nonnegative`, true, analyzedPaths.every(path => localProfiles.some(profile => isDeepStrictEqual(record(profile.scope).selectedPaths, [path]))) && localProfiles.every(profile => profile.negativeEvidenceEligible === false && list(record(profile.scope).selectedPaths).every(path => analyzedPaths.includes(String(path))))),
    check(`${label}.sidecar.refusal-partial-explicit`, true, composed || (failedPaths.includes(fixture.testPath) ? localLedger.some(entry => isDeepStrictEqual(record(entry.scope).selectedPaths, [fixture.testPath]) && entry.analysisOutcome === "failed") : localProfiles.some(profile => isDeepStrictEqual(record(profile.scope).selectedPaths, [fixture.testPath]) && profile.completenessClaim === "partial" && profile.label === "partial"))),
    check(`${label}.sidecar.no-${fixture.language === "typescript" ? "javascript" : "typescript"}-scope`, false, rows(sidecar.discoveryLedger).some(entry => record(entry.scope).language === (fixture.language === "typescript" ? "javascript" : "typescript"))),
    check(`${label}.retained.selection`, { requested: 2, used: 1, mode: "preflight-fallback", reason: "retained compiler input snapshot requires one semantic Program" }, worker.parallelism),
    check(`${label}.retained.worker-not-executed`, false, worker.executed),
    check(`${label}.retained.selection-source`, "retained-native-Program", worker.selectionSource),
    check(`${label}.retained.jobs`, [], worker.jobs),
    check(`${label}.retained.no-helper`, undefined, worker.helperArtifactId),
  ];
  if (expected.ledgerReasons !== undefined) properties.push(check(`${label}.sidecar.local-${fixture.language}-reasons-exact`, ordered(paths.map(path => ({ selectedPaths: [path], analysisReasons: expected.ledgerReasons?.[path] ?? [] }))), ordered(localLedger.map(entry => ({ selectedPaths: record(entry.scope).selectedPaths, analysisReasons: entry.analysisReasons })))));
  if (composed) properties.push(
    check(`${label}.composed.executed`, true, value.executed),
    check(`${label}.composed.stderr`, "", execution.stderr),
    check(`${label}.composed.ownership`, true, record(value.ownershipObservation).accepted),
    check(`${label}.composed.ownership-phase`, "ownership", record(value.ownershipObservation).phase),
    check(`${label}.composed.final-revalidated`, true, value.finalReceiptRevalidated),
  );
  else properties.push(
    check(`${label}.refusal.stage`, "application-composition-refused", value.stage),
    check(`${label}.refusal.stdout`, "", execution.stdout),
    check(`${label}.refusal.reason`, true, typeof errorReport.error === "string" && errorReport.error.includes("RefusalHasNoOwnership") && !errorReport.error.includes("graph differs")),
    check(`${label}.refusal.final-not-revalidated`, false, errorReport.finalReceiptRevalidated),
    check(`${label}.refusal.no-ownership-context`, undefined, value.ownershipObservation),
  );
  return properties;
}
