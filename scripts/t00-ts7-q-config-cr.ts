import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CampaignContext, Evidence, ObligationResult } from "./t00-ts7-q-config-campaign.ts";

type Property = ObligationResult["properties"][number];
type Diagnostic = { code: number; message: string };

export function compilerDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const line of output.replaceAll("\r\n", "\n").split("\n")) {
    if (line.trim() === "") continue;
    const match = /^(?:.*?: )?error TS(\d+): (.*)$/.exec(line);
    if (match) diagnostics.push({ code: Number(match[1]), message: match[2]! });
    else if (/^\s+/.test(line) && diagnostics.length > 0) diagnostics[diagnostics.length - 1]!.message += ` ${line.trim()}`;
    else throw new Error(`unrecognized compiler output: ${line}`);
  }
  return diagnostics;
}
export function resolutionFromTrace(output: string, specifier: string): string | null {
  const prefix = `======== Module name '${specifier}' `;
  const lines = output.split("\n").filter(line => line.startsWith(prefix));
  const resolutions = lines.flatMap(line => {
    if (line.includes("was not resolved.")) return [null];
    const match = /was successfully resolved to '([^']+)'/.exec(line);
    return match ? [match[1]!] : [];
  });
  if (resolutions.length === 0) throw new Error(`missing TS7 resolution trace for ${specifier}`);
  if (new Set(resolutions).size !== 1) throw new Error(`ambiguous TS7 resolution trace for ${specifier}`);
  return resolutions[0]!;
}
export function closeConfigurationResolution(properties: Property[]): "qualified" | "not_qualified" {
  return properties.length > 0 && properties.every(property => property.status === "pass") ? "qualified" : "not_qualified";
}

const ids: Record<number, string> = {
  "23": "T00-OBL-packages-ts-analyzer-src-javascript-diagnostics-ts-inspectmoduleconfiguration-85815f5af7",
  "24": "T00-OBL-packages-ts-analyzer-src-javascript-diagnostics-ts-inspectmoduleconfiguration-callback-68ee556fec",
  "25": "T00-OBL-packages-ts-analyzer-src-javascript-diagnostics-ts-inspectmoduleconfiguration-callback-32604b33d1",
  "26": "T00-OBL-packages-ts-analyzer-src-javascript-diagnostics-ts-inspectmoduleconfiguration-callback-2c85cf784f",
  "27": "T00-OBL-packages-ts-analyzer-src-javascript-diagnostics-ts-inspectmoduleconfiguration-readfile-ef9362fff6",
  "44": "T00-OBL-packages-ts-analyzer-src-javascript-diagnostics-ts-inspectunconsumednamedconfiguration-d0f99d2f4b",
  "45": "T00-OBL-packages-ts-analyzer-src-javascript-diagnostics-ts-inspectunconsumednamedconfiguration-a9112ffbd4",
  "46": "T00-OBL-packages-ts-analyzer-src-javascript-diagnostics-ts-inspectunconsumednamedconfiguration-6deb8cb77a",
  "47": "T00-OBL-packages-ts-analyzer-src-javascript-diagnostics-ts-inspectunconsumednamedconfiguration-f7746cfe22",
  "198": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-resolveconfiguredmodule-39c3d332ed",
  "199": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-resolveconfiguredmodule-callback-275-f9a575b09b",
  "200": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-resolveconfiguredmodule-callback-278-be8946fb2b",
  "201": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-resolveconfiguredmodule-directoryexists-1ffbdba51c",
  "202": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-resolveconfiguredmodule-fileexists-3c237ffbb2",
  "203": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-resolveconfiguredmodule-readfile-9895662a49",
  "204": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-resolveconfiguredmodule-realpath-89c966e6ff",
  "205": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-resolvetypescriptmodule-b83ac7a50b",
  "223": "T00-OBL-packages-ts-analyzer-src-workspace-links-ts-workspacelinkedsystem-alloweddirect-ceb2971cc0",
  "224": "T00-OBL-packages-ts-analyzer-src-workspace-links-ts-workspacelinkedsystem-directoryexists-a6359f415b",
  "225": "T00-OBL-packages-ts-analyzer-src-workspace-links-ts-workspacelinkedsystem-fileexists-9b56596c2d",
  "226": "T00-OBL-packages-ts-analyzer-src-workspace-links-ts-workspacelinkedsystem-installed-a300cbc97c",
  "227": "T00-OBL-packages-ts-analyzer-src-workspace-links-ts-workspacelinkedsystem-readfile-1d37d86969",
  "228": "T00-OBL-packages-ts-analyzer-src-workspace-links-ts-workspacelinkedsystem-realpath-98c5b9c944"
};

