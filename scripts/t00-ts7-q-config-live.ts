import { chmod, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sha256, type CampaignContext, type Evidence, type PropertyResult } from "./t00-ts7-q-config-campaign";
import { compilerDiagnostics } from "./t00-ts7-q-config-cr";

type Value = Record<string, unknown>;
const object = (value: unknown): Value => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const canonical = (value: unknown): string => JSON.stringify(value, (_key, nested: unknown) => nested !== null && typeof nested === "object" && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : nested);
type Expected = { reasons: string[]; inputs: Record<string, string | null>; forbiddenReads: string[]; caseSensitive?: boolean; discoveredConfiguration?: string };

export function compareLiveConfigurationObservation(value: unknown, expected: Expected): boolean {
  const observed = object(value);
  const inputs = object(observed.inputs);
  const probes = Array.isArray(observed.probes) ? observed.probes.map(object) : [];
  if (observed.executed !== true || observed.profile !== "live_configuration" || observed.error !== null || observed.global_admission_inferred !== false || !Array.isArray(observed.reasons)) return false;
  const reasons = observed.reasons as unknown[];
  if (reasons.some(reason => typeof reason !== "string")) return false;
  if (!isDeepStrictEqual([...reasons].sort(), [...expected.reasons].sort()) || !isDeepStrictEqual(inputs, expected.inputs)) return false;
  if (expected.forbiddenReads.some(path => Object.hasOwn(inputs, path))) return false;
  if (expected.discoveredConfiguration !== undefined && !probes.some(probe => probe.operation === "configuration_discovery_file_exists" && probe.path === (expected.caseSensitive === false ? expected.discoveredConfiguration?.toLowerCase() : expected.discoveredConfiguration) && probe.found === true)) return false;
  return Object.entries(expected.inputs).every(([path, text]) => probes.some(probe => probe.operation === "read_file" && probe.path === (expected.caseSensitive === false ? path.toLowerCase() : path) && probe.found === (text !== null) && probe.content_id === (text === null ? null : `sha256:${sha256(text)}`)));
}

type Mode = "success" | "undefined" | "error" | "os_error" | "outside" | "symlink" | "internal_symlink";
type Fixture = { name: string; inherited: boolean; mode: Mode; normalizedAlias?: boolean };
const rootConfig = JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", skipLibCheck: true, noEmit: true } });
const initialFixtures: Fixture[] = [
  { name: "initial-success", inherited: false, mode: "success" },
  ...(["undefined", "error", "os_error"] as const).map(mode => ({ name: `initial-${mode}`, inherited: false, mode })),
  { name: "initial-normalized-undefined", inherited: false, mode: "undefined", normalizedAlias: true },
];
const inheritedFixtures: Fixture[] = [
  { name: "inherited-success", inherited: true, mode: "success" },
  ...(["undefined", "error", "os_error", "outside", "symlink", "internal_symlink"] as const).map(mode => ({ name: `inherited-${mode}`, inherited: true, mode })),
];

async function save(path: string, value: unknown): Promise<Evidence> {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  await writeFile(path, bytes);
  return { path, sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) };
}

