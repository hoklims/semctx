import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sha256, type CampaignContext, type Evidence, type ObligationResult, type PropertyResult } from "./t00-ts7-q-config-campaign";

type Value = Record<string, unknown>;
type Read = { path: string; content: string | null; consumed_before_delegate: boolean };
type Pass = { snapshot: number; inspection: { cached: boolean; reasons: string[]; consumed: string[]; reads: Read[] }; normalizations: { input: string; normalized: string }[] };
type Expected = { caseSensitive: boolean; passes: Pass[] };
const object = (value: unknown): Value => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const canonical = (value: unknown): string => JSON.stringify(value, (_key, nested: unknown) => nested !== null && typeof nested === "object" && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : nested);
const sortedReads = (reads: Read[]): Read[] => [...reads].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
const namedReason = "SOURCE_NAMED_CONFIGURATION_UNSUPPORTED";

export function normalizeNamedPath(root: string, path: string, sensitive: boolean): string {
  const normalized = posix.resolve(root, path).replaceAll("\\", "/");
  return sensitive ? normalized : normalized.toLowerCase();
}

export function namedConfigurationBound(code: number, stderr: string, value: unknown, request: string, producer: string): boolean {
  const observed = object(value);
  return code === 0 && stderr.trim() === "" && observed.request_descriptor_id === request && observed.producer_artifact_id === producer;
}

export function compareNamedConfigurationObservation(value: unknown, expected: Expected): boolean {
  const observed = object(value);
  if (observed.executed !== true || observed.global_admission_inferred !== false || observed.case_sensitive !== expected.caseSensitive || !isDeepStrictEqual(observed.unsupported, []) || observed.status !== "development_observation_not_qualification" || !Array.isArray(observed.passes) || expected.passes.length === 0 || observed.passes.length !== expected.passes.length) return false;
  const passes = observed.passes;
  return expected.passes.every((wanted, index) => {
    const actual = object(passes[index]);
    const inspection = object(actual.inspection);
    if (actual.snapshot !== wanted.snapshot || inspection.cached !== wanted.inspection.cached || !Array.isArray(actual.normalizations)) return false;
    const normalizations = actual.normalizations.map(value => object(value));
    if (normalizations.some(value => typeof value.input !== "string" || typeof value.normalized !== "string") || new Set(normalizations.map(value => value.input)).size !== normalizations.length) return false;
    const sort = (values: { input: string; normalized: string }[]) => [...values].sort((a, b) => a.input < b.input ? -1 : a.input > b.input ? 1 : 0);
    if (!isDeepStrictEqual(sort(normalizations.map(value => ({ input: value.input as string, normalized: value.normalized as string }))), sort(wanted.normalizations))) return false;
    if (!Array.isArray(inspection.reasons) || !inspection.reasons.every(reason => typeof reason === "string") || !isDeepStrictEqual([...inspection.reasons].sort(), [...wanted.inspection.reasons].sort())) return false;
    if (!Array.isArray(inspection.consumed) || !inspection.consumed.every(path => typeof path === "string") || !isDeepStrictEqual([...inspection.consumed].sort(), [...wanted.inspection.consumed].sort()) || !Array.isArray(inspection.reads)) return false;
    const reads: Read[] = [];
    for (const value of inspection.reads) {
      const read = object(value);
      if (typeof read.path !== "string" || read.content !== null && typeof read.content !== "string" || read.consumed_before_delegate !== true) return false;
      reads.push({ path: read.path, content: read.content, consumed_before_delegate: true });
    }
    return isDeepStrictEqual(sortedReads(reads), sortedReads(wanted.inspection.reads));
  });
}