type Fixture = {
  name: string;
  kind: "configuration" | "named" | "resolution";
  files: Record<string, string>;
  specifier?: string;
  namedReason?: boolean;
};
const defaults = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", skipLibCheck: true, noEmit: true };
const source = "export const value = 1;\n";
const config = (options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => JSON.stringify({ compilerOptions: { ...defaults, ...options }, ...extra });
const configurations: Fixture[] = [
  { name: "control", kind: "configuration", files: { "main.ts": source, "tsconfig.json": config() } },
  ...["amd", "umd", "system", "none", "invalid"].map(module => ({ name: `module-${module}`, kind: "configuration" as const, files: { "main.ts": source, "tsconfig.json": config({ module }) } })),
  ...["es5", "es2025", "es2026", "invalid"].map(target => ({ name: `target-${target}`, kind: "configuration" as const, files: { "main.ts": source, "tsconfig.json": config({ target }) } })),
  { name: "malformed-json", kind: "configuration", files: { "main.ts": source, "tsconfig.json": "{ broken" } },
  { name: "missing-extends", kind: "configuration", files: { "main.ts": source, "tsconfig.json": config({}, { extends: "./missing.json" }) } },
  { name: "inherited-invalid-module", kind: "configuration", files: { "main.ts": source, "base.json": config({ module: "invalid" }), "tsconfig.json": '{"extends":"./base.json"}' } },
];
const namedConfigurations: Fixture[] = [
  { name: "named-absent", kind: "named", files: { "main.ts": source, "tsconfig.json": config() }, namedReason: false },
  { name: "named-unconsumed", kind: "named", files: { "main.ts": source, "tsconfig.json": config(), "tsconfig.extra.json": "{}" }, namedReason: true },
  { name: "named-consumed-extends", kind: "named", files: { "main.ts": source, "tsconfig.json": config({}, { extends: "./tsconfig.extra.json" }), "tsconfig.extra.json": "{}" }, namedReason: false },
  { name: "named-reference-unconsumed", kind: "named", files: { "main.ts": source, "tsconfig.json": config({}, { references: [{ path: "./tsconfig.extra.json" }] }), "tsconfig.extra.json": "{}" }, namedReason: true },
];
const resolutionInputs: Fixture[] = [
  { name: "relative-found", kind: "resolution", specifier: "./target", files: { "target.ts": source } },
  { name: "relative-missing", kind: "resolution", specifier: "./missing", files: {} },
  { name: "paths-active", kind: "resolution", specifier: "alias", files: { "target.ts": source, "tsconfig.json": config({ paths: { alias: ["./target.ts"] } }) } },
  { name: "paths-control", kind: "resolution", specifier: "alias", files: { "target.ts": source, "tsconfig.json": config() } },
  { name: "paths-inherited", kind: "resolution", specifier: "alias", files: { "target.ts": source, "base.json": config({ paths: { alias: ["./target.ts"] } }), "tsconfig.json": config({}, { extends: "./base.json" }) } },
  { name: "paths-missing-extends", kind: "resolution", specifier: "alias", files: { "tsconfig.json": config({}, { extends: "./base.json" }) } },
  { name: "package-found", kind: "resolution", specifier: "pkg", files: { "node_modules/pkg/package.json": '{"name":"pkg","types":"index.d.ts"}', "node_modules/pkg/index.d.ts": "export declare const value: number;" } },
  { name: "package-missing", kind: "resolution", specifier: "pkg", files: {} },
];
const resolutions: Fixture[] = resolutionInputs.map(fixture => ({ ...fixture, files: { ...fixture.files, "main.ts": `import { value } from ${JSON.stringify(fixture.specifier)}; export { value };\n` } }));

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, nested: unknown) => nested !== null && typeof nested === "object" && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : nested);
const digest = (value: unknown) => `sha256:${sha(canonical(value))}`;
const property = (name: string, pass: boolean, reason: string): Property => ({ property: name, status: pass ? "pass" : "fail", reason });
async function save(path: string, value: unknown): Promise<Evidence> {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, bytes);
  return { path, sha256: sha(bytes), bytes: Buffer.byteLength(bytes) };
}

