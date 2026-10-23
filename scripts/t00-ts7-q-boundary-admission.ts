import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Context, Evidence, Execution, Json, Observation, Property } from "./t00-ts7-q-boundary-common";
import { receiptGuardObservations } from "./t00-ts7-q-boundary-refusals";
import { baseObservations } from "./t00-ts7-q-boundary-base";
import { isolatedEnvironment } from "./t00-ts7-q-boundary-common";

type AdmissionExpectation = { status: "admitted" | "rejected"; coverage: { path: string; status: string }[]; reasonPrefix?: string; reasons?: string[] };
type ScopeCase = { id: string; files: Record<string, string>; status: "admitted" | "rejected"; coverage?: { path: string; status: string }[]; reasonPrefix?: string; reasons?: string[]; oracleClean?: boolean };
const contract = "ADR 0035 (accepted), admission/scope decision; TS7 contract requalification limits; owner brief 2026-10-23";
const record = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const property = (name: string, expected: unknown, actual: unknown, oracle = contract): Property => ({ name, expected, actual, pass: isDeepStrictEqual(expected, actual), oracle });

export function ts5WitnessSdk(context: Pick<Context, "sdk" | "sdk5">): Json | undefined {
  const sdk = context.sdk5 ?? (context.sdk["version"] === "5.9.3" ? context.sdk : undefined);
  return sdk?.["version"] === "5.9.3" && Object.keys(record(sdk["files"])).length === 100 ? sdk : undefined;
}

export function compareAdmission(label: string, expected: AdmissionExpectation, execution: Execution): Property[] {
  const report = execution.value, admission = record(report["analysisAdmission"]), coverage = record(admission["changeCoverage"]);
  const reasons = admission["reasons"];
  return [
    property(`${label}.exit`, expected.status === "admitted" ? 0 : 3, execution.exitCode),
    property(`${label}.status`, expected.status, admission["status"]),
    property(`${label}.verdict`, expected.status === "admitted" ? "NOT_ASSERTED" : "BLOCK", report["verdict"]),
    property(`${label}.coverage.expected`, expected.coverage.map(file => file.path).sort(), list(coverage["expected"]).toSorted()),
    property(`${label}.coverage.files`, expected.coverage, coverage["files"]),
    property(`${label}.reasons.structured`, true, Array.isArray(reasons) && reasons.every(reason => typeof reason === "string")),
    property(`${label}.reasons.required`, true, Array.isArray(reasons) && (expected.status === "admitted" ? reasons.length === 0 : reasons.length > 0 && (expected.reasonPrefix === undefined || reasons.some(reason => typeof reason === "string" && reason.startsWith(expected.reasonPrefix!))))),
    property(`${label}.globalAdmission`, false, report["global_admission_inferred"]),
    ...(expected.reasons === undefined ? [] : [property(`${label}.reasons.exact`, expected.reasons.toSorted(), Array.isArray(reasons) ? reasons.toSorted() : reasons)]),
  ];
}

export function compareTs5Warning(label: string, execution: Execution): Property[] {
  let lines: unknown;
  try { lines = execution.stderr.trim().split("\n").map(line => JSON.parse(line) as unknown); }
  catch { lines = execution.stderr; }
  return [property(`${label}.warning`, [{ code: "TS5_DEGRADED_ANALYSIS", severity: "warning", message: "Projet TypeScript 5 analysé avec ts_goport 7.1.0-dev ; compatibilité TS5 non garantie et admission qualifiée indisponible" }], lines, "contract-ts7.md: TS5 diagnostic commands emit one exact structured JSON line on stderr")];
}

export function compareSnapshot(label: string, execution: Execution, error: string): Property[] {
  let stderr: unknown;
  try { stderr = JSON.parse(execution.stderr); } catch { stderr = execution.stderr; }
  return [property(`${label}.exit`, 1, execution.exitCode), property(`${label}.stdout`, "", execution.stdout), property(`${label}.stderr`, { error }, stderr)];
}