type Snapshot = { files: Record<string, string>; reads: [string, string | null][]; reasons: string[]; absolute?: boolean; readFailures?: string[] };
type Fixture = { name: string; property: string; role: "activation" | "control"; snapshots: Snapshot[]; passes: number[] };
const source = "export const value=1;";
const extendsNamed = '{"extends":"./tsconfig.extra.json"}';
const basic = { "main.ts": source, "tsconfig.json": extendsNamed, "tsconfig.extra.json": "{}" };
const successful: Snapshot = { files: basic, reads: [["tsconfig.json", extendsNamed], ["tsconfig.extra.json", "{}"]], reasons: [] };
const unconsumed: Snapshot = { files: { ...basic, "tsconfig.json": "{}" }, reads: [["tsconfig.json", "{}"]], reasons: [namedReason] };
const properties = {
  cache: "named snapshot identity, repeated calls and later-pass lifecycle",
  relative: "named relative and absolute normalization with POSIX dot segments",
  backslash: "named POSIX resolution precedes backslash replacement",
  case: "named native-case collisions reach the owning consumer",
  governing: "named governing configurations are unique across source keys",
  sourceParent: "named source parent is derived before source-key normalization",
  reads: "named consumes normalized reads before successful and undefined delegation",
  malformed: "named malformed governing and inherited chains preserve read attribution",
  empty: "named classification bypasses governing reads when no named key exists",
  transitive: "named transitive extends consumption excludes references-only configuration",
  sources: "named source eligibility controls whether governing configurations are inspected",
};
const fixtures: Fixture[] = [];
function pair(name: string, property: string, activation: Snapshot, control: Snapshot): void {
  fixtures.push({ name: `${name}-activation`, property, role: "activation", snapshots: [activation], passes: [0] }, { name: `${name}-control`, property, role: "control", snapshots: [control], passes: [0] });
}
fixtures.push(
  { name: "snapshot-lifecycle-activation", property: properties.cache, role: "activation", snapshots: [successful, unconsumed], passes: [0, 0, 1, 1, 0] },
  { name: "snapshot-lifecycle-control", property: properties.cache, role: "control", snapshots: [successful, successful], passes: [0, 1, 0, 1] },
);
pair("relative-normalization", properties.relative, { ...successful, files: { ...basic, "nested/../tsconfig.extra.json": "{}" } }, { ...successful, absolute: true });
pair("backslash-normalization", properties.backslash, { ...successful, files: { ...basic, "nested\\..\\tsconfig.extra.json": "{}", "\\repo\\tsconfig.extra.json": "{}" }, reasons: [namedReason] }, successful);
pair("case-collision", properties.case, { ...successful, files: { ...basic, "tsconfig.EXTRA.json": "{}" } }, successful);
const governingFiles = { "a/one.ts": source, "a/tsconfig.json": extendsNamed, "a/tsconfig.extra.json": "{}", "b/one.ts": source, "b/tsconfig.json": extendsNamed, "b/tsconfig.extra.json": "{}" };
const governing: Snapshot = { files: governingFiles, reads: [["a/tsconfig.json", extendsNamed], ["a/tsconfig.extra.json", "{}"], ["b/tsconfig.json", extendsNamed], ["b/tsconfig.extra.json", "{}"]], reasons: [] };
pair("unique-governing", properties.governing, { ...governing, files: { ...governingFiles, "a/two.ts": source } }, governing);
pair("initial-read-attribution", properties.reads, { ...successful, readFailures: ["tsconfig.json"], reads: [["tsconfig.json", null]], reasons: [namedReason] }, successful);
pair("inherited-read-attribution", properties.reads, { ...successful, readFailures: ["tsconfig.extra.json"], reads: [["tsconfig.json", extendsNamed], ["tsconfig.extra.json", null]] }, unconsumed);
pair("malformed-chain", properties.malformed,
  { files: { ...basic, "tsconfig.json": "{ broken" }, reads: [["tsconfig.json", "{ broken"]], reasons: [namedReason] },
  { files: { ...basic, "tsconfig.extra.json": "{ broken" }, reads: [["tsconfig.json", extendsNamed], ["tsconfig.extra.json", "{ broken"]], reasons: [] },
);
fixtures.push(
  { name: "no-named-key-activation", property: properties.empty, role: "activation", snapshots: [{ files: { "main.ts": source, "tsconfig.json": "{}", "TSconfig.extra.json": "{}", "tsconfig.extra.JSON": "{}", "other-tsconfig.extra.json": "{}" }, reads: [], reasons: [] }], passes: [0, 0] },
  { name: "no-named-key-control", property: properties.empty, role: "control", snapshots: [unconsumed], passes: [0] },
);
pair("transitive-consumption", properties.transitive,
  { files: { ...basic, "tsconfig.json": '{"extends":"./base.json"}', "base.json": extendsNamed }, reads: [["tsconfig.json", '{"extends":"./base.json"}'], ["base.json", extendsNamed], ["tsconfig.extra.json", "{}"]], reasons: [] },
  { files: { ...basic, "tsconfig.json": '{"references":[{"path":"./tsconfig.extra.json"}]}' }, reads: [["tsconfig.json", '{"references":[{"path":"./tsconfig.extra.json"}]}']], reasons: [namedReason] },
);
pair("source-eligibility", properties.sources,
  { files: { "main.txt": source, "tsconfig.json": extendsNamed, "tsconfig.extra.json": "{}" }, reads: [], reasons: [namedReason] }, successful,
);