type Witness = { name: string; kind: Fixture["kind"] | "workspace"; properties: Property[]; evidence: Evidence[]; durationMs: number };
async function witness(ctx: CampaignContext, fixture: Fixture, sdk: unknown, libraries: string[], sdkReady: boolean): Promise<Witness> {
  const started = performance.now();
  const location = resolve(ctx.out, "cr", fixture.name);
  const root = resolve(location, "workspace");
  await mkdir(root, { recursive: true });
  const files = Object.fromEntries(Object.entries(fixture.files).map(([path, text]) => [resolve(root, path), text]));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  const hasConfig = Object.hasOwn(fixture.files, "tsconfig.json");
  const oracleProject = {
    ...(hasConfig ? { extends: "./workspace/tsconfig.json" } : {}),
    compilerOptions: { ...(!hasConfig ? defaults : {}), noLib: true, skipLibCheck: true, noEmit: true },
    files: [resolve(root, "main.ts"), ...libraries],
    include: [],
  };
  const oraclePath = resolve(location, "oracle-project.json");
  const evidence: Evidence[] = [await save(oraclePath, oracleProject)];
  const oracle = await ctx.run(`cr-${fixture.name}-oracle`, [ctx.oracle, "--noEmit", "--pretty", "false", "--project", oraclePath], root);
  evidence.push(...oracle.evidence);
  const properties: Property[] = [{ property: `${fixture.name}: explicit TS7 SDK115`, status: sdkReady ? "pass" : "not_qualified", reason: sdkReady ? "All 115 supplied SDK library files are explicit compiler roots; noLib disables implicit library fallback." : "Candidate SDK is not TS7 7.1.0-dev with 115 libraries; independent compiler result cannot qualify this candidate." }];
  let oracleDiagnostics: Diagnostic[] = [];
  let oracleParseError: string | undefined;
  try { oracleDiagnostics = compilerDiagnostics(oracle.stdout); }
  catch (error) { oracleParseError = String(error); }
  properties.push(property(`${fixture.name}: compiler process result`, oracleParseError === undefined && oracle.stderr.trim() === "" && oracle.exitCode === (oracleDiagnostics.length === 0 ? 0 : 2), oracleParseError ?? `exit=${oracle.exitCode}; diagnostics=${oracleDiagnostics.length}; stderr=${oracle.stderr.trim() || "empty"}`));
  const request = fixture.kind === "resolution" ? {
    root, sdk_directory: "/sdk/lib", case_sensitive: ctx.platform === "linux", files, directories: [], containing_file: resolve(root, "main.ts"), specifier: fixture.specifier,
  } : {
    id: `ts7-q-config-${fixture.name}`, cwd: root, sdk_directory: "/sdk/lib", case_sensitive: ctx.platform === "linux", roots: [resolve(root, "main.ts")], files,
    options: { ...defaults, allowJs: true, jsx: "Preserve", strict: false }, retained: true, qualified: false, roles: {}, selection: {}, disabled: [], utf16_files: {}, raw_files: {},
  };
  const requestPath = resolve(location, "request.json");
  evidence.push(await save(requestPath, request));
  const native = await ctx.run(`cr-${fixture.name}-producer`, [ctx.producer, ...(fixture.kind === "resolution" ? ["--observe-configured-resolution"] : []), requestPath, ctx.sdk], root);
  evidence.push(...native.evidence);
  let observed: Record<string, unknown> = {};
  let nativeError: string | undefined;
  try { observed = object(JSON.parse(native.stdout)); }
  catch (error) { nativeError = String(error); }
  properties.push(property(`${fixture.name}: producer process result`, native.exitCode === 0 && nativeError === undefined && native.stderr.trim() === "", nativeError ?? `exit=${native.exitCode}; stderr=${native.stderr.trim() || "empty"}`));
  const identities = fixture.kind === "resolution" ? observed.request_descriptor_id === digest(request) && observed.sdk_input_id === digest(sdk) : observed.request_id === digest(request);
  properties.push(property(`${fixture.name}: request and artifact binding`, identities && observed.producer_artifact_id === `sha256:${sha(await readFile(ctx.producer))}`, "Native observation must bind this exact request and the verified candidate executable."));
  if (fixture.kind === "resolution") {
    const trace = await ctx.run(`cr-${fixture.name}-trace`, [ctx.oracle, "--noEmit", "--pretty", "false", "--traceResolution", "--project", oraclePath], root);
    evidence.push(...trace.evidence);
    let expected: string | null | undefined;
    let traceError: string | undefined;
    try { expected = resolutionFromTrace(trace.stdout, fixture.specifier!); }
    catch (error) { traceError = String(error); }
    properties.push(property(`${fixture.name}: complete resolved-file result`, traceError === undefined && trace.stderr.trim() === "" && trace.exitCode === oracle.exitCode && observed.executed === true && isDeepStrictEqual(observed.unsupported, []) && observed.native_error === null && isDeepStrictEqual(observed.native_diagnostics, []) && observed.resolved_file_name === expected, traceError ?? `Independent tsgo trace expected ${String(expected)}; producer returned ${JSON.stringify(observed.resolved_file_name)}; unsupported=${JSON.stringify(observed.unsupported)}`));
    evidence.push(await save(resolve(location, "comparison.json"), { authority: "Independent pinned tsgo trace; no Semctx source or outputs derive expected target", expected, actual: observed.resolved_file_name, oracleDiagnostics, properties }));
  } else {
    const subjects = Array.isArray(observed.subjects) ? observed.subjects.map(object).filter(subject => subject.path === "main.ts") : [];
    const component = object(object(subjects[0]?.moduleConfigurationObservations)[fixture.kind === "named" ? "retainedWithoutSource" : "ordinaryWithoutSnapshot"]);
    const reasons = Array.isArray(component.reasons) ? component.reasons : [];
    properties.push(property(`${fixture.name}: component executed`, subjects.length === 1 && component.executed === true && isDeepStrictEqual(component.unsupported, []), "Exactly one main.ts observation must execute without unsupported operations."));
    if (fixture.kind === "named") {
      const actual = reasons.filter(reason => typeof reason === "string" && reason.startsWith("SOURCE_NAMED_CONFIGURATION_"));
      const expected = fixture.namedReason ? ["SOURCE_NAMED_CONFIGURATION_UNSUPPORTED"] : [];
      properties.push(property(`${fixture.name}: named-consumption policy`, isDeepStrictEqual(actual, expected), "Independent finite contract projection: extends consumes a named configuration; references and mere presence do not."));
      evidence.push(await save(resolve(location, "comparison.json"), { authority: "Independent named-configuration contract projection", expected, actual, oracleDiagnostics, properties }));
    } else {
      const expected = oracleDiagnostics.filter(diagnostic => diagnostic.code !== 18003).map(diagnostic => `SOURCE_CONFIGURATION_INVALID:${diagnostic.code}:${diagnostic.message}`).sort();
      const actual = reasons.filter((reason): reason is string => typeof reason === "string" && reason.startsWith("SOURCE_CONFIGURATION_INVALID:")).sort();
      properties.push(property(`${fixture.name}: complete configuration diagnostics`, oracleParseError === undefined && isDeepStrictEqual(actual, expected), `Expected ${JSON.stringify(expected)}; actual ${JSON.stringify(actual)}. Only contract-suppressed TS18003 is excluded.`));
      evidence.push(await save(resolve(location, "comparison.json"), { authority: "Independent pinned tsgo compiler diagnostics, complete messages", expected, actual, oracleDiagnostics, properties }));
    }
  }
  return { name: fixture.name, kind: fixture.kind, properties, evidence, durationMs: performance.now() - started };
}