const baseline = "export function main() { return 2; }\n";
const target = "export function target() { return 1; }\n";
const scopeCases: ScopeCase[] = [
  { id: "inherited-positive", files: { "src/main.ts": baseline }, status: "admitted", oracleClean: true },
  { id: "inherited-commonjs", files: { "src/main.ts": baseline, "base.json": '{"compilerOptions":{"module":"CommonJS","moduleResolution":"Node10","target":"ES2022"}}' }, status: "rejected" },
  { id: "excluded-dependent", files: { "src/main.ts": baseline, "hidden.ts": "import { main } from './src/main'; export function hidden() { return main(); }\n" }, status: "rejected", coverage: [{ path: "hidden.ts", status: "excluded" }, { path: "src/main.ts", status: "analyzed" }], reasonPrefix: "ANALYSIS_SCOPE_INCOMPLETE:hidden.ts:excluded", oracleClean: true },
  { id: "unretained-reference", files: { "src/main.ts": "/// <reference path='../missing.ts' />\n" + baseline }, status: "rejected", reasons: ["SOURCE_REFERENCE_PATH_UNSUPPORTED", "DEPENDENCY_SCOPE_UNRETAINED_REFERENCE:src/main.ts:../missing.ts", "ANALYSIS_SCOPE_INCOMPLETE:src/main.ts:unsupported", "ZERO_ANALYZED_OBLIGATIONS", "DEPENDENCY_SCOPE_UNSUPPORTED:src/main.ts"] },
  { id: "declared-optional", files: { "src/main.ts": "import { value } from 'optional'; export function main() { return value(); }\n", "package.json": '{"name":"fixture","optionalDependencies":{"optional":"1.0.0"}}' }, status: "admitted" },
  { id: "undeclared-optional", files: { "src/main.ts": "import { value } from 'optional'; export function main() { return value(); }\n" }, status: "rejected" },
  { id: "computed-import", files: { "src/main.ts": "const moduleName='./target'; export async function main() { return import(moduleName); }\n", "src/target.ts": target }, status: "rejected" },
  { id: "two-argument-import", files: { "src/main.ts": "export async function main() { return import('./target', {}); }\n", "src/target.ts": target }, status: "rejected", oracleClean: true },
  { id: "literal-import", files: { "src/main.ts": "export async function main() { return import('./target'); }\n", "src/target.ts": target }, status: "admitted", coverage: [{ path: "src/main.ts", status: "analyzed" }, { path: "src/target.ts", status: "analyzed" }], oracleClean: true },
  { id: "unresolved-literal", files: { "src/main.ts": "export async function main() { return import('./absent'); }\n" }, status: "rejected" },
  { id: "import-type", files: { "src/main.ts": "export type Value = import('./target').Value;\n", "src/target.ts": "export interface Value { value: number }\n" }, status: "rejected", oracleClean: true },
  { id: "import-equals", files: { "src/main.ts": "import dep = require('./target'); export function main() { return dep.target(); }\n", "src/target.ts": target }, status: "rejected" },
  { id: "excluded-computed", files: { "src/main.ts": baseline, "hidden.ts": "const moduleName='./src/main'; export async function hidden() { return import(moduleName); }\n" }, status: "rejected", coverage: [{ path: "src/main.ts", status: "analyzed" }], reasonPrefix: "DEPENDENCY_SCOPE_" },
  { id: "cumulative-refusals", files: { "src/main.ts": "/// <reference path='../missing.ts' />\nconst name='./target'; export type Value = import('./target').Value; export const loaded = import(name);\n", "src/target.ts": "export interface Value { value: number }\n" }, status: "rejected", reasons: ["SOURCE_REFERENCE_PATH_UNSUPPORTED", "DEPENDENCY_SCOPE_UNRETAINED_REFERENCE:src/main.ts:../missing.ts", "DEPENDENCY_SCOPE_COMPUTED_IMPORT:src/main.ts", "DEPENDENCY_SCOPE_IMPORT_TYPE_UNSUPPORTED:src/main.ts", "ANALYSIS_SCOPE_INCOMPLETE:src/main.ts:unsupported", "ZERO_ANALYZED_OBLIGATIONS", "DEPENDENCY_SCOPE_UNSUPPORTED:src/main.ts"] },
  { id: "excluded-parse-failure", files: { "src/main.ts": baseline, "hidden.ts": "export function broken( {\n" }, status: "rejected", coverage: [{ path: "src/main.ts", status: "analyzed" }], reasonPrefix: "DEPENDENCY_SCOPE_UNSUPPORTED:hidden.ts" },
  { id: "excluded-unresolved-import", files: { "src/main.ts": baseline, "hidden.ts": "import { absent } from './absent'; export function hidden() { return absent(); }\n" }, status: "rejected", coverage: [{ path: "src/main.ts", status: "analyzed" }], reasonPrefix: "DEPENDENCY_SCOPE_UNRESOLVED_IMPORT:hidden.ts:./absent" },
  { id: "parse-failure", files: { "src/main.ts": "export function main( {\n" }, status: "rejected" },
];

