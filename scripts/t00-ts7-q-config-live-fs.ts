import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CampaignContext, Evidence, PropertyResult } from "./t00-ts7-q-config-campaign";
import { resolutionFromTrace } from "./t00-ts7-q-config-cr";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, nested: unknown) => nested !== null && typeof nested === "object" && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : nested);
const digest = (value: unknown) => `sha256:${sha(canonical(value))}`;

export function evaluateLiveObservation(observed: unknown, expected: unknown[]): boolean {
  const value = object(observed);
  return value.executed === true && isDeepStrictEqual(value.unsupported, []) && isDeepStrictEqual(value.results, expected);
}

async function save(path: string, value: unknown): Promise<Evidence> {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, bytes);
  return { path, sha256: sha(bytes), bytes: Buffer.byteLength(bytes) };
}

export type LiveFilesystemWitness = { properties: PropertyResult[]; evidence: Evidence[]; durationMs: number };
export async function runLiveFilesystem(ctx: CampaignContext, libraries: string[]): Promise<LiveFilesystemWitness> {
  const started = performance.now();
  const evidence: Evidence[] = [];
  const properties: PropertyResult[] = [];
  const producerId = `sha256:${sha(await readFile(ctx.producer))}`;
  const sdkId = digest(JSON.parse(await readFile(ctx.sdk, "utf8")));
  for (const installed of [false, true]) {
    const name = installed ? "installed" : "uninstalled";
    const location = resolve(ctx.out, "live-fs", name);
    await mkdir(resolve(location, "repository"), { recursive: true });
    const root = await realpath(resolve(location, "repository"));
    const files: Record<string, string> = {
      "package.json": '{"workspaces":["packages/*"],"dependencies":{"pkg":"workspace:*"}}',
      "packages/pkg/package.json": '{"name":"pkg","version":"1.0.0"}',
      "packages/pkg/base.json": "workspace configuration",
      "inside.json": "internal physical configuration",
      "main.ts": 'import { value } from "./target"; export { value };',
      "target.ts": "export const value = 1;",
      "tsconfig.json": '{"compilerOptions":{"target":"es2022","module":"esnext","moduleResolution":"bundler"}}',
      ...(installed ? { "node_modules/pkg/package.json": '{"name":"pkg","version":"2.0.0"}', "node_modules/pkg/base.json": "installed configuration" } : {}),
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(resolve(root, path)), { recursive: true });
      await writeFile(resolve(root, path), text);
    }
    const outside = resolve(root, "../node_modules/above/base.json");
    await mkdir(dirname(outside), { recursive: true });
    await writeFile(outside, "outside secret");
    await mkdir(resolve(root, "nested"));
    await writeFile(resolve(root, "nested/.git"), "gitdir: external");
    await writeFile(resolve(root, "nested/config.json"), "nested secret");
    await symlink(resolve(root, "inside.json"), resolve(root, "internal.json"));
    await symlink(outside, resolve(root, "escaped.json"));
    await symlink(resolve(root, "cycle.json"), resolve(root, "cycle.json"));
    const queried = [
      { path: resolve(root, "node_modules/pkg/base.json"), file: true, directory: false, text: installed ? "installed configuration" : "workspace configuration", actual: resolve(root, installed ? "node_modules/pkg/base.json" : "packages/pkg/base.json") },
      { path: resolve(root, "node_modules/pkg"), file: false, directory: true, text: null, actual: resolve(root, installed ? "node_modules/pkg" : "packages/pkg") },
      { path: resolve(root, "internal.json"), file: true, directory: false, text: "internal physical configuration", actual: resolve(root, "inside.json") },
      ...[outside, resolve(root, "escaped.json"), resolve(root, "cycle.json"), resolve(root, "missing.json"), resolve(root, "nested/config.json")].map(path => ({ path, file: false, directory: false, text: null, actual: path })),
    ];
    const expected = queried.flatMap(row => [
      { operation: "file_exists", path: row.path, value: row.file },
      { operation: "read_file", path: row.path, value: row.text },
      { operation: "directory_exists", path: row.path, value: row.directory },
      { operation: "realpath", path: row.path, value: row.actual },
    ]);
    const request = { root, inventory: Object.keys(files).map(path => resolve(root, path)), queries: expected.map(({ operation, path }) => ({ operation, path })) };
    evidence.push(await save(resolve(location, "request.json"), request));
    const native = await ctx.run(`live-fs-${name}-producer`, [ctx.producer, "--observe-live-system", resolve(location, "request.json")], root);
    evidence.push(...native.evidence);
    let observed: unknown;
    try { observed = JSON.parse(native.stdout); } catch { observed = null; }
    const bound = object(observed).request_descriptor_id === digest(request) && object(observed).producer_artifact_id === `sha256:${sha(await readFile(ctx.producer))}`;
    properties.push({ property: `live ${name}: direct and synthetic read/existence/directory/realpath controls`, status: native.exitCode === 0 && native.stderr.trim() === "" && bound && evaluateLiveObservation(observed, expected) ? "pass" : "fail", reason: "Independent finite workspace-system contract projection on real native files, installed precedence, internal/escaping/cyclic symlinks, absent paths, nested Git boundary and above-root refusal; exact rows and artifact binding required.", evidence: [...native.evidence] });
    const inputs = object(object(observed).inputs);
    const expectedReadPaths = queried.filter(row => row.text !== null).map(row => [row.path.includes("/node_modules/") ? row.actual : row.path, row.text] as const);
    const inputsPass = expectedReadPaths.every(([path, text]) => inputs[path] === text) && inputs[outside] === null && inputs[resolve(root, "escaped.json")] === null;
    properties.push({ property: `live ${name}: content-or-undefined input attribution`, status: bound && inputsPass ? "pass" : "fail", reason: "Successful reads record the selected lexical input content; refused outside and canonical-escape queries record undefined as JSON null.", evidence: [...native.evidence] });
    evidence.push(await save(resolve(location, "comparison.json"), { authority: "Finite owning workspace contract projection; expected values fixed from authored fixture roles before producer execution", expected, observed, properties: properties.slice(-2) }));
    const project = { extends: "./repository/tsconfig.json", compilerOptions: { noLib: true, noEmit: true, skipLibCheck: true }, files: [resolve(root, "main.ts"), ...libraries], include: [] };
    evidence.push(await save(resolve(location, "oracle-project.json"), project));
    const trace = await ctx.run(`live-fs-${name}-ts7`, [ctx.oracle, "--noEmit", "--pretty", "false", "--traceResolution", "--project", resolve(location, "oracle-project.json")], root);
    evidence.push(...trace.evidence);
    let expectedResolution: string | null | undefined;
    try { expectedResolution = resolutionFromTrace(trace.stdout, "./target"); } catch { expectedResolution = undefined; }
    const resolutionRequest = { ...request, queries: [], resolution: { containing_file: resolve(root, "main.ts"), specifier: "./target" } };
    evidence.push(await save(resolve(location, "resolution-request.json"), resolutionRequest));
    const resolution = await ctx.run(`live-fs-${name}-resolution`, [ctx.producer, "--observe-live-configured-resolution", resolve(location, "resolution-request.json"), ctx.sdk], root);
    evidence.push(...resolution.evidence);
    let actual: Record<string, unknown>;
    try { actual = object(JSON.parse(resolution.stdout)); } catch { actual = {}; }
    properties.push({ property: `live ${name}: pinned TS7 configured resolution`, status: trace.exitCode === 0 && trace.stderr.trim() === "" && expectedResolution !== undefined && resolution.exitCode === 0 && resolution.stderr.trim() === "" && evaluateLiveResolution(actual, expectedResolution, digest(resolutionRequest), producerId, sdkId) ? "pass" : "fail", reason: `Separate pinned tsgo native-FS trace expected ${String(expectedResolution)}; no captured endpoint substitute.`, evidence: [...trace.evidence, ...resolution.evidence] });
    evidence.push(await save(resolve(location, "resolution-comparison.json"), { expected: expectedResolution, actual, property: properties.at(-1) }));
  }
  const additional = await runAdditionalLiveResolution(ctx, libraries);
  properties.push(...additional.properties);
  evidence.push(...additional.evidence);
  return { properties, evidence, durationMs: performance.now() - started };
}