async function workspaceWitness(ctx: CampaignContext, installed: boolean): Promise<Witness> {
  const started = performance.now();
  const name = installed ? "workspace-installed" : "workspace-uninstalled";
  const location = resolve(ctx.out, "cr", name);
  await mkdir(location, { recursive: true });
  const root = resolve(location, "workspace");
  const virtual = `${root}/node_modules/pkg/base.json`;
  const physical = installed ? virtual : `${root}/packages/pkg/base.json`;
  const text = installed ? '{"compilerOptions":{"module":"invalid"}}' : '{"compilerOptions":{"module":"esnext"}}';
  const outside = resolve(root, "../node_modules/above/base.json");
  const files: Record<string, string> = {
    [`${root}/package.json`]: '{"workspaces":["packages/*"],"dependencies":{"pkg":"workspace:*"}}',
    [`${root}/packages/pkg/package.json`]: '{"name":"pkg","version":"1.0.0"}',
    [`${root}/packages/pkg/base.json`]: '{"compilerOptions":{"module":"esnext"}}',
    [outside]: "outside root must never be observable",
    ...(installed ? { [`${root}/node_modules/pkg/package.json`]: '{"name":"pkg","version":"2.0.0"}', [virtual]: text } : {}),
  };
  const queries = [
    { operation: "file_exists", path: virtual },
    { operation: "read_file", path: virtual },
    { operation: "directory_exists", path: dirname(virtual) },
    { operation: "realpath", path: virtual },
    { operation: "file_exists", path: outside },
    { operation: "read_file", path: outside },
    { operation: "directory_exists", path: dirname(outside) },
    { operation: "realpath", path: outside },
  ];
  const request = { profile: "workspace", root, case_sensitive: ctx.platform === "linux", files, sdk_directory: null, queries };
  const requestPath = resolve(location, "request.json");
  const evidence = [await save(requestPath, request)];
  const native = await ctx.run(`cr-${name}-producer`, [ctx.producer, "--observe-system", requestPath], location);
  evidence.push(...native.evidence);
  let observed: Record<string, unknown> = {};
  let error: string | undefined;
  try { observed = object(JSON.parse(native.stdout)); }
  catch (caught) { error = String(caught); }
  const rows = Array.isArray(observed.results) ? observed.results.map(object) : [];
  const properties = [
    property(`${name}: process and binding`, native.exitCode === 0 && error === undefined && native.stderr.trim() === "" && observed.executed === true && observed.request_descriptor_id === digest(request) && observed.producer_artifact_id === `sha256:${sha(await readFile(ctx.producer))}`, error ?? "Finite captured System process binds the exact candidate and descriptor."),
    property(`${name}: complete direct operation values`, rows.length === queries.length && rows.slice(0, 4).every(row => row.executed === true && isDeepStrictEqual(row.unsupported, []) && isDeepStrictEqual(row.refusals, [])) && rows[0]?.value === true && rows[1]?.found === true && rows[1]?.value === text && rows[1]?.physicalPath === physical && rows[2]?.value === true && rows[3]?.value === physical, "Independent contract projection: installed package precedes the declared workspace member; an uninstalled workspace:* dependency maps into that member."),
    property(`${name}: above-repository link absent`, rows.length === queries.length && rows.slice(4).every(row => row.executed === true && isDeepStrictEqual(row.unsupported, [])) && rows[4]?.value === false && rows[5]?.found === false && rows[5]?.value === null && rows[6]?.value === false && rows[7]?.value === outside, "Independent boundary contract: explicitly captured ancestor package bytes remain unreadable and undiscoverable; denied realpath preserves the queried spelling."),
  ];
  evidence.push(await save(resolve(location, "comparison.json"), { authority: "Finite independently written Semctx workspace mapping/confinement contract projection; no producer-derived expected values", expected: { virtual, physical, text, aboveRepositoryVisible: false }, properties }));
  return { name, kind: "workspace", properties, evidence, durationMs: performance.now() - started };
}

