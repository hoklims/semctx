import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CampaignContext, Evidence, PropertyResult } from "./t00-ts7-q-config-campaign";
import { resolutionFromTrace } from "./t00-ts7-q-config-cr";
import { evaluateLiveResolution, resolutionModeFromTrace } from "./t00-ts7-q-config-live-fs";

export type ResolutionHostExpected = {
  results: unknown[];
  trace: unknown[];
  faultsActivated: unknown[];
  nativeFailures: unknown[];
};

export function configuredSourceModeMatches(
  observed: unknown,
  source: string,
  mode: "import" | "require" | "omitted" | null,
  contentId: string,
): boolean {
  const value = object(object(observed).resolutionObservations);
  return isDeepStrictEqual(value.implied_modes, mode === null ? {} : { [source]: mode })
    && isDeepStrictEqual(value.source_acquisition, mode === null ? {} : { [source]: contentId });
}

export function evaluateResolutionHost(
  observed: unknown,
  expected: ResolutionHostExpected,
  requestId: string,
  producerId: string,
): boolean {
  if (observed === null || typeof observed !== "object" || Array.isArray(observed)) return false;
  const value = observed as Record<string, unknown>;
  return expected.results.length > 0 && expected.trace.length > 0
    && value.executed === true
    && value.source === "native"
    && isDeepStrictEqual(value.unsupported, [])
    && value.request_descriptor_id === requestId
    && value.producer_artifact_id === producerId
    && isDeepStrictEqual(value.results, expected.results)
    && isDeepStrictEqual(value.trace, expected.trace)
    && isDeepStrictEqual(value.faultsActivated, expected.faultsActivated)
    && isDeepStrictEqual(value.nativeFailures, expected.nativeFailures);
}

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const canonical = (value: unknown): string => JSON.stringify(value, (_key, nested: unknown) => nested !== null && typeof nested === "object" && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : nested);
const digest = (value: unknown) => `sha256:${sha(canonical(value))}`;
async function save(path: string, value: unknown): Promise<Evidence> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, text);
  return { path, bytes: Buffer.byteLength(text), sha256: sha(text) };
}

export type ResolutionAlternativesWitness = {
  propertiesByObligation: Record<number, PropertyResult[]>;
  evidence: Evidence[];
  durationMs: number;
};

