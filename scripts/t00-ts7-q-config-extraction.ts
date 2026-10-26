import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CampaignContext, Evidence, ObligationResult } from "./t00-ts7-q-config-campaign";

type Row = Record<string, unknown>;
type Extraction = { modules: string[]; symbols: Row[]; imports: Row[]; calls: Row[] };
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
export function workerProjection(value: unknown, emit: string[]): Extraction {
  const source = record(value);
  const allowed = new Set(emit);
  const local = (value: unknown): boolean => typeof value === "string" && !value.startsWith("../") && !value.startsWith("/");
  return {
    modules: Array.isArray(source["modules"]) ? source["modules"].filter((item): item is string => typeof item === "string" && allowed.has(item)) : [],
    symbols: rows(source["symbols"]).filter(item => allowed.has(String(item["relPath"]))),
    imports: rows(source["imports"]).filter(item => allowed.has(String(item["fromRelPath"]))).map(item => ({ fromRelPath: item["fromRelPath"], moduleSpecifier: item["moduleSpecifier"], ...(local(item["resolvedRelPath"]) ? { resolvedRelPath: item["resolvedRelPath"] } : {}), names: item["names"], line: item["line"] })),
    calls: rows(source["calls"]).filter(item => allowed.has(String(item["callerRelPath"]))).map(item => ({ callerRelPath: item["callerRelPath"], ...(item["callerSymbolPath"] === undefined ? {} : { callerSymbolPath: item["callerSymbolPath"] }), calleeName: item["calleeName"], ...(local(item["calleeRelPath"]) ? { calleeRelPath: item["calleeRelPath"] } : {}), ...(item["calleeSymbolPath"] === undefined ? {} : { calleeSymbolPath: item["calleeSymbolPath"] }), line: item["line"] })),
  };
}

export function graphProjection(loaded: string[], roots: string[], usages: Row[]): Row {
  const loadedRepositorySources = loaded.filter(path => !path.startsWith("../") && !path.startsWith("/") && !path.split("/").includes("node_modules")).sort();
  const selectedRoots = roots.filter(path => !/\.d\.(?:ts|mts|cts)$/.test(path)).sort();
  if (selectedRoots.some(path => !loadedRepositorySources.includes(path))) throw Error("Selected root outside loaded repository graph");
  const edges = [...new Map(usages.filter(item => loadedRepositorySources.includes(String(item["fromRelPath"])) && loadedRepositorySources.includes(String(item["resolvedRelPath"]))).map(item => {
    const edge = { from: String(item["fromRelPath"]), specifier: String(item["moduleSpecifier"]), to: String(item["resolvedRelPath"]) };
    return [JSON.stringify(edge), edge] as const;
  })).values()].sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : a.specifier < b.specifier ? -1 : a.specifier > b.specifier ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0);
  const reaches = (start: string): Set<string> => {
    const visited = new Set([start]);
    const pending = [start];
    while (pending.length) {
      const current = pending.pop()!;
      for (const edge of edges) {
        const next = edge.from === current ? edge.to : edge.to === current ? edge.from : undefined;
        if (next !== undefined && !visited.has(next)) { visited.add(next); pending.push(next); }
      }
    }
    return visited;
  };
  const grouped = new Set<string>();
  const dependencyComponents = selectedRoots.flatMap(start => {
    if (grouped.has(start)) return [];
    const connected = reaches(start);
    const group = selectedRoots.filter(path => connected.has(path));
    group.forEach(path => grouped.add(path));
    return [group];
  });
  return { loadedRepositorySources, selectedRoots, dependencyComponents, resolvedEdges: edges };
}

export function extractionMatches(actual: Row, expected: Extraction): boolean {
  return actual["executed"] === true && isDeepStrictEqual(actual["unsupported"], []) && expected.modules.length > 0 && isDeepStrictEqual(actual["extraction"], expected);
}

export function contextRootChangesCallTarget(retained: unknown, omitted: unknown): boolean {
  const contextCalls = (calls: unknown): Row[] => rows(calls).filter(item => item["callerRelPath"] === "main.ts" && item["calleeName"] === "contextHelper");
  const known = contextCalls(retained), unknown = contextCalls(omitted);
  return known.length === 1 && unknown.length === 1 && known[0]!["calleeRelPath"] === "context.ts" && known[0]!["calleeSymbolPath"] === "contextHelper" && unknown[0]!["calleeRelPath"] === undefined && unknown[0]!["calleeSymbolPath"] === undefined;
}

