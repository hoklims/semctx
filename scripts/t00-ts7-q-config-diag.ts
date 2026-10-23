import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CampaignContext, Evidence, ObligationResult, PropertyResult } from "./t00-ts7-q-config-campaign";
import { compilerDiagnostics } from "./t00-ts7-q-config-cr";

type Value = Record<string, unknown>;
type PairWitness = { role: "activation" | "control"; pass: boolean; evidence: Evidence[] };
const object = (value: unknown): Value => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, nested: unknown) => nested !== null && typeof nested === "object" && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : nested);

export function compareConfigurationObservation(value: unknown, expected: string[]): boolean {
  const observation = object(value);
  return observation.executed === true && isDeepStrictEqual(observation.unsupported, []) && Array.isArray(observation.reasons) && observation.reasons.every(reason => typeof reason === "string") && isDeepStrictEqual([...observation.reasons].sort(), [...expected].sort());
}

export function assessConfigurationPair(property: string, witnesses: PairWitness[]): PropertyResult {
  const evidence = witnesses.flatMap(witness => witness.evidence);
  if (!witnesses.some(witness => witness.role === "activation") || !witnesses.some(witness => witness.role === "control") || witnesses.some(witness => witness.evidence.length === 0)) {
    return { property, status: "not_qualified", reason: "Both activating and control executions with bound evidence are required; incomplete allocation receives no credit.", evidence };
  }
  const passed = witnesses.every(witness => witness.pass);
  return { property, status: passed ? "pass" : "fail", reason: passed ? "Every allocated activation and control matches its independent expected owning-component projection." : "At least one allocated activation/control disagrees with its independent expected result or did not execute cleanly.", evidence };
}