export async function runResolutionAlternatives(ctx: CampaignContext): Promise<ResolutionAlternativesWitness> {
  const started = performance.now();
  const location = resolve(ctx.out, "resolution-host-alternatives");
  await mkdir(resolve(location, "repository"), { recursive: true });
  const root = await realpath(resolve(location, "repository"));
  const path = resolve(root, "value.json");
  const outside = resolve(location, "outside.json");
  await writeFile(path, "physical text");
  await writeFile(outside, "outside text");
  const directory = resolve(root, "Directory");
  const missing = resolve(root, "Missing.json");
  const alias = resolve(root, "Alias.json");
  const escaped = resolve(root, "Escaped.json");
  const cycle = resolve(root, "Cycle.json");
  const changedCase = resolve(root, "../REPOSITORY/value.json");
  await mkdir(directory);
  await symlink(path, alias);
  await symlink(outside, escaped);
  await symlink(cycle, cycle);
  const step = (system: string, operation: string, value: unknown, queryPath = path) => ({ system, operation, path: queryPath, value });
  const fault = (system: string, operation: string, outcome: string, queryPath = path) => ({ system, operation, path: queryPath, outcome });
  const admitted = step("admission", "admitted", true);
  const physical = step("physical", "file_exists", true);
  const cases = [
    { name: "file-both-true", index: 202, operation: "file_exists", path, value: true, faults: [], trace: [admitted, physical, step("configuration", "file_exists", true)], failures: [] },
    { name: "file-physical-false", index: 202, operation: "file_exists", path, value: false, faults: [fault("physical", "file_exists", "false")], trace: [admitted, step("physical", "file_exists", false)], failures: [] },
    { name: "file-configuration-false", index: 202, operation: "file_exists", path, value: false, faults: [fault("configuration", "file_exists", "false")], trace: [admitted, physical, step("configuration", "file_exists", false)], failures: [] },
    { name: "file-unadmitted", index: 202, operation: "file_exists", path: outside, value: false, faults: [], trace: [step("admission", "admitted", false, outside)], failures: [] },
    { name: "read-both-true", index: 203, operation: "read_file", path, value: "physical text", faults: [], trace: [admitted, physical, step("configuration", "read_file", "physical text")], failures: [] },
    { name: "read-physical-false", index: 203, operation: "read_file", path, value: null, faults: [fault("physical", "file_exists", "false")], trace: [admitted, step("physical", "file_exists", false)], failures: [] },
    { name: "read-undefined", index: 203, operation: "read_file", path, value: null, faults: [fault("configuration", "read_file", "undefined")], trace: [admitted, physical, step("configuration", "read_file", null)], failures: [] },
    { name: "read-injected-failure", index: 203, operation: "read_file", path, value: null, faults: [fault("configuration", "read_file", "read_failure")], trace: [admitted, physical, step("configuration", "read_file", null)], failures: [{ path, reason: "TEST_INJECTED_READ_FAILURE" }] },
    { name: "read-unadmitted", index: 203, operation: "read_file", path: outside, value: null, faults: [], trace: [step("admission", "admitted", false, outside)], failures: [] },
    { name: "directory-both-true", index: 201, operation: "directory_exists", path: directory, value: true, faults: [], trace: [step("admission", "admitted", true, directory), step("physical", "directory_exists", true, directory), step("configuration", "directory_exists", true, directory)], failures: [] },
    { name: "directory-physical-false", index: 201, operation: "directory_exists", path: directory, value: false, faults: [fault("physical", "directory_exists", "false", directory)], trace: [step("admission", "admitted", true, directory), step("physical", "directory_exists", false, directory)], failures: [] },
    { name: "directory-configuration-false", index: 201, operation: "directory_exists", path: directory, value: false, faults: [fault("configuration", "directory_exists", "false", directory)], trace: [step("admission", "admitted", true, directory), step("physical", "directory_exists", true, directory), step("configuration", "directory_exists", false, directory)], failures: [] },
    { name: "directory-unadmitted", index: 201, operation: "directory_exists", path: outside, value: false, faults: [], trace: [step("admission", "admitted", false, outside)], failures: [] },
    { name: "realpath-file", index: 204, operation: "realpath", path, value: path, faults: [], trace: [admitted, physical, step("configuration", "realpath", path)], failures: [] },
    { name: "realpath-directory", index: 204, operation: "realpath", path: directory, value: directory, faults: [], trace: [step("admission", "admitted", true, directory), step("physical", "file_exists", false, directory), step("physical", "directory_exists", true, directory), step("configuration", "realpath", directory, directory)], failures: [] },
    { name: "realpath-neither", index: 204, operation: "realpath", path: missing, value: missing, faults: [], trace: [step("admission", "admitted", true, missing), step("physical", "file_exists", false, missing), step("physical", "directory_exists", false, missing)], failures: [] },
    { name: "realpath-canonical-alias", index: 204, operation: "realpath", path: alias, value: path, faults: [], trace: [step("admission", "admitted", true, alias), step("physical", "file_exists", true, alias), step("configuration", "realpath", path, alias)], failures: [] },
    { name: "realpath-lexical-fallback", index: 204, operation: "realpath", path: alias, value: alias, faults: [fault("configuration", "realpath", "lexical_fallback", alias)], trace: [step("admission", "admitted", true, alias), step("physical", "file_exists", true, alias), step("configuration", "realpath", alias, alias)], failures: [] },
    { name: "realpath-canonical-escape", index: 204, operation: "realpath", path: escaped, value: escaped, faults: [], trace: [step("admission", "admitted", false, escaped)], failures: [] },
    { name: "realpath-native-cycle", index: 204, operation: "realpath", path: cycle, value: cycle, faults: [], trace: [step("admission", "admitted", false, cycle)], failures: [] },
    { name: "file-lexical-root-case", index: 202, operation: "file_exists", path: changedCase, value: false, faults: [], trace: [step("admission", "admitted", false, changedCase)], failures: [] },
    { name: "read-lexical-root-case", index: 203, operation: "read_file", path: changedCase, value: null, faults: [], trace: [step("admission", "admitted", false, changedCase)], failures: [] },
    { name: "directory-lexical-root-case", index: 201, operation: "directory_exists", path: changedCase, value: false, faults: [], trace: [step("admission", "admitted", false, changedCase)], failures: [] },
    { name: "realpath-lexical-root-case", index: 204, operation: "realpath", path: changedCase, value: changedCase, faults: [], trace: [step("admission", "admitted", false, changedCase)], failures: [] },
  ];
  const producerId = `sha256:${sha(await readFile(ctx.producer))}`;
  const evidence: Evidence[] = [];
  const propertiesByObligation: Record<number, PropertyResult[]> = { 201: [], 202: [], 203: [], 204: [] };
  for (const fixture of cases) {
    const request = { root, inventory: [path], queries: [{ operation: fixture.operation, path: fixture.path }], faults: fixture.faults };
    const expected: ResolutionHostExpected = { results: [{ operation: fixture.operation, path: fixture.path, value: fixture.value }], trace: fixture.trace, faultsActivated: fixture.faults, nativeFailures: fixture.failures };
    const requestPath = resolve(location, `${fixture.name}-request.json`);
    evidence.push(await save(requestPath, request));
    evidence.push(await save(resolve(location, `${fixture.name}-expected.json`), { authority: "Finite ts-symbols.resolveConfiguredModule admission/delegate conjunction and lexical fallback contract; fixture values authored before producer execution. Injected read failure and lexical fallback are test-only delegate results, not native OS exceptions or literally absent JavaScript methods.", expected, nativeFixture: { directory, missing, alias: { path: alias, target: path }, escape: { path: escaped, target: outside }, cycle } }));
    const native = await ctx.run(`resolution-host-${fixture.name}`, [ctx.producer, "--observe-resolution-host", requestPath], root);
    evidence.push(...native.evidence);
    let observed: unknown;
    try { observed = JSON.parse(native.stdout); }
    catch { observed = null; }
    const passed = native.exitCode === 0 && native.stderr.trim() === "" && evaluateResolutionHost(observed, expected, digest(request), producerId);
    const property: PropertyResult = { property: `resolution host ${fixture.name}: exact result and consumed short-circuit trace`, status: passed ? "pass" : "fail", reason: `Independent finite contract projection at the actual configured resolution host; native fixture with ${fixture.faults.length} test-only delegate fault(s); exit=${native.exitCode}.`, evidence: native.evidence };
    propertiesByObligation[fixture.index]!.push(property);
    evidence.push(await save(resolve(location, `${fixture.name}-comparison.json`), { expected, observed, property }));
  }
  return { propertiesByObligation, evidence, durationMs: performance.now() - started };
}