type Definition = { index: number; id: string; properties: string[] };
type Capture = { value: Row; exitCode: number; evidence: Evidence[] };
export const extractionIndices = new Set([193, 194, 210, 211, 212, 213, 239]);
function save(path: string, value: unknown, raw = false): Evidence {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = Buffer.from(raw ? String(value) : JSON.stringify(value, null, 2) + "\n");
  writeFileSync(path, bytes);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

class ExtractionWitnesses {
  readonly directory: string;
  readonly cache = new Map<string, Promise<{ pass: boolean; evidence: Evidence[]; reason: string }>>();
  constructor(readonly ctx: CampaignContext) { this.directory = resolve(ctx.out, "extraction-workers"); }
  fixture(name: string, texts: Record<string, string>) {
    const root = resolve(this.directory, name, "repository");
    const files = Object.fromEntries(Object.entries(texts).map(([path, text]) => [resolve(root, path), text]));
    return { root, files, evidence: Object.entries(files).map(([path, text]) => save(path, text, true)) };
  }
  async observe(name: string, mode: string | null, request: unknown): Promise<Capture> {
    const input = save(resolve(this.directory, name + ".request.json"), request);
    const output = await this.ctx.run("extraction-" + name, [this.ctx.producer, ...(mode === null ? [] : [mode]), input.path, ...([null, "--extract-worker", "--extract-parallel"].includes(mode) ? [this.ctx.sdk] : []), ...(mode === "--extract-parallel" ? [this.ctx.helper] : [])]);
    if (output.exitCode < 0) throw Error("Technical extraction process failure: " + name);
    let value: Row;
    try { value = record(JSON.parse(output.stdout) as unknown); } catch { value = {}; }
    return { ...output, value, evidence: [input, ...output.evidence] };
  }
  async oracle(name: string, root: string, files: Record<string, string>, roots: string[]): Promise<Capture> {
    const request = save(resolve(this.directory, name + ".oracle-request.json"), { repoRoot: root, files, roots, retained: false });
    const output = await this.ctx.run("extraction-oracle-" + name, [this.ctx.extractionOracle!, request.path, this.ctx.sdk]);
    if (output.exitCode < 0) throw Error("Technical extraction oracle failure: " + name);
    let value: Row;
    try { value = record(JSON.parse(output.stdout) as unknown); } catch { value = {}; }
    return { ...output, value, evidence: [request, ...output.evidence] };
  }
  once(name: string, action: () => Promise<{ pass: boolean; evidence: Evidence[]; reason: string }>) {
    if (!this.cache.has(name)) this.cache.set(name, action());
    return this.cache.get(name)!;
  }
  matrix() {
    return this.once("matrix", async () => {
      let pass = true;
      const evidence: Evidence[] = [];
      const specifications: { name: string; roots: string[]; texts: Record<string, string> }[] = [
        { name: "disconnected", roots: ["a.ts", "b.ts", "globals.d.ts", "y.ts", "z.ts"], texts: { "a.ts": "import { z } from './z';\nexport function a() { return z(); }\n", "z.ts": "export function z() { return 1; }\n", "b.ts": "import { y } from './y';\nexport function b() { return y(); }\n", "y.ts": "export function y() { return 2; }\n", "globals.d.ts": "interface WorkerContext { value: number }\n", "unselected.ts": "export function unselected() { return 99; }\n" } },
        { name: "cycle", roots: ["a.ts", "b.ts", "globals.d.ts"], texts: { "a.ts": "import { b } from './b';\nexport function a() { return b(); }\n", "b.ts": "import { a } from './a';\nexport function b() { return a(); }\n", "globals.d.ts": "interface WorkerContext { value: number }\n" } },
        { name: "nonroot-bridge", roots: ["a.ts", "b.ts", "isolated.ts"], texts: { "a.ts": "import { bridge } from './bridge';\nexport function a() { return bridge(); }\n", "b.ts": "import { bridge } from './bridge';\nexport function b() { return bridge(); }\n", "bridge.ts": "export function bridge() { return 3; }\n", "isolated.ts": "export function isolated() { return 4; }\n" } },
        { name: "resolution-modes", roots: ["a.mts", "b.cts", "isolated.ts"], texts: { "a.mts": "import type { Context } from './context' with { 'resolution-mode': 'import' };\nexport function a() { return import('./bridge'); }\n", "b.cts": "import bridge = require('./bridge');\nexport function b() { return bridge.bridge(); }\n", "bridge.ts": "export function bridge() { return 5; }\n", "context.d.ts": "export interface Context { value: number }\n", "isolated.ts": "export function isolated() { return 6; }\n" } },
      ];
      for (const spec of specifications) {
        const fixture = this.fixture(spec.name, spec.texts);
        const roots = spec.roots.map(path => resolve(fixture.root, path));
        const oracle = await this.oracle(spec.name, fixture.root, fixture.files, roots);
        const loaded = Array.isArray(oracle.value["loadedFiles"]) ? oracle.value["loadedFiles"].filter((path): path is string => typeof path === "string").map(path => path.startsWith(fixture.root + "/") ? path.slice(fixture.root.length + 1) : path) : [];
        let graph: Row = {};
        try { graph = graphProjection(loaded, spec.roots, rows(oracle.value["resolvedModuleSpecifiers"])); } catch { pass = false; }
        const expected = workerProjection(oracle.value, spec.roots.filter(path => !/\.d\.(?:ts|mts|cts)$/.test(path)));
        const expectedEvidence = save(resolve(this.directory, spec.name + ".expected.json"), { extraction: expected, graph });
        const serial = await this.observe(spec.name + "-one", "--extract-parallel", { repoRoot: fixture.root, rootAbsPaths: roots, workers: 1 });
        const parallel = await this.observe(spec.name + "-two", "--extract-parallel", { repoRoot: fixture.root, rootAbsPaths: roots, workers: 2 });
        const components = Array.isArray(graph["dependencyComponents"]) ? graph["dependencyComponents"].length : 0;
        const expectedSelection = components > 1 ? { requested: 2, used: 2, mode: "parallel" } : { requested: 2, used: 1, mode: "single", reason: "TypeScript root module graph has one connected component" };
        const program = await this.observe(spec.name + "-program", null, { id: "extraction-" + spec.name, cwd: fixture.root, sdk_directory: "/sdk/lib", case_sensitive: this.ctx.platform === "linux", roots, files: fixture.files, retained: false, qualified: false, options: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "Preserve", allowJs: true, skipLibCheck: true, noEmit: true, strict: false } });
        const observedGraph = record(program.value["partitionObservation"]);
        const graphPass = program.exitCode === 0 && program.value["complete"] === true && observedGraph["executed"] === true && isDeepStrictEqual(observedGraph["unsupported"], []) && Object.entries(graph).every(([key, value]) => isDeepStrictEqual(observedGraph[key], value));
        const factful = expected.symbols.length > 0 && expected.calls.length > 0 && (spec.name === "cycle" || expected.imports.length > 0);
        const usages = rows(oracle.value["resolvedModuleSpecifiers"]);
        const importUsage = usages.find(item => item["fromRelPath"] === "a.mts" && item["moduleSpecifier"] === "./context");
        const requireUsage = usages.find(item => item["fromRelPath"] === "b.cts" && item["moduleSpecifier"] === "./bridge");
        const modes = spec.name !== "resolution-modes" || (importUsage !== undefined && requireUsage !== undefined && importUsage["resolvedRelPath"] === "context.d.ts" && requireUsage["resolvedRelPath"] === "bridge.ts" && typeof importUsage["resolutionMode"] === "string" && typeof requireUsage["resolutionMode"] === "string" && importUsage["resolutionMode"] !== requireUsage["resolutionMode"]);
        const oraclePass = oracleSucceeded(oracle) && loaded.length > 0 && modes;
        const comparison = { oracle: oraclePass, nonempty: factful, serial: serial.exitCode === 0 && extractionMatches(serial.value, expected), parallel: parallel.exitCode === 0 && extractionMatches(parallel.value, expected), selection: isDeepStrictEqual(parallel.value["parallelism"], expectedSelection), serialSelection: isDeepStrictEqual(serial.value["parallelism"], { requested: 1, used: 1, mode: "single" }), graph: graphPass, modes, components };
        const casePass = comparison.oracle && comparison.nonempty && comparison.serial && comparison.parallel && comparison.selection && comparison.serialSelection && comparison.graph;
        pass &&= casePass;
        evidence.push(...fixture.evidence, ...oracle.evidence, ...serial.evidence, ...parallel.evidence, ...program.evidence, expectedEvidence, save(resolve(this.directory, spec.name + ".comparisons.json"), { ...comparison, pass: casePass }));
      }
      return { pass, evidence, reason: "TS7 Program order and complete nonempty ordinary extraction for workers 1/2; independent contract graphs exercise disconnected declarations, cycles, loaded nonroots, import-type import mode, require mode and dynamic imports." };
    });
  }
  boundaries() {
    return this.once("boundaries", async () => {
      const fixture = this.fixture("root-boundaries", { "a.ts": "export function a() { return 1; }\n", "node_modules/pkg/index.ts": "export function dependency() { return 2; }\n", "../outside.ts": "export function outside() { return 3; }\n" });
      const evidence = [...fixture.evidence];
      let pass = true;
      for (const [name, badRoot] of [["outside", "../outside.ts"], ["node-modules", "node_modules/pkg/index.ts"]] as const) {
        const roots = [resolve(fixture.root, "a.ts"), resolve(fixture.root, badRoot)];
        const oracle = await this.oracle("root-" + name, fixture.root, fixture.files, roots);
        const observed = await this.observe("root-" + name, "--extract-parallel", { repoRoot: fixture.root, rootAbsPaths: roots, workers: 2 });
        const loadedFiles = oracle.value["loadedFiles"];
        const loaded = Array.isArray(loadedFiles) && roots.every(path => loadedFiles.includes(path));
        let match = oracleSucceeded(oracle) && loaded;
        if (name === "outside") {
          const unsupported = observed.value["unsupported"];
          match &&= observed.exitCode === 0 && observed.value["executed"] === false && observed.value["extraction"] === undefined && isDeepStrictEqual(observed.value["jobs"], []) && Array.isArray(unsupported) && unsupported.length > 0 && unsupported.every(item => typeof item === "string" && (item.includes("source outside repository:") || item.includes("SOURCE_LINK_OUTSIDE_REPOSITORY:")));
        } else {
          const expected = workerProjection(oracle.value, ["a.ts", badRoot]);
          match &&= observed.exitCode === 0 && extractionMatches(observed.value, expected) && isDeepStrictEqual(observed.value["parallelism"], { requested: 2, used: 1, mode: "preflight-fallback", reason: "extraction root is outside the repository module graph boundary" });
          evidence.push(save(resolve(this.directory, "root-" + name + ".expected.json"), { extraction: expected, mode: "preflight-fallback", used: 1, reason: "extraction root is outside the repository module graph boundary" }));
        }
        pass &&= match;
        evidence.push(...oracle.evidence, ...observed.evidence, save(resolve(this.directory, "root-" + name + ".comparisons.json"), { loaded, match, contract: name === "outside" ? "assertConfinedTypeScriptSources runs before preflight and rejects external roots" : "preflight callback rejects node_modules selected root and chooses serial fallback" }));
      }
      return { pass, evidence, reason: "Independent TS7 loads both selected roots; public extraction refuses the external root before dispatch (source confinement precedes preflight), while the node_modules root triggers the precise graph-boundary fallback and complete serial extraction." };
    });
  }
  worker() {
    return this.once("worker", async () => {
      const fixture = this.fixture("worker", { "main.ts": "import { leaf } from './leaf';\nexport function main() { return leaf() + contextHelper() + Math.abs(-1); }\n", "leaf.ts": "export function leaf() { return 1; }\n", "context.ts": "function contextHelper() { return 2; }\n" });
      const roots = [resolve(fixture.root, "main.ts"), resolve(fixture.root, "leaf.ts"), resolve(fixture.root, "context.ts")];
      const request = { schemaVersion: 1, jobId: "extraction-worker", repoRoot: fixture.root, rootAbsPaths: roots, emitAbsPaths: roots };
      const oracle = await this.oracle("worker", fixture.root, fixture.files, roots);
      const evidence = [...fixture.evidence, ...oracle.evidence];
      let pass = oracleSucceeded(oracle);
      let retainedContextCalls: unknown;
      for (const [name, emit] of [["all", ["main.ts", "leaf.ts", "context.ts"]], ["subset", ["main.ts"]], ["empty", []]] as const) {
        const expected = workerProjection(oracle.value, [...emit]);
        const observed = await this.observe("worker-" + name, "--extract-worker", { ...request, emitAbsPaths: emit.map(path => resolve(fixture.root, path)) });
        const capability = record(observed.value["frontendCapabilityObservation"]);
        const match = observed.exitCode === 0 && observed.value["ok"] === true && isDeepStrictEqual(observed.value["extraction"], expected) && capability["executed"] === true && isDeepStrictEqual(capability["unsupported"], []) && rows(capability["roots"]).length === 3 && rows(capability["roots"]).every(item => item["loaded"] === true && isDeepStrictEqual(item["parseDiagnosticCodes"], []));
        if (name === "subset") retainedContextCalls = record(observed.value["extraction"])["calls"];
        pass &&= match;
        evidence.push(...observed.evidence, save(resolve(this.directory, "worker-" + name + ".expected.json"), expected), save(resolve(this.directory, "worker-" + name + ".comparisons.json"), { match }));
      }
      const omittedRoots = roots.filter(path => path !== resolve(fixture.root, "context.ts"));
      const omittedOracle = await this.oracle("worker-context-omitted", fixture.root, fixture.files, omittedRoots);
      const omittedWorker = await this.observe("worker-context-omitted", "--extract-worker", { ...request, rootAbsPaths: omittedRoots, emitAbsPaths: [resolve(fixture.root, "main.ts")] });
      const omittedExpected = workerProjection(omittedOracle.value, ["main.ts"]);
      const omittedCapability = record(omittedWorker.value["frontendCapabilityObservation"]);
      const oracleContext = contextRootChangesCallTarget(oracle.value["calls"], omittedOracle.value["calls"]);
      const workerContext = contextRootChangesCallTarget(retainedContextCalls, record(omittedWorker.value["extraction"])["calls"]);
      const contextPass = oracleSucceeded(omittedOracle) && oracleContext && workerContext && omittedWorker.exitCode === 0 && omittedWorker.value["ok"] === true && isDeepStrictEqual(omittedWorker.value["extraction"], omittedExpected) && omittedCapability["executed"] === true && isDeepStrictEqual(omittedCapability["unsupported"], []) && rows(omittedCapability["roots"]).length === 2 && rows(omittedCapability["roots"]).every(item => item["loaded"] === true && isDeepStrictEqual(item["parseDiagnosticCodes"], []));
      pass &&= contextPass;
      evidence.push(...omittedOracle.evidence, ...omittedWorker.evidence, save(resolve(this.directory, "worker-context-omitted.expected.json"), omittedExpected), save(resolve(this.directory, "worker-context.comparisons.json"), { oracleContext, workerContext, contextPass }));
      const sdkCall = rows(oracle.value["calls"]).some(item => item["calleeName"] === "abs");
      pass &&= sdkCall;
      let emissionPass = true;
      for (const target of ["../outside.ts", "/outside.ts", "leaf.ts"]) {
        const extraction = { modules: oracle.value["modules"], symbols: oracle.value["symbols"], imports: rows(oracle.value["imports"]).map(item => ({ ...item, resolvedRelPath: target })), calls: rows(oracle.value["calls"]).map(item => ({ ...item, calleeRelPath: target })) };
        const expected = workerProjection(extraction, ["main.ts"]);
        const name = target === "leaf.ts" ? "local" : target.startsWith("../") ? "relative-external" : "absolute-external";
        const observed = await this.observe("worker-emission-" + name, "--observe-worker-emission", { extraction, repoRoot: fixture.root, emitAbsPaths: [resolve(fixture.root, "main.ts")] });
        const match = observed.exitCode === 0 && observed.value["executed"] === true && isDeepStrictEqual(observed.value["unsupported"], []) && observed.value["observationScope"] === "worker_emit_root_projection" && isDeepStrictEqual(observed.value["extraction"], expected);
        emissionPass &&= match;
        evidence.push(...observed.evidence, save(resolve(this.directory, "worker-emission-" + name + ".expected.json"), expected));
      }
      pass &&= emissionPass;
      for (const [key, value] of [["schemaVersion", 2], ["jobId", 3], ["repoRoot", []], ["rootAbsPaths", [false]], ["emitAbsPaths", null]] as const) {
        const observed = await this.observe("worker-malformed-" + key, "--extract-worker", { ...request, [key]: value });
        pass &&= observed.exitCode === 0 && observed.value["schemaVersion"] === 1 && observed.value["jobId"] === "unbound" && observed.value["ok"] === false && observed.value["error"] === "malformed extraction request" && observed.value["extraction_started"] === false;
        evidence.push(...observed.evidence);
      }
      const missing = await this.observe("worker-caught-missing", "--extract-worker", { ...request, rootAbsPaths: [resolve(fixture.root, "missing.ts")], emitAbsPaths: [resolve(fixture.root, "missing.ts")] });
      pass &&= missing.exitCode === 0 && missing.value["ok"] === false && missing.value["jobId"] === request.jobId && missing.value["error"] === "SOURCE_SNAPSHOT_MISSING: missing.ts" && missing.value["extraction_started"] === false && missing.value["extraction"] === undefined;
      evidence.push(...missing.evidence);
      const response = { schemaVersion: 1, jobId: request.jobId, ok: true, extraction: { modules: ["main.ts", "leaf.ts", "context.ts"], symbols: [], imports: [], calls: [] } };
      const controls = [{ name: "valid", response, expected: { valid: true, accepted: true, worker_failed: false } }, { name: "identity", response: { ...response, jobId: "foreign" }, expected: { valid: false, accepted: false, worker_failed: false } }, { name: "failure", response: { schemaVersion: 1, jobId: request.jobId, ok: false, error: "controlled failure" }, expected: { valid: true, accepted: false, worker_failed: true } }];
      for (const control of controls) {
        const observed = await this.observe("parent-" + control.name, "--consume-worker", { request, response: control.response });
        pass &&= observed.exitCode === 0 && Object.entries(control.expected).every(([key, value]) => observed.value[key] === value);
        evidence.push(...observed.evidence);
      }
      evidence.push(save(resolve(this.directory, "worker.comparisons.json"), { pass, sdkCall, emissionPass, contextPass, projectionScope: "Real TS7 facts feed the owning emit-root projection; external path variants are controlled DTO inputs, not reachable worker filesystem inputs." }));
      return { pass, evidence, reason: "Complete independent TS7 ordinary worker sets, all/subset/empty emission and independent global-root target-present/target-absent context controls, malformed/caught errors and parent DTO controls; controlled external/local targets exercise the actual owning emit-root projection, separately from filesystem worker invocation." };
    });
  }
}