type Fixture = {
  name: string;
  pair: string;
  role: PairWitness["role"];
  indices: number[];
  files: Record<string, string>;
  subject?: string;
  component?: "retainedWithoutSource" | "retainedWithSource" | "ordinaryWithoutSnapshot";
  prefixes?: string[];
  expected?: string[];
  compiler?: boolean;
  suppression?: boolean;
};
const defaults = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", skipLibCheck: true, noEmit: true };
const source = "export const value = 1;\n";
const config = (options: Value = {}, extra: Value = {}) => JSON.stringify({ compilerOptions: { ...defaults, ...options }, ...extra });
const namedReason = "SOURCE_NAMED_CONFIGURATION_UNSUPPORTED";
const namedPrefixes = ["SOURCE_NAMED_CONFIGURATION_"];
const all = [23, 24, 25, 26, 27, 44, 45, 46, 47];
const fixtures: Fixture[] = [];
function pair(name: string, indices: number[], activation: Omit<Fixture, "name" | "pair" | "role" | "indices">, control: Omit<Fixture, "name" | "pair" | "role" | "indices">): void {
  fixtures.push({ name: `${name}-activation`, pair: name, role: "activation", indices, ...activation }, { name: `${name}-control`, pair: name, role: "control", indices, ...control });
}
for (const depth of [0, 1, 2]) {
  const prefix = "nested/".repeat(depth);
  pair(`named-discovery-depth-${depth}`, [44, 45], {
    files: { "main.ts": source, [`${prefix}main.ts`]: source, [`${prefix}tsconfig.json`]: config({}, { extends: "./tsconfig.extra.json" }), [`${prefix}tsconfig.extra.json`]: "{}" },
    prefixes: namedPrefixes, expected: [],
  }, {
    files: { "main.ts": source, [`${prefix}main.ts`]: source, [`${prefix}tsconfig.extra.json`]: "{}" },
    prefixes: namedPrefixes, expected: [namedReason],
  });
}
for (const extension of ["ts", "tsx", "js", "jsx", "mts", "mtsx", "cts", "ctsx", "mjs", "mjsx", "cjs", "cjsx"]) {
  pair(`named-source-extension-${extension}`, [44, 45], {
    files: { "main.ts": source, [`nested/extra.${extension}`]: source, "nested/tsconfig.json": config({}, { extends: "./tsconfig.extra.json" }), "nested/tsconfig.extra.json": "{}" },
    prefixes: namedPrefixes, expected: [],
  }, {
    files: { "main.ts": source, [`nested/extra.${extension}.txt`]: source, "nested/tsconfig.json": config({}, { extends: "./tsconfig.extra.json" }), "nested/tsconfig.extra.json": "{}" },
    prefixes: namedPrefixes, expected: [namedReason],
  });
}
pair("named-nearest-config", [44, 45], {
  files: { "nested/child/main.ts": source, "tsconfig.json": config({}, { extends: "./tsconfig.extra.json" }), "tsconfig.extra.json": "{}" }, subject: "nested/child/main.ts", prefixes: namedPrefixes, expected: [],
}, {
  files: { "nested/child/main.ts": source, "nested/tsconfig.json": config(), "tsconfig.json": config({}, { extends: "./tsconfig.extra.json" }), "tsconfig.extra.json": "{}" }, subject: "nested/child/main.ts", prefixes: namedPrefixes, expected: [namedReason],
});
pair("named-malformed-governing", [44, 47], {
  files: { "main.ts": source, "tsconfig.json": "{ broken", "tsconfig.extra.json": "{}" }, prefixes: namedPrefixes, expected: [namedReason],
}, {
  files: { "main.ts": source, "tsconfig.json": config({}, { extends: "./tsconfig.extra.json" }), "tsconfig.extra.json": "{}" }, prefixes: namedPrefixes, expected: [],
});
pair("named-malformed-extended-consumed", [44, 47], {
  files: { "main.ts": source, "tsconfig.json": config({}, { extends: "./tsconfig.extra.json" }), "tsconfig.extra.json": "{ broken" }, prefixes: namedPrefixes, expected: [],
}, {
  files: { "main.ts": source, "tsconfig.json": config(), "tsconfig.extra.json": "{ broken" }, prefixes: namedPrefixes, expected: [namedReason],
});
pair("named-transitive-consumption", [44, 47], {
  files: { "main.ts": source, "tsconfig.json": config({}, { extends: "./base.json" }), "base.json": '{"extends":"./tsconfig.extra.json"}', "tsconfig.extra.json": "{}" }, prefixes: namedPrefixes, expected: [],
}, {
  files: { "main.ts": source, "tsconfig.json": config({}, { references: [{ path: "./tsconfig.extra.json" }] }), "tsconfig.extra.json": "{}" }, prefixes: namedPrefixes, expected: [namedReason],
});
for (const [name, text, reason] of [
  ["retained-default-expression", "export default 1;\n", "SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED"],
  ["retained-jsdoc", '/** @typedef {import("./dep").Value} Value */\nexport const value=1;\n', "SOURCE_JSDOC_IMPORT_UNSUPPORTED"],
  ["retained-commonjs", "module.exports = 1;\n", "SOURCE_COMMONJS_UNSUPPORTED"],
] as const) {
  pair(name, [23], { files: { "main.js": text, "dep.d.ts": "export type Value = number;" }, subject: "main.js", prefixes: [reason], expected: [reason] }, { files: { "main.js": source }, subject: "main.js", prefixes: [reason], expected: [] });
}
pair("retained-module-policy", [23], {
  files: { "main.ts": source, "tsconfig.json": config({ module: "CommonJS", moduleResolution: "Node16" }) }, prefixes: ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:"], expected: ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:CommonJS"],
}, {
  files: { "main.ts": source, "tsconfig.json": config() }, prefixes: ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:"], expected: [],
});
pair("retained-resolution-policy", [23], {
  files: { "main.ts": source, "tsconfig.json": config({ module: "NodeNext", moduleResolution: "NodeNext" }) }, prefixes: ["SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:"], expected: ["SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:NodeNext"],
}, {
  files: { "main.ts": source, "tsconfig.json": config() }, prefixes: ["SOURCE_CONFIGURATION_RESOLUTION_UNSUPPORTED:"], expected: [],
});
pair("parsed-source-module-scope", [23], {
  files: { "main.ts": "const value = 1;\n" }, component: "retainedWithSource", prefixes: ["SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"], expected: ["SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"],
}, {
  files: { "main.ts": source }, component: "retainedWithSource", prefixes: ["SOURCE_GLOBAL_SCRIPT_UNSUPPORTED"], expected: [],
});
pair("outside-extends-refusal", [23, 27], {
  files: { "main.ts": source, "tsconfig.json": config({}, { extends: "../base.json" }), "../base.json": config() }, prefixes: ["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"], expected: ["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"],
}, {
  files: { "main.ts": source, "tsconfig.json": config({}, { extends: "./base.json" }), "base.json": config() }, prefixes: ["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"], expected: [],
});
for (const [name, content, extraFiles] of [
  ["configuration-circular-chain", config({}, { extends: "./base.json" }), { "base.json": '{"extends":"./tsconfig.json"}' }],
  ["configuration-multiple-invalid-options", config({ module: "bad", target: "bad" }), {}],
  ["configuration-extends-type", config({}, { extends: 123 }), {}],
  ["configuration-multiline-chain", config({ baseUrl: "./src" }), {}],
] as [string, string, Record<string, string>][]) {
  pair(name, [23, 26], { files: { "main.ts": source, "tsconfig.json": content, ...extraFiles }, compiler: true }, { files: { "main.ts": source, "tsconfig.json": config() }, compiler: true });
}
for (const module of ["esnext", null]) {
  pair(`configuration-inherited-none-${module ?? "null"}`, [23, 26], {
    files: { "main.ts": source, "tsconfig.json": config({ module }, { extends: "./base.json" }), "base.json": config({ module: "none" }) }, compiler: true,
  }, {
    files: { "main.ts": source, "tsconfig.json": config({ module }, { extends: "./base.json" }), "base.json": config() }, compiler: true,
  });
}
pair("configuration-no-input-suppression", [23, 26], {
  files: { "main.ts": source, "tsconfig.json": config({ noLib: true }, { include: ["missing/**/*.ts"] }) }, compiler: true, suppression: true,
}, {
  files: { "main.ts": source, "tsconfig.json": config({ noLib: true }, { include: ["main.ts"] }) }, compiler: true,
});