type Witness = { fixture: Fixture; passed: boolean; evidence: Evidence[] };
async function execute(ctx: CampaignContext, fixture: Fixture): Promise<Witness> {
  const directory = resolve(ctx.out, "config-live", fixture.name);
  await mkdir(resolve(directory, "repo"), { recursive: true });
  const root = await realpath(resolve(directory, "repo"));
  const configPath = resolve(root, "tsconfig.json");
  const basePath = resolve(root, "base.json");
  const externalPath = resolve(root, "../external.json");
  const blocked = fixture.mode === "outside" || fixture.mode === "symlink";
  const inheritedPath = fixture.mode === "outside" ? "../external.json" : "./base.json";
  const configText = fixture.inherited ? JSON.stringify({ extends: inheritedPath }) : rootConfig;
  const physical: Record<string, string> = { [configPath]: configText, [resolve(root, "main.ts")]: "export const value=1;\n" };
  if (fixture.inherited && !blocked) physical[fixture.mode === "internal_symlink" ? resolve(root, "target.json") : basePath] = rootConfig;
  if (blocked) physical[externalPath] = rootConfig;
  for (const [path, text] of Object.entries(physical)) await writeFile(path, text);
  if (fixture.mode === "symlink") await symlink(externalPath, basePath);
  if (fixture.mode === "internal_symlink") await symlink(resolve(root, "target.json"), basePath);
  const target = fixture.inherited ? basePath : configPath;
  const failed = ["undefined", "error", "os_error"].includes(fixture.mode);
  const faultPath = fixture.normalizedAlias ? `${dirname(target).replaceAll("/", "\\")}\\nested\\..\\tsconfig.json` : target;
  const read_failures = failed && fixture.mode !== "os_error" ? { [faultPath]: fixture.mode } : {};
  const request = { root, source: resolve(root, "main.ts"), read_failures };
  const requestPath = resolve(directory, "request.json");
  const evidence = [await save(requestPath, request), ...Object.entries(physical).map(([path, text]) => ({ path, sha256: sha256(text), bytes: Buffer.byteLength(text) }))];
  let oracleReady = true;
  let expectedReasons: string[];
  let oracleDiagnostics: ReturnType<typeof compilerDiagnostics> = [];
  if (blocked) expectedReasons = ["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"];
  else {
    if (failed) await chmod(target, 0);
    try {
      const oracle = await ctx.run(`config-live-${fixture.name}-oracle`, [ctx.oracle, "--noEmit", "--pretty", "false", "--project", configPath], root);
      evidence.push(...oracle.evidence);
      try { oracleDiagnostics = compilerDiagnostics(oracle.stdout); } catch { oracleReady = false; }
      expectedReasons = oracleDiagnostics.filter(diagnostic => diagnostic.code !== 18003).map(diagnostic => `SOURCE_CONFIGURATION_INVALID:${diagnostic.code}:${diagnostic.message}`);
      oracleReady &&= oracle.stderr.trim() === "" && oracle.exitCode === (oracleDiagnostics.length === 0 ? 0 : 2) && (!failed || oracleDiagnostics.some(diagnostic => diagnostic.code === 5083));
    } finally { if (failed) await chmod(target, 0o644); }
  }
  if (fixture.mode === "os_error") await chmod(target, 0);
  let execution: Awaited<ReturnType<CampaignContext["run"]>>;
  try { execution = await ctx.run(`config-live-${fixture.name}-producer`, [ctx.producer, "--observe-configuration-live", requestPath], root); }
  finally { if (fixture.mode === "os_error") await chmod(target, 0o644); }
  evidence.push(...execution.evidence);
  let observed: Value = {};
  let producerParsed = true;
  try { observed = object(JSON.parse(execution.stdout)); } catch { producerParsed = false; }
  const inputs: Record<string, string | null> = { [configPath]: fixture.inherited || !failed ? configText : null };
  if (fixture.inherited && !blocked) inputs[basePath] = failed ? null : rootConfig;
  const expected = { discoveredConfiguration: configPath, caseSensitive: ctx.platform === "linux", reasons: expectedReasons, inputs, forbiddenReads: [resolve(root, "main.ts"), ...(blocked ? [basePath, externalPath] : [])] };
  const bound = observed.request_descriptor_id === `sha256:${sha256(canonical(request))}` && observed.producer_artifact_id === `sha256:${sha256(await readFile(ctx.producer))}`;
  const passed = oracleReady && producerParsed && execution.exitCode === 0 && execution.stderr.trim() === "" && bound && compareLiveConfigurationObservation(observed, expected);
  evidence.push(await save(resolve(directory, "comparison.json"), { authority: blocked ? "Semctx repository confinement contract: refuse lexical/canonical inherited escape before read delegation" : "Independent pinned TS7 CLI on the same physical files; chmod000 supplies native initial/inherited read failure 5083", fixture, expected, oracleDiagnostics, oracleReady, producerParsed, bound, passed, actual: observed }));
  return { fixture, passed, evidence };
}

export async function liveConfigurationWitnesses(ctx: CampaignContext): Promise<Map<number, PropertyResult[]>> {
  const witnesses: Witness[] = [];
  for (const fixture of [...initialFixtures, ...inheritedFixtures]) witnesses.push(await execute(ctx, fixture));
  const property = (name: string, values: Witness[]): PropertyResult => {
    const hasControl = values.some(witness => witness.fixture.mode === "success");
    const hasActivation = values.some(witness => witness.fixture.mode !== "success");
    return { property: name, status: hasControl && hasActivation && values.every(witness => witness.passed) ? "pass" : "fail", reason: "Every live activation and successful control must execute on the exact candidate and agree with independent TS7 failure diagnostics or the confinement contract, including normalized content-or-undefined attribution and matching read digests.", evidence: values.flatMap(witness => witness.evidence) };
  };
  const initial = property("live initial configuration read and normalized content-or-undefined attribution", witnesses.filter(witness => !witness.fixture.inherited));
  const inherited = property("live inherited reads delegate within confinement and refuse escapes before delegation", witnesses.filter(witness => witness.fixture.inherited));
  return new Map([[25, [initial]], [27, [inherited]], [23, [initial, inherited]]]);
}