export function evaluateLiveResolution(observed: unknown, expected: string | null, request: string, producer: string, sdk: string): boolean {
  const value = object(observed);
  return value.executed === true && isDeepStrictEqual(value.unsupported, []) && value.native_error === null && isDeepStrictEqual(value.native_diagnostics, []) && value.resolved_file_name === expected && value.request_descriptor_id === request && value.producer_artifact_id === producer && value.sdk_input_id === sdk;
}

type ResolutionFixture = { name: string; sourceName?: string; config?: string; files?: Record<string, string>; directories?: string[]; links?: Record<string, string>; specifier?: string; unreadableConfig?: boolean; rejectEscapedTarget?: boolean; compilerFailure?: boolean; mode?: "import" | "require" };
const liveDefaults = { target: "es2022", module: "esnext", moduleResolution: "bundler", allowJs: true, skipLibCheck: true };
const liveConfig = JSON.stringify({ compilerOptions: liveDefaults });
const nodeNextConfig = JSON.stringify({ compilerOptions: { target: "es2022", module: "nodenext", moduleResolution: "nodenext", allowJs: true } });
const dualFiles = { "node_modules/dual/package.json": '{"name":"dual","exports":{"import":"./import.d.mts","require":"./require.d.cts"}}', "node_modules/dual/import.d.mts": "export declare const value: number;", "node_modules/dual/require.d.cts": "export declare const value: number;" };
const additionalFixtures: ResolutionFixture[] = [
  { name: "configuration-absent" },
  { name: "configuration-malformed", config: "{ broken", compilerFailure: true },
  { name: "configuration-read-failed", config: liveConfig, unreadableConfig: true, compilerFailure: true },
  { name: "module-missing", config: liveConfig, specifier: "./missing", compilerFailure: true },
  { name: "directory-only", config: liveConfig, specifier: "./directory", directories: ["directory"], compilerFailure: true },
  { name: "canonical-source-escape", config: liveConfig, specifier: "./escaped", links: { "escaped.ts": "../outside.ts" }, rejectEscapedTarget: true },
  { name: "canonical-source-internal", config: liveConfig, specifier: "./internal", links: { "internal.ts": "target.ts" } },
  ...["mts", "cts", "mjs", "cjs"].map(extension => ({ name: `implied-format-${extension}`, sourceName: `main.${extension}`, config: nodeNextConfig, specifier: "dual", mode: extension === "mts" || extension === "mjs" ? "import" as const : "require" as const, files: dualFiles })),
  ...["module", "commonjs"].map(type => ({ name: `package-implied-${type}`, config: nodeNextConfig, specifier: "dual", mode: type === "module" ? "import" as const : "require" as const, files: { ...dualFiles, "package.json": JSON.stringify({ type }) } })),
];