pair("source-parent", properties.sourceParent,
  { files: { "src\\extra.ts": source, "tsconfig.json": "{}", "src/tsconfig.json": extendsNamed, "src/tsconfig.extra.json": "{}" }, reads: [["tsconfig.json", "{}"]], reasons: [namedReason] },
  { files: { "src/extra.ts": source, "tsconfig.json": "{}", "src/tsconfig.json": extendsNamed, "src/tsconfig.extra.json": "{}" }, reads: [["src/tsconfig.json", extendsNamed], ["src/tsconfig.extra.json", "{}"]], reasons: [] },
);

const required: Record<number, string[]> = {
  44: Object.values(properties),
  45: [properties.sourceParent],
  46: [properties.relative, properties.backslash, properties.case],
  47: [properties.relative, properties.backslash, properties.case, properties.governing, properties.sourceParent, properties.reads, properties.malformed, properties.transitive],
};
const legacy = ["named-discovery-depth-0", "named-discovery-depth-1", "named-discovery-depth-2", ...["ts", "tsx", "js", "jsx", "mts", "mtsx", "cts", "ctsx", "mjs", "mjsx", "cjs", "cjsx"].map(extension => `named-source-extension-${extension}`), "named-nearest-config", "named-malformed-governing", "named-malformed-extended-consumed", "named-transitive-consumption"];
const gaps: Record<number, string[]> = {
  44: ["named-config cache lifecycle, unique governing configs and malformed config skip", "all named-file classification and consumed extends failure paths"],
  45: [],
  46: ["normalization of relative/backslash/case-colliding named inputs for native case mode"],
  47: ["consumed-read attribution before successful and undefined delegated reads"],
};
function ownedGap(index: number, property: PropertyResult): boolean {
  return property.status === "not_qualified" && ["owning consumer observable rule(s) in canonical family/call-path contract", `obligation ${index}: remaining cumulative consumer boundary`, ...gaps[index]!].includes(property.property);
}

export function closeNamedConfigurationRows(rows: ObligationResult[], results: Map<string, PropertyResult>): ObligationResult[] {
  return rows.map(row => {
    const names = required[row.index];
    if (names === undefined) return row;
    const additions = names.map(property => results.get(property) ?? { property, status: "not_qualified" as const, reason: "The complete activating/control allocation did not execute.", evidence: [] });
    const prior = row.properties.filter(property => !ownedGap(row.index, property));
    const legacyComplete = row.index !== 44 || legacy.every(name => prior.some(property => property.property === name && property.status === "pass"));
    const complete = legacyComplete && prior.every(property => property.status === "pass") && additions.every(property => property.status === "pass" && (property.evidence?.length ?? 0) > 0);
    const combined = [...(complete ? prior : row.properties), ...additions];
    const qualified = complete && combined.every(property => property.status === "pass");
    return { ...row, properties: combined, evidence: [...row.evidence, ...additions.flatMap(property => property.evidence ?? [])], status: qualified ? "qualified" : "not_qualified", reason: qualified && row.index === 45 ? "Nearest governing configuration discovery preserves native dirname before source-key normalization and all allocated source/candidate controls." : qualified ? "Every allocated named-consumer activation/control agrees with the frozen callback/cache contract, including native normalization, immutable snapshot identity, governing deduplication and consume-before-delegate success/failure attribution." : "The cumulative named-consumer closure is incomplete or at least one independent activation/control disagreed; existing gaps remain unqualified." };
  });
}

async function save(path: string, value: unknown): Promise<Evidence> {
  const text = JSON.stringify(value, null, 2) + "\n";
  await writeFile(path, text);
  return { path, sha256: sha256(text), bytes: Buffer.byteLength(text) };
}