async function filesAt(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    const destination = resolve(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, text);
  }
}

function analysisAt(ctx: Context, root: string, files: Record<string, string>): Json {
  return { ...ctx.analysis(files), cwd: root, files: Object.fromEntries(Object.entries(files).map(([path, text]) => [resolve(root, path), text])), roots: Object.keys(files).filter(path => path.startsWith("src/") && /\.[cm]?[jt]sx?$/.test(path)).map(path => resolve(root, path)).sort(), qualified: true, retained: true };
}

async function git(root: string, args: string[]): Promise<Json> {
  const environment = isolatedEnvironment(root);
  const child = Bun.spawn(["git", ...args], { cwd: root, env: { ...environment, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_DATE: "2026-10-23T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-23T00:00:00Z" }, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { args, exitCode, stdout, stderr };
}

export async function prepare(ctx: Context, id: string, files: Record<string, string>): Promise<{ root: string; analysis: Json; baseCommit: string; evidence: Evidence[] }> {
  const root = resolve(ctx.root, `qa-${id}`);
  const complete = { "base.json": '{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler","target":"ES2022"}}', "tsconfig.json": '{"extends":"./base.json"}', ".gitignore": ".semctx/\n", ...files };
  await filesAt(root, { ...complete, "src/main.ts": "export function main() { return 1; }\n" });
  const setup: Json[] = [];
  for (const args of [["init", "-q"], ["add", "--", "."], ["-c", "user.name=T00Fixture", "-c", "user.email=t00@example.test", "commit", "-qm", "initial"]]) {
    const result = await git(root, args); setup.push(result);
    if (result["exitCode"] !== 0) throw Error(`Q_BOUNDARY_GIT_SETUP_FAILED:${id}:${JSON.stringify(result)}`);
  }
  const head = await git(root, ["rev-parse", "--verify", "HEAD"]); setup.push(head);
  if (head["exitCode"] !== 0) throw Error(`Q_BOUNDARY_HEAD_MISSING:${id}`);
  await filesAt(root, complete);
  return { root, analysis: analysisAt(ctx, root, complete), baseCommit: String(head["stdout"]).trim(), evidence: [await ctx.save(`qa-${id}-git`, setup)] };
}

export function outcome(execution: Execution): Json {
  return { kind: execution.exitCode === 0 ? "success" : "nonzero", exit_code: execution.exitCode, duration_ms: 0, stdout: execution.stdout, stderr: execution.stderr, stdout_bytes: Buffer.byteLength(execution.stdout), stderr_bytes: Buffer.byteLength(execution.stderr), stdout_hash: sha(execution.stdout), stderr_hash: sha(execution.stderr) };
}

export function descriptor(ctx: Context, fixture: { root: string; analysis: Json; baseCommit: string }, indexed: Json): Json {
  return { repositoryRoot: fixture.root, processHelper: ctx.helper, include: ["src/**/*.ts"], exclude: ["node_modules", "dist", ".semctx", ".git", "coverage"], index: { analysis: fixture.analysis, outcome: indexed, baseCommit: fixture.baseCommit } };
}

async function scopeObservations(ctx: Context): Promise<{ properties: Property[]; evidence: Evidence[] }> {
  const properties: Property[] = [], evidence: Evidence[] = [];
  for (const scenario of scopeCases) {
    const fixture = await prepare(ctx, scenario.id, scenario.files);
    const compiler = await ctx.oracle(`qa-${scenario.id}`, scenario.files);
    const indexed = await ctx.run(`qa-${scenario.id}-index`, "--batch", fixture.analysis, true);
    const verified = await ctx.run(`qa-${scenario.id}-verify`, "verify", descriptor(ctx, fixture, outcome(indexed)), true);
    const coverage = scenario.coverage ?? [{ path: "src/main.ts", status: scenario.status === "admitted" ? "analyzed" : "unsupported" }];
    properties.push(...compareAdmission(scenario.id, { status: scenario.status, coverage, ...(scenario.reasonPrefix === undefined ? {} : { reasonPrefix: scenario.reasonPrefix }), ...(scenario.reasons === undefined ? {} : { reasons: scenario.reasons }) }, verified));
    properties.push(property(`${scenario.id}.index.success`, 0, indexed.exitCode));
    if (scenario.id === "inherited-positive") properties.push(property("inherited.configuration.executed", true, record(verified.value["inherited_configuration"])["executed"]));
    if (scenario.oracleClean === true) properties.push(property(`${scenario.id}.ts7.compiler`, 0, compiler.exitCode, "Pinned independent ts_goport 7.1.0-dev CLI, explicit 115-library SDK"));
    if (scenario.id === "parse-failure") {
      properties.push(property("parse-failure.base-capture.skipped", "not_required", record(verified.value["base_capture"])["status"]), property("parse-failure.base-capture.reason", "current_admission_rejected", record(verified.value["base_capture"])["reason"]));
    }
    if (scenario.id === "parse-failure" || scenario.id === "excluded-parse-failure") {
      const oracleCodes = [...new Set([...`${compiler.stdout}\n${compiler.stderr}`.matchAll(/error TS(\d+):/g)].map(match => Number(match[1])))].sort((left, right) => left - right);
      const observedCodes = [...new Set(list(record(verified.value["analysisAdmission"])["reasons"]).flatMap(reason => typeof reason === "string" && /^SOURCE_PARSE_ERROR:\d+:/.test(reason) ? [Number(reason.split(":")[1])] : []))].sort((left, right) => left - right);
      properties.push(property(`${scenario.id}.independent-syntax-present`, true, compiler.exitCode !== 0 && oracleCodes.length > 0, "Pinned independent TS7 CLI syntax diagnostics"), property(`${scenario.id}.syntax-codes`, oracleCodes, observedCodes, "Pinned independent TS7 CLI diagnostic codes, projected to structured rejection"));
    }
    if (scenario.id === "declared-optional") {
      properties.push(property(`${scenario.id}.opaqueBoundary`, ["optional"], record(verified.value["analysisAdmission"])["externalModuleSpecifiers"]));
      properties.push(property(`${scenario.id}.opaqueLimitation`, true, list(record(verified.value["analysisAdmission"])["limitations"]).some(value => typeof value === "string" && value.includes("optional") && value.includes("not qualified"))));
    }
    evidence.push(...fixture.evidence, ...compiler.evidence, ...indexed.evidence, ...verified.evidence);
  }
  const sdk5 = ts5WitnessSdk(ctx);
  const sdk5Available = sdk5 !== undefined;
  properties.push(property("ts5.explicit-input.available", true, sdk5Available));
  if (!sdk5Available) {
    properties.push(property("ts5.input.unavailable", "Original TS5 SDK input", "Supply platforms[platform].ts5Sdk {path,sha256,bytes}; no SDK relabeling or producer-path fallback"));
    return { properties, evidence };
  }
  const legacy = await prepare(ctx, "ts5", { "src/main.ts": baseline });
  const legacyIndex = await ctx.run("qa-ts5-index", "--batch", legacy.analysis, true, sdk5);
  const legacyVerify = await ctx.run("qa-ts5-verify", "verify", descriptor(ctx, legacy, outcome(legacyIndex)), true, sdk5);
  properties.push(property("ts5.admission", "rejected", record(legacyVerify.value["analysisAdmission"])["status"]), property("ts5.exit", 3, legacyVerify.exitCode));
  properties.push(...compareTs5Warning("ts5.index", legacyIndex), ...compareTs5Warning("ts5.verify", legacyVerify));
  properties.push(property("ts5.receipt.not-consumed", false, legacyVerify.value["indexed_extraction_received"]), property("ts5.reason.exact", ["TS5_DEGRADED_ANALYSIS"], record(legacyVerify.value["analysisAdmission"])["reasons"]));
  evidence.push(...legacy.evidence, ...legacyIndex.evidence, ...legacyVerify.evidence);
  return { properties, evidence };
}

async function receiptObservations(ctx: Context): Promise<{ properties: Property[]; evidence: Evidence[] }> {
  const fixture = await prepare(ctx, "receipts", { "src/main.ts": baseline });
  const indexed = await ctx.run("qa-receipts-index", "--batch", fixture.analysis, true);
  const properties = [property("receipts.index.success", 0, indexed.exitCode)], evidence = [...fixture.evidence, ...indexed.evidence];
  const valid = outcome(indexed);
  const altered = (mutate: (value: Json) => void): Json => {
    const batch = structuredClone(indexed.value); mutate(batch);
    return outcome({ ...indexed, value: batch, stdout: JSON.stringify(batch) });
  };
  const mutations: { id: string; value: Json }[] = [
    { id: "valid", value: valid },
    { id: "unexpected-failure", value: { ...valid, kind: "nonzero", exit_code: 1 } },
    { id: "cancelled", value: { ...valid, kind: "cancelled" } },
    { id: "late", value: { ...valid, duration_ms: 20_001 } },
    { id: "truncated", value: { ...valid, stdout: indexed.stdout.slice(0, -5) } },
    { id: "input-mismatch", value: altered(batch => { batch["input_manifest_id"] = "sha256:" + "0".repeat(64); }) },
    { id: "facts-mismatch", value: altered(batch => { batch["facts"] = []; }) },
    { id: "forged-authority", value: altered(batch => { batch["qualified_admission"] = "admitted"; batch["ownership"] = true; batch["facts"] = []; }) },
  ];
  for (const mutation of mutations) {
    const result = await ctx.run(`qa-receipt-${mutation.id}`, "verify", descriptor(ctx, fixture, mutation.value), true);
    if (mutation.id === "valid") properties.push(...compareAdmission("receipt.valid", { status: "admitted", coverage: [{ path: "src/main.ts", status: "analyzed" }] }, result));
    else {
      properties.push(property(`receipt.${mutation.id}.structured`, "rejected", record(result.value["analysisAdmission"])["status"]));
      properties.push(property(`receipt.${mutation.id}.exit`, 3, result.exitCode));
      properties.push(property(`receipt.${mutation.id}.block`, "BLOCK", result.value["verdict"]));
      properties.push(property(`receipt.${mutation.id}.not-consumed`, false, result.value["indexed_extraction_received"]));
      properties.push(property(`receipt.${mutation.id}.unsupported-coverage`, [{ path: "src/main.ts", status: "unsupported" }], record(record(result.value["analysisAdmission"])["changeCoverage"])["files"]));
      properties.push(property(`receipt.${mutation.id}.reason`, true, list(record(result.value["analysisAdmission"])["reasons"]).some(reason => typeof reason === "string" && reason.startsWith("INDEXED_EXTRACTION_REJECTED:"))));
    }
    evidence.push(...result.evidence);
  }
  const guards = await receiptGuardObservations(ctx);
  return { properties: [...properties, ...guards.properties], evidence: [...evidence, ...guards.evidence] };
}

async function assemblyObservations(ctx: Context): Promise<{ properties: Property[]; evidence: Evidence[] }> {
  const files = { "src/main.ts": baseline, "src/consumer.ts": "import { main } from './main'; export function consumer() { return main(); }\n" };
  const fixture = await prepare(ctx, "assembly", files);
  const compiler = await ctx.oracle("qa-assembly", files);
  const analyzed = await ctx.run("qa-assembly", "", fixture.analysis, true);
  const extraction = record(analyzed.value["raw_extraction"]), assembly = record(analyzed.value["assembly"]);
  const symbolCoordinates = list(extraction["symbols"]).map(value => { const symbol = record(value); return { path: symbol["relPath"], name: symbol["name"], kind: symbol["kind"] }; });
  const properties = [
    property("assembly.compiler", 0, compiler.exitCode, "Pinned independent TS7 CLI compilation of the two-file witness"),
    property("assembly.exit", 0, analyzed.exitCode),
    property("assembly.modules", ["src/consumer.ts", "src/main.ts"], extraction["modules"]),
    property("assembly.symbols", [{ path: "src/consumer.ts", name: "consumer", kind: "function" }, { path: "src/main.ts", name: "main", kind: "function" }], symbolCoordinates),
    property("assembly.singleCall", [{ from: "src/consumer.ts", caller: "consumer", callee: "main", target: "src/main.ts" }], list(extraction["calls"]).map(value => { const call = record(value); return { from: call["callerRelPath"], caller: call["callerSymbolPath"], callee: call["calleeName"], target: call["calleeRelPath"] }; })),
    property("assembly.noIntegrityReasons", {}, assembly["integrityReasons"]),
    property("assembly.graph.nodes", ["function:src/consumer.ts:consumer", "function:src/main.ts:main", "module:src/consumer.ts:consumer.ts", "module:src/main.ts:main.ts", "repository"], list(assembly["nodes"]).map(value => {
      const node = record(value);
      return node["kind"] === "repository" ? "repository" : `${String(node["kind"])}:${String(node["filePath"])}:${String(node["name"])}`;
    }).toSorted()),
  ];
  const nodes = new Map(list(assembly["nodes"]).map(value => { const node = record(value); return [node["id"], node] as const; }));
  const coordinate = (value: unknown): string => {
    const node = nodes.get(value);
    return node?.["kind"] === "repository" ? "repository" : `${String(node?.["kind"])}:${String(node?.["filePath"])}:${String(node?.["name"])}`;
  };
  properties.push(property("assembly.graph.edges", [
    "belongs_to:module:src/consumer.ts:consumer.ts->repository",
    "belongs_to:module:src/main.ts:main.ts->repository",
    "calls:function:src/consumer.ts:consumer->function:src/main.ts:main",
    "declares:module:src/consumer.ts:consumer.ts->function:src/consumer.ts:consumer",
    "declares:module:src/main.ts:main.ts->function:src/main.ts:main",
    "imports:module:src/consumer.ts:consumer.ts->module:src/main.ts:main.ts",
  ], list(assembly["edges"]).map(value => { const edge = record(value); return `${String(edge["kind"])}:${coordinate(edge["from"])}->${coordinate(edge["to"])}`; }).toSorted()));
  const discovered = Object.entries(files).map(([relPath, content]) => ({ relPath, content }));
  const healthy = await ctx.run("qa-runtime-snapshot-consistent", "--analyze-retained-runtime", { analysis: fixture.analysis, discovered_sources: discovered }, true);
  properties.push(property("runtime.consistent.exit", 0, healthy.exitCode), property("runtime.consistent.executed", true, healthy.value["executed"]), property("runtime.consistent.guard", true, healthy.value["snapshot_guard_passed"]));
  const mismatch = discovered.map(source => source.relPath === "src/main.ts" ? { ...source, content: source.content + "export const changed = 1;\n" } : source);
  const refused = await ctx.run("qa-runtime-snapshot-mismatch", "--analyze-retained-runtime", { analysis: fixture.analysis, discovered_sources: mismatch }, true);
  properties.push(...compareSnapshot("runtime.mismatch", refused, "SOURCE_SNAPSHOT_MISMATCH: src/main.ts"));
  const ordinary = await ctx.run("qa-ordinary-no-snapshot", "", { ...fixture.analysis, retained: false, qualified: false }, true);
  properties.push(property("ordinary.noSnapshot.exit", 0, ordinary.exitCode), property("ordinary.noSnapshot.modules", ["src/consumer.ts", "src/main.ts"], record(ordinary.value["raw_extraction"])["modules"]));
  const missing = await ctx.run("qa-qualified-no-snapshot", "--analyze-retained-runtime", { analysis: { ...fixture.analysis, retained: false }, discovered_sources: discovered }, true);
  properties.push(...compareSnapshot("runtime.missing", missing, "SOURCE_SNAPSHOT_REQUIRED"));
  return { properties, evidence: [...fixture.evidence, ...compiler.evidence, ...analyzed.evidence, ...healthy.evidence, ...refused.evidence, ...ordinary.evidence, ...missing.evidence] };
}

export async function admissionObservations(ctx: Context, indices: number[]): Promise<Observation[]> {
  const scopeIndices = new Set([0, 1, 233, 236, 237]), receiptIndices = new Set([232, 234, 238]), assemblyIndices = new Set([2, 3, 4, 235]);
  const scope = indices.some(index => scopeIndices.has(index)) ? await scopeObservations(ctx) : undefined;
  const receipt = indices.some(index => receiptIndices.has(index) || scopeIndices.has(index)) ? await receiptObservations(ctx) : undefined;
  const base = indices.includes(236) ? await baseObservations(ctx) : undefined;
  const assembly = indices.some(index => assemblyIndices.has(index)) ? await assemblyObservations(ctx) : undefined;
  return indices.map(index => {
    const observed = scopeIndices.has(index) ? scope : receiptIndices.has(index) ? receipt : assemblyIndices.has(index) ? assembly : undefined;
    if (observed === undefined) throw Error(`Q_BOUNDARY_ADMISSION_INDEX_UNSUPPORTED:${index}`);
    if (assemblyIndices.has(index)) return { index, ...observed, complete: false, reason: "Préparation partielle : composition publique Plane-A, sélection workers et propriété/provenance composée non démontrées." };
    const cumulative = scopeIndices.has(index) ? [observed, receipt!, ...(index === 236 ? [base!] : [])] : [observed];
    const properties = cumulative.flatMap(item => item.properties), evidence = cumulative.flatMap(item => item.evidence);
    const complete = properties.length > 0 && evidence.length > 0 && properties.every(item => item.pass);
    return { index, properties, evidence, complete, reason: complete
      ? "Témoins TS7 natifs et contrôles contractuels conformes : refus cumulés, reçu conservé et consommé, mutations après émission, restauration, propriété callback ; zéro crédit hors candidat intégré et revue des deux plateformes."
      : "Preuves cumulatives incomplètes ou divergentes : une exécution absente ou une comparaison échouée interdit de déclarer la frontière complète." };
  });
}