async function runAdditionalLiveResolution(ctx: CampaignContext, libraries: string[]): Promise<LiveFilesystemWitness> {
  const started = performance.now();
  const properties: PropertyResult[] = [];
  const evidence: Evidence[] = [];
  const producerId = `sha256:${sha(await readFile(ctx.producer))}`;
  const sdkId = digest(JSON.parse(await readFile(ctx.sdk, "utf8")));
  for (const fixture of additionalFixtures) {
    const location = resolve(ctx.out, "live-fs", fixture.name);
    await mkdir(resolve(location, "repository"), { recursive: true });
    const root = await realpath(resolve(location, "repository"));
    const sourceName = fixture.sourceName ?? "main.ts";
    const specifier = fixture.specifier ?? "./target";
    const files = { [sourceName]: `import { value } from ${JSON.stringify(specifier)}; export { value };`, "target.ts": "export const value = 1;", ...fixture.files, ...(fixture.config === undefined ? {} : { "tsconfig.json": fixture.config }) };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(resolve(root, path)), { recursive: true });
      await writeFile(resolve(root, path), text);
    }
    for (const directory of fixture.directories ?? []) await mkdir(resolve(root, directory), { recursive: true });
    if (fixture.rejectEscapedTarget) await writeFile(resolve(root, "../outside.ts"), "export const value = 2;");
    for (const [path, target] of Object.entries(fixture.links ?? {})) await symlink(resolve(root, target), resolve(root, path));
    evidence.push(await save(resolve(location, "authored-fixture.json"), { authority: "Authored fixture roles and bytes, fixed before either oracle or producer execution", files, directories: fixture.directories ?? [], links: fixture.links ?? {}, unreadableConfig: fixture.unreadableConfig ?? false, rejectEscapedTarget: fixture.rejectEscapedTarget ?? false }));
    const oracleProject = { ...(fixture.config === undefined ? {} : { extends: "./repository/tsconfig.json" }), compilerOptions: { ...liveDefaults, noLib: true, noEmit: true, ...(fixture.config === nodeNextConfig ? { module: "nodenext", moduleResolution: "nodenext" } : {}) }, files: [resolve(root, sourceName), ...libraries], include: [] };
    evidence.push(await save(resolve(location, "oracle-project.json"), oracleProject));
    const inventory = Object.keys(files).filter(path => !(fixture.unreadableConfig && path === "tsconfig.json")).map(path => resolve(root, path));
    const request = { root, inventory, queries: [], resolution: { containing_file: resolve(root, sourceName), specifier, ...(fixture.mode === undefined ? {} : { mode: fixture.mode }) } };
    evidence.push(await save(resolve(location, "request.json"), request));
    if (fixture.unreadableConfig) await chmod(resolve(root, "tsconfig.json"), 0);
    try {
      const oracle = await ctx.run(`live-fs-${fixture.name}-oracle`, [ctx.oracle, "--noEmit", "--pretty", "false", "--traceResolution", "--project", resolve(location, "oracle-project.json")], root);
      evidence.push(...oracle.evidence);
      let reference: string | null | undefined;
      let traceError: string | undefined;
      try { reference = resolutionFromTrace(oracle.stdout, specifier); } catch (error) { traceError = String(error); }
      let referenceMode: "import" | "require" | undefined;
      let modeError: string | undefined;
      if (fixture.mode !== undefined) {
        try { referenceMode = resolutionModeFromTrace(oracle.stdout, specifier, resolve(root, sourceName)); }
        catch (error) { modeError = String(error); }
      }
      const expected = fixture.rejectEscapedTarget ? null : reference;
      const oracleReady = traceError === undefined && modeError === undefined && (fixture.mode === undefined || fixture.mode === referenceMode) && oracle.stderr.trim() === "" && oracle.exitCode === (fixture.compilerFailure ? 2 : 0) && (!fixture.rejectEscapedTarget || reference !== null);
      evidence.push(await save(resolve(location, "independent-expected.json"), { authority: fixture.rejectEscapedTarget ? "Pinned TS7 native trace followed by the owning contract's canonical source-root confinement; authored escaped alias must be rejected" : "Pinned TS7 native filesystem trace, emitted before producer execution", reference, expected, traceError, referenceMode, requestedMode: fixture.mode ?? "omitted", modeError, nativeImpliedFormatInferenceProven: false, oracleReady }));
      const native = await ctx.run(`live-fs-${fixture.name}-producer`, [ctx.producer, "--observe-live-configured-resolution", resolve(location, "request.json"), ctx.sdk], root);
      evidence.push(...native.evidence);
      let actual: Record<string, unknown>;
      try { actual = object(JSON.parse(native.stdout)); } catch { actual = {}; }
      const compared = expected !== undefined && evaluateLiveResolution(actual, expected, digest(request), producerId, sdkId);
      const nativeFailures = Array.isArray(actual.nativeFsFailures) ? actual.nativeFsFailures.map(object) : [];
      const readFailureActivated = !fixture.unreadableConfig || nativeFailures.some(failure => failure.path === resolve(root, "tsconfig.json") && typeof failure.reason === "string" && failure.reason.startsWith("LIVE_READ_FAILED:"));
      const probes = Array.isArray(actual.probes) ? actual.probes.map(object) : [];
      const absentActivated = fixture.config !== undefined || probes.some(probe => probe.operation === "file_exists" && probe.path === resolve(root, "tsconfig.json") && probe.found === false);
      const configReadAttributed = configurationReadAttributed(actual, resolve(root, "tsconfig.json"), fixture.config === undefined ? undefined : fixture.unreadableConfig ? null : fixture.config);
      const directoryActivated = fixture.name !== "directory-only" || probes.some(probe => probe.operation === "directory_exists" && probe.path === resolve(root, "directory") && probe.found === true);
      properties.push({ property: `live ${fixture.name}: complete configured target and activation`, status: oracleReady && native.exitCode === 0 && native.stderr.trim() === "" && compared && readFailureActivated && absentActivated && directoryActivated && configReadAttributed ? "pass" : "fail", reason: `Independent TS7 target=${String(reference)}; contract target=${String(expected)}; oracleReady=${oracleReady}; readFailureActivated=${readFailureActivated}; absentActivated=${absentActivated}; directoryActivated=${directoryActivated}; configReadAttributed=${configReadAttributed}; callerMode=${fixture.mode ?? "omitted"}; independentTS7Mode=${String(referenceMode)}. Explicit caller modes do not prove native format inference. Config/mode/input omissions are not treated as executed branches.`, evidence: [...oracle.evidence, ...native.evidence] });
      if (fixture.config === undefined || fixture.unreadableConfig || fixture.name === "configuration-malformed") {
        const bound = actual.request_descriptor_id === digest(request) && actual.producer_artifact_id === producerId && actual.sdk_input_id === sdkId;
        properties.push({ property: `live ${fixture.name}: owning configuration probe/read activation and input attribution`, status: oracleReady && native.exitCode === 0 && native.stderr.trim() === "" && actual.executed === true && bound && readFailureActivated && absentActivated && configReadAttributed ? "pass" : "fail", reason: "The native filesystem configuration branch must actually be observed; this activation property does not assert that the resulting module target is correct.", evidence: [...oracle.evidence, ...native.evidence] });
      }
      evidence.push(await save(resolve(location, "comparison.json"), { reference, expected, actual, properties: properties.filter(property => property.property.startsWith(`live ${fixture.name}:`)), endpointMode: fixture.mode ?? "omitted", independentTS7Mode: referenceMode, nativeImpliedFormatInferenceProven: false }));
    } finally {
      if (fixture.unreadableConfig) await chmod(resolve(root, "tsconfig.json"), 0o600);
    }
  }
  const closest = await closestConfigurationVisibility(ctx, producerId);
  properties.push(...closest.properties);
  evidence.push(...closest.evidence);
  return { properties, evidence, durationMs: performance.now() - started };
}