function oracleSucceeded(capture: Capture): boolean {
  return capture.exitCode === 0 && capture.value["compilerVersion"] === "7.1.0-dev" && capture.value["revision"] === "780dc512d64f40afebffa6a7028207649fb7ed1c" && capture.value["sdkLibraries"] === 115 && ["modules", "symbols", "imports", "calls", "loadedFiles", "resolvedModuleSpecifiers"].every(key => Array.isArray(capture.value[key]));
}

export async function runExtractionWorkers(ctx: CampaignContext, definitions: Definition[]): Promise<ObligationResult[]> {
  const witnesses = new ExtractionWitnesses(ctx);
  const results: ObligationResult[] = [];
  for (const definition of definitions.filter(item => extractionIndices.has(item.index))) {
    const started = performance.now();
    if (ctx.extractionOracle === undefined) {
      results.push({ index: definition.index, id: definition.id, status: "not_qualified", reason: "Missing candidate-bound independent TS7 extraction oracle", properties: definition.properties.map(property => ({ property, status: "not_qualified", reason: "Missing candidate-bound independent TS7 extraction oracle" })), evidence: [], durationMs: 0 });
      continue;
    }
    const observations = definition.index === 239 ? [await witnesses.worker()] : definition.index === 194 ? [await witnesses.matrix(), await witnesses.boundaries()] : [await witnesses.matrix()];
    const pass = observations.every(item => item.pass);
    const reason = observations.map(item => item.reason).join(" ");
    results.push({ index: definition.index, id: definition.id, status: pass ? "qualified" : "not_qualified", reason, properties: definition.properties.map(property => ({ property, status: pass ? "pass" : "fail", reason })), evidence: [...new Map(observations.flatMap(item => item.evidence).map(item => [item.path, item])).values()], durationMs: Math.round(performance.now() - started) });
  }
  return results;
}