const missing: Record<string, string> = {
  configuration: "Full owning-consumer closure remains unproved: retained source predicates, outside-root configuration reads, live read failures, source-dependent runtime branches and complete activating/control allocation are not covered by these compiler controls.",
  named: "Full named-configuration closure remains unproved: normalized case collisions, malformed chain failure paths, cache lifecycle and independent native read-attribution are not all exercised.",
  resolution: "Full resolver closure remains unproved: default system selection, repositoryRoot absent, canonical escape, live filesystem failures, directoryExists alternatives and delegate absent/undefined are not observable through the captured resolver endpoint.",
  workspace: "Full workspace-system closure remains unproved: installed/uninstalled direct operations, above-repository absence, nested repositories, canonical symlink confinement and resolver.inputs need an independent complete live-system oracle.",
};

const uncovered: Record<number, string[]> = {
  23: ["live/retained System selection and optional source creation", "all default-expression/JSDoc/CommonJS/semantic/runtime predicates", "nearest config absent, outside root and escaped extends", "retained module/resolution policy and parsed-source module scope"],
  24: ["nearest-config discovery true/false outcomes at every ancestor through live and retained Systems"],
  25: ["live config read failure and normalized workspaceLinks.inputs content-or-undefined attribution"],
  26: ["all owning configuration diagnostic branches including multiline chains and TS18003 suppression"],
  27: ["contained read delegation and outside-read escaped flag with failed-read alternatives"],
  44: ["named-config cache lifecycle, unique governing configs and malformed config skip", "all named-file classification and consumed extends failure paths"],
  45: ["named-config discovery at every ancestor with missing/source-extension controls"],
  46: ["normalization of relative/backslash/case-colliding named inputs for native case mode"],
  47: ["consumed-read attribution before successful and undefined delegated reads"],
  198: ["default System, explicit System and omitted repositoryRoot", "canonical escape, symlinks and live filesystem failures", "config malformed/absent, resolution mode and implied-node-format alternatives"],
  199: ["configurationSystem.fileExists true/false with live default System and repositoryRoot absent"],
  200: ["configurationSystem.readFile valid/missing/failed live configuration branches"],
  201: ["physical directory true/false and configurationSystem fallback absent/undefined/true/false"],
  202: ["physical file precedence and configurationSystem fallback true/false"],
  203: ["physical file read precedence and configurationSystem fallback with missing/failed reads"],
  204: ["fileExists false with directoryExists true realpath alternative", "delegate realpath absent/undefined, canonical escape, symlinks and thrown live filesystem errors"],
  205: ["configured/unconfigured and live/retained resolver alternatives", "unresolved result, post-resolution existence and native realpath failure paths"],
};