async function closestConfigurationVisibility(ctx: CampaignContext, producerId: string): Promise<LiveFilesystemWitness> {
  const started = performance.now();
  const location = resolve(ctx.out, "live-fs", "closest-configuration-refused");
  await mkdir(resolve(location, "repository"), { recursive: true });
  const root = await realpath(resolve(location, "repository"));
  const containing = resolve(root, "main.ts");
  await writeFile(containing, "export const value = 1;");
  await writeFile(resolve(root, "../outside.json"), liveConfig);
  const path = resolve(root, "tsconfig.json");
  await symlink(resolve(root, "../outside.json"), path);
  const expected = [{ operation: "file_exists", path, value: true }, { operation: "read_file", path, value: null }];
  const request = { root, inventory: [containing], queries: expected.map(({ operation, path }) => ({ operation, path })) };
  const evidence = [await save(resolve(location, "request.json"), request), await save(resolve(location, "independent-expected.json"), { authority: "Frozen owning workspaceLinkedSystem.fileExists contract: closest present tsconfig remains visible before canonical read refusal, preventing parent/default fallback", expected })];
  const native = await ctx.run("live-fs-closest-config-refused-producer", [ctx.producer, "--observe-live-system", resolve(location, "request.json")], root);
  evidence.push(...native.evidence);
  let observed: Record<string, unknown>;
  try { observed = object(JSON.parse(native.stdout)); } catch { observed = {}; }
  const properties: PropertyResult[] = [{ property: "live closest present tsconfig remains visible when canonical read is refused", status: native.exitCode === 0 && native.stderr.trim() === "" && observed.request_descriptor_id === digest(request) && observed.producer_artifact_id === producerId && evaluateLiveObservation(observed, expected) && object(observed.inputs)[path] === null ? "pass" : "fail", reason: "Independent explicit owning-consumer visibility exception; fileExists=true and readFile=undefined are both required on the same existing escaped tsconfig.", evidence }];
  const rows = Array.isArray(observed.results) ? observed.results.map(object) : [];
  properties.push({ property: "live escaped closest tsconfig read is refused and attributed undefined", status: native.exitCode === 0 && native.stderr.trim() === "" && observed.executed === true && observed.request_descriptor_id === digest(request) && observed.producer_artifact_id === producerId && rows.some(row => row.operation === "read_file" && row.path === path && row.value === null) && object(observed.inputs)[path] === null ? "pass" : "fail", reason: "This independent read-refusal control remains distinct from the closest-configuration visibility exception.", evidence });
  evidence.push(await save(resolve(location, "comparison.json"), { expected, observed, properties }));
  return { properties, evidence, durationMs: performance.now() - started };
}