async function save(path: string, value: unknown): Promise<Evidence> {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, bytes);
  return { path, sha256: sha(bytes), bytes: Buffer.byteLength(bytes) };
}

type Completed = PairWitness & { fixture: Fixture; durationMs: number };
async function execute(ctx: CampaignContext, fixture: Fixture, libraries: string[]): Promise<Completed> {
  const started = performance.now();
  const directory = resolve(ctx.out, "config-diag", fixture.name);
  const root = resolve(directory, "workspace");
  await mkdir(root, { recursive: true });
  const files = Object.fromEntries(Object.entries(fixture.files).map(([path, text]) => [resolve(root, path), text]));
  if (fixture.compiler && !fixture.suppression) {
    const path = resolve(root, "tsconfig.json");
    const project = object(JSON.parse(files[path]!));
    files[path] = JSON.stringify({ ...project, compilerOptions: { ...object(project.compilerOptions), noLib: true }, files: [resolve(root, fixture.subject ?? "main.ts"), ...libraries], include: [] });
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  const subject = fixture.subject ?? "main.ts";
  const request = { id: `ts7-w2-config-diag-${fixture.name}`, cwd: root, sdk_directory: "/sdk/lib", case_sensitive: ctx.platform === "linux", roots: [resolve(root, subject)], files, options: { ...defaults, allowJs: true, jsx: "Preserve", strict: false }, retained: true, qualified: false, roles: {}, selection: {}, disabled: [], utf16_files: {}, raw_files: {} };
  const requestPath = resolve(directory, "request.json");
  const evidence = [await save(requestPath, request), ...Object.entries(files).map(([path, text]) => ({ path, sha256: sha(text), bytes: Buffer.byteLength(text) }))];
  let expected = fixture.expected ?? [];
  let oracleReady = true;
  let oracleDiagnostics: ReturnType<typeof compilerDiagnostics> = [];
  let oracleFailure: string | undefined;
  if (fixture.compiler) {
    const projectPath = resolve(root, "tsconfig.json");
    const oracle = await ctx.run(`config-diag-${fixture.name}-oracle`, [ctx.oracle, "--noEmit", "--pretty", "false", "--project", projectPath], root);
    evidence.push(...oracle.evidence);
    try { oracleDiagnostics = compilerDiagnostics(oracle.stdout); }
    catch (error) { oracleFailure = String(error); }
    oracleReady = oracleFailure === undefined && oracle.stderr.trim() === "" && oracle.exitCode === (oracleDiagnostics.length === 0 ? 0 : 2) && (!fixture.suppression || oracleDiagnostics.some(diagnostic => diagnostic.code === 18003));
    expected = oracleDiagnostics.filter(diagnostic => diagnostic.code !== 18003).map(diagnostic => `SOURCE_CONFIGURATION_INVALID:${diagnostic.code}:${diagnostic.message}`);
  }
  const processResult = await ctx.run(`config-diag-${fixture.name}-producer`, [ctx.producer, requestPath, ctx.sdk], root);
  evidence.push(...processResult.evidence);
  let result: Value = {};
  let parseError: string | undefined;
  try { result = object(JSON.parse(processResult.stdout)); }
  catch (error) { parseError = String(error); }
  const subjects = Array.isArray(result.subjects) ? result.subjects.map(object).filter(item => item.path === subject) : [];
  const componentName = fixture.component ?? (fixture.compiler ? "ordinaryWithoutSnapshot" : "retainedWithoutSource");
  const component = object(object(subjects[0]?.moduleConfigurationObservations)[componentName]);
  const prefixes = fixture.prefixes ?? ["SOURCE_CONFIGURATION_INVALID:"];
  const actual = { ...component, reasons: Array.isArray(component.reasons) ? component.reasons.filter(reason => typeof reason === "string" && prefixes.some(prefix => reason.startsWith(prefix))) : component.reasons };
  const processBound = processResult.exitCode === 0 && processResult.stderr.trim() === "" && parseError === undefined && subjects.length === 1 && result.request_id === `sha256:${sha(canonical(request))}` && result.producer_artifact_id === `sha256:${sha(await readFile(ctx.producer))}`;
  const pass = oracleReady && processBound && compareConfigurationObservation(actual, expected);
  evidence.push(await save(resolve(directory, "comparison.json"), { authority: fixture.compiler ? "Independent pinned TS7 CLI complete diagnostics; only contract-suppressed TS18003 is excluded" : "Independent finite owning-consumer predicate projection from frozen consumer-contracts.json, not from producer output", fixture: fixture.name, role: fixture.role, property: fixture.pair, component: componentName, projectionPrefixes: prefixes, expected, actual: component, oracleDiagnostics, oracleFailure, processBound, parseError, pass }));
  return { fixture, role: fixture.role, pass, evidence, durationMs: performance.now() - started };
}

const remaining: Partial<Record<number, string[]>> = {
  23: ["The public captured request cannot select a live System, omit a retained source after successful source loading, or inject failed reads; complete source-dependent runtime and semantic predicate closure remains unproved."],
  24: ["Nearest-config outcomes are captured, but the native observation exposes no live System discovery path. Should TS7 qualification retain the live+retained requirement (add an independently testable live boundary) or formally restrict this consumer to captured inputs? Recommendation: preserve the requirement and expose the boundary."],
  25: ["A capture map cannot represent fileExists=true followed by undefined or thrown live read. Workspace read-attribution inputs are not returned at the owning initial-read boundary. Add an explicit live/failing-read observation, or approve a contract migration; recommendation: preserve the existing contract."],
  27: ["Contained/escaped extends are exercised, but live failed/undefined delegated reads cannot be represented by immutable successful captured files. Preserve the contract and expose a failure-capable observation, or explicitly migrate this obligation; no captured substitute is credited."],
  44: ["WeakMap cache identity, same-snapshot repeated calls and later-pass invalidation have no public native observation. Malformed and transitive named chains are now exercised, but cache lifecycle and failed-read consumption remain unproved. Preserve the contract and expose lifecycle observations, or decide an explicit TS7 contract migration."],
  46: ["Native case mode accepts only normalized unique captured keys; case-colliding aliases may be rejected before the owning named consumer. No consumer execution proves relative/backslash/case-collision normalization. Preserve and expose the owning boundary, or explicitly change the contract; recommendation: no qualification from a request-level refusal."],
  47: ["The component reports the final named reason, not consumed-read order or failed/undefined read attribution. Successful malformed-chain controls do not establish consume-before-failed-delegate semantics. Preserve and expose this observation, or approve a contract migration; recommendation: no qualification from final-reason parity alone."],
};

export async function enrichConfigurationDiagnostics(ctx: CampaignContext, rows: ObligationResult[]): Promise<ObligationResult[]> {
  const selected = rows.filter(row => all.includes(row.index));
  if (selected.length === 0) return rows;
  const sdk = object(JSON.parse(await readFile(ctx.sdk, "utf8")));
  const sdkFiles = Object.entries(object(sdk.files));
  const libraryDirectory = resolve(ctx.out, "config-diag", "oracle-sdk");
  await mkdir(libraryDirectory, { recursive: true });
  const libraries: string[] = [];
  const libraryEvidence: Evidence[] = [];
  for (const [path, text] of sdkFiles) {
    if (typeof text !== "string" || !/^lib[.a-z0-9-]*\.d\.ts$/.test(basename(path))) throw new Error("invalid TS7 SDK entry for configuration diagnostics");
    const target = resolve(libraryDirectory, basename(path));
    if (libraries.includes(target)) throw new Error("duplicate TS7 SDK basename");
    await writeFile(target, text);
    libraries.push(target);
    libraryEvidence.push({ path: target, sha256: sha(text), bytes: Buffer.byteLength(text) });
  }
  if (sdk.version !== "7.1.0-dev" || libraries.length !== 115) throw new Error("configuration diagnostic oracle requires explicit TS7 SDK115");
  const completed: Completed[] = [];
  for (const fixture of fixtures.filter(fixture => selected.some(row => fixture.indices.includes(row.index)))) completed.push(await execute(ctx, fixture, libraries));
  return rows.map(row => {
    if (!all.includes(row.index)) return row;
    const relevant = completed.filter(witness => witness.fixture.indices.includes(row.index));
    const pairs = [...new Set(fixtures.filter(fixture => fixture.indices.includes(row.index)).map(fixture => fixture.pair))];
    const properties = [...row.properties.filter(property => property.status !== "not_qualified" || ![26, 45].includes(row.index)), ...pairs.map(name => assessConfigurationPair(name, relevant.filter(witness => witness.fixture.pair === name)))];
    for (const reason of remaining[row.index] ?? []) properties.push({ property: `obligation ${row.index}: remaining cumulative consumer boundary`, status: "not_qualified", reason, evidence: [] });
    const evidence = [...row.evidence, ...libraryEvidence, ...relevant.flatMap(witness => witness.evidence)];
    const status = properties.length > 0 && properties.every(property => property.status === "pass") ? "qualified" : "not_qualified";
    const qualifiedReason = row.index === 26 ? "Complete TS7 diagnostics are compared with the independent pinned CLI, including removed options, malformed input, multiple diagnostics, circular chains, a real multiline TS5102 chain and TS18003-only suppression, each with a valid control." : "The named-configuration discovery callback matches every allocated nearest/absent/shadowed ancestor and source-extension control; no broader named-cache or read-attribution claim is made.";
    return { ...row, status, reason: status === "qualified" ? qualifiedReason : (remaining[row.index] ?? ["At least one independent activation/control comparison failed."]).join(" "), properties, evidence, durationMs: row.durationMs + relevant.reduce((total, witness) => total + witness.durationMs, 0) };
  });
}