export async function runConfigurationResolution(ctx: CampaignContext, indices: number[]): Promise<ObligationResult[]> {
  if (indices.length === 0) return [];
  await mkdir(resolve(ctx.out, "cr", "oracle-sdk"), { recursive: true });
  const sdk: unknown = JSON.parse(await readFile(ctx.sdk, "utf8"));
  const sdkObject = object(sdk);
  const sdkFiles = Object.entries(object(sdkObject.files)).filter(([path, text]) => /^lib(?:\.[a-z0-9.]+)?\.d\.ts$/.test(basename(path)) && typeof text === "string");
  const libraries: string[] = [];
  for (const [path, text] of sdkFiles) {
    const target = resolve(ctx.out, "cr", "oracle-sdk", basename(path));
    if (libraries.includes(target)) throw new Error(`duplicate SDK library basename ${target}`);
    await writeFile(target, text as string);
    libraries.push(target);
  }
  libraries.sort();
  const sdkReady = sdkObject.version === "7.1.0-dev" && libraries.length === 115;
  const needed = new Set(indices.map(index => index < 40 ? "configuration" : index < 100 ? "named" : index < 223 ? "resolution" : "workspace"));
  const installedConfiguration: Fixture = {
    name: "workspace-installed-invalid-module", kind: "configuration",
    files: {
      "main.ts": source,
      "package.json": '{"workspaces":["packages/*"],"dependencies":{"pkg":"workspace:*"}}',
      "packages/pkg/package.json": '{"name":"pkg","version":"1.0.0"}',
      "packages/pkg/base.json": config(),
      "node_modules/pkg/package.json": '{"name":"pkg","version":"2.0.0"}',
      "node_modules/pkg/base.json": config({ module: "invalid" }),
      "tsconfig.json": '{"extends":"pkg/base.json"}',
    },
  };
  const fixtures = [...(needed.has("configuration") ? configurations : []), ...(needed.has("named") ? namedConfigurations : []), ...(needed.has("resolution") ? resolutions : []), ...(needed.has("workspace") ? [installedConfiguration] : [])];
  const witnesses: Witness[] = [];
  for (const fixture of fixtures) witnesses.push(await witness(ctx, fixture, sdk, libraries, sdkReady));
  if (needed.has("workspace")) {
    witnesses.push(await workspaceWitness(ctx, false));
    witnesses.push(await workspaceWitness(ctx, true));
  }
  return indices.map(index => {
    if (!ids[index]) throw new Error(`unknown C/R obligation ${index}`);
    const group = index < 40 ? "configuration" : index < 100 ? "named" : index < 223 ? "resolution" : "workspace";
    const relevant = witnesses.filter(value => value.kind === group || (group === "workspace" && value.name === installedConfiguration.name));
    const gap = index === 198 || index === 204 ? `${missing.resolution} Specifically obligation ${index} retains the lot-3 unexercised live branches; no captured substitute closes them.` : missing[group]!;
    const properties: Property[] = [
      ...relevant.flatMap(value => value.properties.map(result => ({ ...result, evidence: value.evidence }))),
      { property: "owning consumer observable rule(s) in canonical family/call-path contract", status: "not_qualified", reason: gap, evidence: [] },
      ...(uncovered[index] ?? []).map(branch => ({ property: branch, status: "not_qualified" as const, reason: "Independent TS7 activating/control witnesses at this owning boundary are absent; neighboring successful examples receive no closure credit.", evidence: [] })),
      ...(group === "workspace" ? [
        { property: "uninstalled/installed/boundary read, existence, directory, realpath and resolver.inputs observations", status: "not_qualified" as const, reason: missing.workspace!, evidence: [] },
        { property: "installed dependency emits invalid module6046 instead of workspace default", status: "not_qualified" as const, reason: "A fresh independent installed-configuration compiler control is recorded; complete native SDK115 support and live System equivalence remain prerequisites.", evidence: [] },
        { property: "above-repository link absent", status: "not_qualified" as const, reason: "Captured ancestor-query controls are recorded; live canonical symlinks and absent/delegated methods remain unexercised.", evidence: [] },
      ] : []),
    ];
    return { index, id: ids[index]!, status: closeConfigurationResolution(properties), reason: gap, properties, evidence: relevant.flatMap(value => value.evidence), durationMs: relevant.reduce((total, value) => total + value.durationMs, 0) };
  });
}