export function resolutionModeFromTrace(output: string, specifier: string, containingFile: string): "import" | "require" {
  const start = `======== Resolving module '${specifier}' from '${containingFile}'. ========`;
  const modes = new Set<"import" | "require">();
  let selected = false;
  for (const line of output.replaceAll("\r\n", "\n").split("\n")) {
    if (line.startsWith("======== Resolving module ")) { selected = line === start; continue; }
    if (!selected) continue;
    if (line.startsWith("======== Module name ")) { selected = false; continue; }
    const conditions = /^Resolving in (?:ESM|CJS) mode with conditions (.+)\.$/.exec(line)?.[1];
    if (conditions === undefined) continue;
    const imported = conditions.includes("'import'");
    const required = conditions.includes("'require'");
    if (imported === required) throw new Error("unsupported TS7 resolution mode conditions");
    modes.add(imported ? "import" : "require");
  }
  if (modes.size !== 1) throw new Error("missing or contradictory TS7 resolution mode");
  return [...modes][0]!;
}

export function configurationReadAttributed(observed: unknown, path: string, expected: string | null | undefined): boolean {
  if (expected === undefined) return true;
  const value = object(observed);
  if (object(value.inputs)[path] !== expected) return false;
  const probes = Array.isArray(value.probes) ? value.probes.map(object) : [];
  const contentId = expected === null ? undefined : `sha256:${sha(expected)}`;
  return probes.some(probe => probe.operation === "read_file" && probe.path === path && probe.found === (expected !== null) && (expected === null || probe.content_id === contentId));
}