async function nativeCaseSensitive(producer: string): Promise<boolean> {
  const swapped = producer.replace(/[a-zA-Z]/g, character => character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase());
  try { await access(swapped); return false; }
  catch (error) { if (object(error).code === "ENOENT") return true; throw error; }
}

export async function enrichNamedConfigurations(ctx: CampaignContext, rows: ObligationResult[]): Promise<ObligationResult[]> {
  const selected = rows.filter(row => required[row.index] !== undefined);
  if (selected.length === 0) return rows;
  const wanted = new Set(selected.flatMap(row => required[row.index]!));
  const sensitive = await nativeCaseSensitive(ctx.producer);
  const producer = `sha256:${sha256(await readFile(ctx.producer))}`;
  const completed: { fixture: Fixture; passed: boolean; evidence: Evidence[] }[] = [];
  const started = performance.now();
  for (const fixture of fixtures.filter(fixture => wanted.has(fixture.property))) {
    const directory = resolve(ctx.out, "config-named", fixture.name);
    await mkdir(resolve(directory, "WORKSPACE"), { recursive: true });
    const root = await realpath(resolve(directory, "WORKSPACE"));
    const snapshots = fixture.snapshots.map(snapshot => ({ files: Object.fromEntries(Object.entries(snapshot.files).map(([path, text]) => [snapshot.absolute ? resolve(root, path) : path, text])), read_failures: snapshot.readFailures ?? [] }));
    const descriptor = { root, snapshots, passes: fixture.passes };
    const seen = new Set<number>();
    const expected: Expected = { caseSensitive: sensitive, passes: fixture.passes.map(snapshot => {
      const plan = fixture.snapshots[snapshot]!;
      const cached = seen.has(snapshot);
      seen.add(snapshot);
      const reads = plan.reads.map(([path, content]) => ({ path: normalizeNamedPath(root, path, sensitive), content, consumed_before_delegate: true }));
      return { snapshot, inspection: { cached, reasons: fixture.property === properties.case && fixture.role === "activation" && sensitive ? [namedReason] : plan.reasons, consumed: [...new Set(reads.map(read => read.path))].sort(), reads: cached ? [] : reads }, normalizations: Object.keys(snapshots[snapshot]!.files).map(input => ({ input, normalized: normalizeNamedPath(root, input, sensitive) })) };
    }) };
    const path = resolve(directory, "request.json");
    const evidence = [await save(path, descriptor)];
    const execution = await ctx.run(`config-named-${fixture.name}`, [ctx.producer, "--observe-named-configuration", path], root);
    evidence.push(...execution.evidence);
    let actual: unknown;
    let parseError: string | undefined;
    try { actual = JSON.parse(execution.stdout); } catch (error) { parseError = String(error); }
    const bound = namedConfigurationBound(execution.exitCode, execution.stderr, actual, `sha256:${sha256(canonical(descriptor))}`, producer);
    const passed = parseError === undefined && bound && compareNamedConfigurationObservation(actual, expected);
    evidence.push(await save(resolve(directory, "comparison.json"), { authority: "Frozen packages/ts-analyzer/src/javascript-diagnostics.ts:340–360: WeakMap snapshot identity, Node.resolve before separator conversion, native case branch, unique governing configs and consume-before-delegate read wrapper; no expected outcome comes from the producer.", fixture: fixture.name, role: fixture.role, property: fixture.property, expected, actual, parseError, bound, passed }));
    completed.push({ fixture, passed, evidence });
  }
  const results = new Map<string, PropertyResult>();
  for (const property of wanted) {
    const planned = fixtures.filter(fixture => fixture.property === property);
    const actual = completed.filter(witness => witness.fixture.property === property);
    const complete = planned.length === actual.length && actual.some(witness => witness.fixture.role === "activation") && actual.some(witness => witness.fixture.role === "control");
    results.set(property, { property, status: complete && actual.every(witness => witness.passed) ? "pass" : "fail", reason: "Every declared activation and control must execute cleanly against the exact descriptor/artifact and match the frozen contract projection; missing or mismatching allocation receives no credit.", evidence: actual.flatMap(witness => witness.evidence) });
  }
  const durationMs = performance.now() - started;
  return closeNamedConfigurationRows(rows, results).map(row => required[row.index] === undefined ? row : { ...row, durationMs: row.durationMs + durationMs });
}