type ConfiguredFixture = {
  name: string;
  sourceName: string;
  impliedMode: "import" | "require" | "omitted";
  nodeNext?: boolean;
  packageType?: "module" | "commonjs";
  boundary?: "present" | "absent" | "captured";
  inventory?: "omitted" | "empty";
  configAbsent?: boolean;
};

export async function runConfiguredSystemWitnesses(ctx: CampaignContext, libraries: string[]): Promise<ResolutionAlternativesWitness> {
  const started = performance.now();
  const propertiesByObligation: Record<number, PropertyResult[]> = { 198: [], 199: [], 200: [] };
  const evidence: Evidence[] = [];
  const producerId = `sha256:${sha(await readFile(ctx.producer))}`;
  const sdkId = digest(JSON.parse(await readFile(ctx.sdk, "utf8")));
  const fixtures: ConfiguredFixture[] = [
    ...["mts", "mjs"].map(extension => ({ name: `native-implied-${extension}`, sourceName: `entry.${extension}`, impliedMode: "import" as const, nodeNext: true })),
    ...["cts", "cjs"].map(extension => ({ name: `native-implied-${extension}`, sourceName: `entry.${extension}`, impliedMode: "require" as const, nodeNext: true })),
    ...["module", "commonjs"].map(packageType => ({ name: `native-package-${packageType}`, sourceName: "entry.ts", impliedMode: packageType === "module" ? "import" as const : "require" as const, packageType: packageType as "module" | "commonjs", nodeNext: true })),
    { name: "native-bundler-default-mode", sourceName: "entry.ts", impliedMode: "omitted", packageType: "commonjs" },
    { name: "native-implied-inventory-omitted", sourceName: "entry.mts", impliedMode: "import", nodeNext: true, inventory: "omitted" },
    { name: "native-implied-inventory-empty", sourceName: "entry.mts", impliedMode: "import", nodeNext: true, inventory: "empty" },
    { name: "native-root-present", sourceName: "entry.ts", impliedMode: "omitted", boundary: "present" },
    { name: "native-root-absent", sourceName: "entry.ts", impliedMode: "omitted", boundary: "absent" },
    { name: "explicit-captured-system", sourceName: "entry.ts", impliedMode: "omitted", boundary: "captured" },
    { name: "native-configuration-absent", sourceName: "entry.ts", impliedMode: "omitted", configAbsent: true },
  ];
  for (const fixture of fixtures) {
    const location = resolve(ctx.out, "configured-system", fixture.name);
    await mkdir(resolve(location, "Sandbox", "Repository"), { recursive: true });
    const sandbox = await realpath(resolve(location, "Sandbox"));
    const repository = resolve(sandbox, "Repository");
    const containing = resolve(repository, fixture.sourceName);
    const specifier = fixture.boundary === undefined ? "dual" : "../Sibling/value";
    const text = `import { value } from ${JSON.stringify(specifier)}; export { value };\n`;
    const configuration = JSON.stringify({ compilerOptions: { target: "es2022", module: fixture.nodeNext ? "nodenext" : "esnext", moduleResolution: fixture.nodeNext ? "nodenext" : "bundler", allowJs: true, skipLibCheck: true, noEmit: true } });
    const files: Record<string, string> = {
      [containing]: text,
      [resolve(repository, "node_modules/dual/package.json")]: '{"name":"dual","exports":{"import":"./import.d.mts","require":"./require.d.cts"}}',
      [resolve(repository, "node_modules/dual/import.d.mts")]: "export declare const value: 1;",
      [resolve(repository, "node_modules/dual/require.d.cts")]: "export declare const value: 2;",
      ...(fixture.boundary === undefined ? {} : { [resolve(sandbox, "Sibling/value.ts")]: "export const value = 3;" }),
      ...(fixture.packageType === undefined ? {} : { [resolve(repository, "package.json")]: JSON.stringify({ type: fixture.packageType }) }),
      ...(fixture.configAbsent ? {} : { [resolve(repository, "tsconfig.json")]: configuration }),
    };
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    }
    const project = { ...(fixture.configAbsent ? {} : { extends: "./Sandbox/Repository/tsconfig.json" }), compilerOptions: { target: "es2022", module: fixture.nodeNext ? "nodenext" : "esnext", moduleResolution: fixture.nodeNext ? "nodenext" : "bundler", allowJs: true, noLib: true, skipLibCheck: true, noEmit: true }, files: [containing, ...libraries], include: [] };
    const oraclePath = resolve(location, "oracle-project.json");
    evidence.push(await save(oraclePath, project), await save(resolve(location, "authored-fixture.json"), { fixture, files }));
    const oracle = await ctx.run(`configured-system-${fixture.name}-oracle`, [ctx.oracle, "--noEmit", "--pretty", "false", "--traceResolution", "--project", oraclePath], repository);
    evidence.push(...oracle.evidence);
    let reference: string | null | undefined;
    let referenceMode: "import" | "require" | undefined;
    let oracleError: string | undefined;
    try { reference = resolutionFromTrace(oracle.stdout, specifier); referenceMode = resolutionModeFromTrace(oracle.stdout, specifier, containing); }
    catch (error) { oracleError = String(error); }
    const oracleReady = libraries.length === 115 && oracle.exitCode === 0 && oracle.stderr.trim() === "" && oracleError === undefined && reference !== undefined && reference !== null && (!fixture.nodeNext || referenceMode === fixture.impliedMode);
    const expected = fixture.boundary === "present" ? null : reference;
    evidence.push(await save(resolve(location, "independent-expected.json"), { authority: "Pinned independent TS7 native-FS trace and SDK115; only root-present outside target is projected to null by the frozen lexical/canonical root contract. Native default-mode labels are authored from pinned TS7 source metadata semantics; Bundler ordinary .ts default remains omitted even when its import usage trace selects import conditions.", reference, referenceMode, expected, impliedMode: fixture.impliedMode, oracleReady, oracleError }));
    const callerModes: ("omitted" | "import" | "require")[] = fixture.boundary === "captured" ? ["import"] : fixture.boundary !== undefined || fixture.configAbsent ? ["omitted"] : ["omitted", referenceMode ?? "import"];
    for (const callerMode of callerModes) {
      const captured = fixture.boundary === "captured";
      const root = fixture.boundary === "present" || fixture.boundary === "absent" ? sandbox : repository;
      const request = captured
        ? { root, system: "captured", files, queries: [], resolution: { containing_file: containing, specifier, mode: callerMode } }
        : { root, ...(fixture.boundary === undefined ? {} : { repository_root: fixture.boundary === "absent" ? null : repository }), ...(fixture.inventory === "omitted" ? {} : { inventory: fixture.inventory === "empty" ? [] : Object.keys(files) }), queries: [], resolution: { containing_file: containing, specifier, ...(callerMode === "omitted" ? {} : { mode: callerMode }) } };
      const requestPath = resolve(location, `${callerMode}-request.json`);
      evidence.push(await save(requestPath, request));
      const native = await ctx.run(`configured-system-${fixture.name}-${callerMode}`, [ctx.producer, captured ? "--observe-resolution-host" : "--observe-live-configured-resolution", requestPath, ...(captured ? [] : [ctx.sdk])], root);
      evidence.push(...native.evidence);
      let observed: Record<string, unknown>;
      try { observed = object(JSON.parse(native.stdout)); } catch { observed = {}; }
      const compared = expected !== undefined && (captured
        ? observed.executed === true && observed.source === "captured_explicit" && observed.systemSelection === "captured" && isDeepStrictEqual(observed.unsupported, []) && observed.native_error === null && isDeepStrictEqual(observed.native_diagnostics, []) && observed.resolved_file_name === expected && observed.request_descriptor_id === digest(request) && observed.producer_artifact_id === producerId
        : evaluateLiveResolution(observed, expected, digest(request), producerId, sdkId));
      const modeMatches = configuredSourceModeMatches(observed, containing, callerMode === "omitted" ? fixture.impliedMode : null, `sha256:${sha(text)}`);
      const causalSourceAbsent = !Object.hasOwn(object(observed.inputs), containing);
      const common = oracleReady && native.exitCode === 0 && native.stderr.trim() === "" && compared && modeMatches && causalSourceAbsent;
      const properties: PropertyResult[] = [{ property: `configured system ${fixture.name}/${callerMode}: exact target, native mode owner and separate source acquisition`, status: common ? "pass" : "fail", reason: `Independent TS7 target=${String(reference)}; contract target=${String(expected)}; caller=${callerMode}; expected getter=${callerMode === "omitted" ? fixture.impliedMode : "not called"}; modeMatches=${modeMatches}; sourceAbsentFromCausalInputs=${causalSourceAbsent}; oracleReady=${oracleReady}.`, evidence: [...oracle.evidence, ...native.evidence] }];
      propertiesByObligation[198]!.push(...properties);
      const probes = Array.isArray(observed.probes) ? observed.probes.map(object) : [];
      const configPath = resolve(repository, "tsconfig.json");
      if (!captured) {
        const discovery = probes.some(probe => probe.operation === "file_exists" && probe.path === configPath && probe.found === !fixture.configAbsent);
        const discoveryProperty: PropertyResult = { property: `configuration discovery callback ${fixture.name}/${callerMode}: exact live delegate`, status: common && discovery ? "pass" : "fail", reason: "The owning configuration lookup must execute the actual live fileExists delegate at the exact candidate path, with present/absent result matching authored configuration presence.", evidence: native.evidence };
        properties.push(discoveryProperty); propertiesByObligation[199]!.push(discoveryProperty);
      }
      const read = fixture.configAbsent
        ? !probes.some(probe => probe.operation === "read_file" && probe.path === configPath)
        : probes.some(probe => probe.operation === "read_file" && probe.path === configPath && probe.found === true && probe.content_id === `sha256:${sha(configuration)}`);
      const readProperty: PropertyResult = { property: `configuration read callback ${fixture.name}/${callerMode}: exact read or absent-config short circuit`, status: common && read ? "pass" : "fail", reason: "A present config requires its executed read_file probe bound to independent authored bytes; absence requires no config read. Acquisition maps cannot substitute for a read.", evidence: native.evidence };
      properties.push(readProperty); propertiesByObligation[200]!.push(readProperty);
      evidence.push(await save(resolve(location, `${callerMode}-comparison.json`), { reference, referenceMode, expected, observed, properties }));
    }
  }
  return { propertiesByObligation, evidence, durationMs: performance.now() - started };
}
