import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CampaignContext, Evidence } from "./t00-ts7-q-config-campaign";

type Value = Record<string, unknown>;
type Discovery = { path: string; found: boolean };
const object = (value: unknown): Value => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, nested: unknown) => nested !== null && typeof nested === "object" && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : nested);

export function compareLiveConfigurationDiscovery(value: unknown, expected: Discovery[], reasons: string[], source: string): boolean {
  const observed = object(value);
  if (observed.executed !== true || observed.profile !== "live_configuration" || observed.error !== null || !isDeepStrictEqual(observed.read_errors, {}) || !isDeepStrictEqual(observed.reasons, reasons) || !Array.isArray(observed.probes)) return false;
  const probes = observed.probes.map(object);
  if (probes.some(probe => typeof probe.operation !== "string" || typeof probe.path !== "string" || typeof probe.found !== "boolean")) return false;
  if (probes.some(probe => probe.operation === "read_file" && probe.path === source)) return false;
  const discovery = probes.filter(probe => probe.operation === "configuration_discovery_file_exists").map(probe => ({ path: probe.path, found: probe.found }));
  return isDeepStrictEqual(discovery, expected);
}

type Fixture = { name: string; property: string; role: "activation" | "control"; subject: string; files: Record<string, string>; reasons: string[] };
export type ConfigurationLiveWitness = { property: string; role: "activation" | "control"; pass: boolean; evidence: Evidence[]; durationMs: number; indices: number[] };
const valid = JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true, skipLibCheck: true } });
const sourceText = "export const value=1;\n";
const fixtures: Fixture[] = [];
for (const depth of [0, 1, 2, 3]) {
  const subject = `${"nested/".repeat(depth)}main.ts`;
  for (const role of ["activation", "control"] as const) fixtures.push({ name: `live-ancestor-${depth}-${role}`, property: `live-configuration-ancestor-${depth}`, role, subject, files: role === "activation" ? { "tsconfig.json": valid } : {}, reasons: [] });
}
for (const role of ["activation", "control"] as const) fixtures.push({ name: `live-nearest-shadows-ancestor-${role}`, property: "live-nearest-configuration-stops-search", role, subject: "nested/child/main.ts", files: role === "activation" ? { "tsconfig.json": valid, "nested/tsconfig.json": valid } : { "tsconfig.json": valid }, reasons: [] });
for (const role of ["activation", "control"] as const) fixtures.push({ name: `live-optional-source-${role}`, property: "ordinary-configuration-does-not-read-optional-source", role, subject: "nested/main.ts", files: role === "activation" ? { "tsconfig.json": valid } : { "tsconfig.json": valid, "nested/main.ts": sourceText }, reasons: [] });
for (const role of ["activation", "control"] as const) fixtures.push({ name: `live-governing-outside-root-${role}`, property: "live-governing-configuration-outside-root", role, subject: "main.ts", files: role === "activation" ? { "../tsconfig.json": valid } : { "tsconfig.json": valid }, reasons: role === "activation" ? ["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"] : [] });

async function save(path: string, value: unknown): Promise<Evidence> {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, bytes);
  return { path, sha256: sha(bytes), bytes: Buffer.byteLength(bytes) };
}

export async function runConfigurationLiveBoundaries(ctx: CampaignContext, indices: number[]): Promise<ConfigurationLiveWitness[]> {
  if (!indices.some(index => index === 23 || index === 24)) return [];
  const results: ConfigurationLiveWitness[] = [];
  const normalize = (path: string) => ctx.platform === "macos" ? path.toLowerCase() : path;
  const artifact = `sha256:${sha(await readFile(ctx.producer))}`;
  for (const fixture of fixtures) {
    const started = performance.now();
    const directory = resolve(ctx.out, "config-diag-boundaries", fixture.name);
    const root = resolve(directory, "workspace");
    const source = resolve(root, fixture.subject);
    await mkdir(dirname(source), { recursive: true });
    const physical = Object.fromEntries(Object.entries(fixture.files).map(([path, text]) => [resolve(root, path), text]));
    for (const [path, text] of Object.entries(physical)) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    const descriptor = { root, source };
    const path = resolve(directory, "request.json");
    const evidence = [await save(path, descriptor), ...Object.entries(physical).map(([path, text]) => ({ path, sha256: sha(text), bytes: Buffer.byteLength(text) }))];
    const expected: Discovery[] = [];
    for (let ancestor = dirname(source); ; ancestor = dirname(ancestor)) {
      const path = resolve(ancestor, "tsconfig.json");
      const found = Object.hasOwn(physical, path);
      expected.push({ path: normalize(path), found });
      if (found || dirname(ancestor) === ancestor) break;
    }
    const process = await ctx.run(`config-boundaries-${fixture.name}`, [ctx.producer, "--observe-configuration-live", path], root);
    evidence.push(...process.evidence);
    let observed: Value = {};
    let parseError: string | undefined;
    try { observed = object(JSON.parse(process.stdout)); }
    catch (error) { parseError = String(error); }
    const bound = process.exitCode === 0 && process.stderr.trim() === "" && parseError === undefined && observed.request_descriptor_id === `sha256:${sha(canonical(descriptor))}` && observed.producer_artifact_id === artifact;
    const pass = bound && compareLiveConfigurationDiscovery(observed, expected, fixture.reasons, normalize(source));
    evidence.push(await save(resolve(directory, "comparison.json"), { authority: "Frozen inspectModuleConfiguration findConfigFile callback contract: physical fileExists is consulted at each ancestor until its first true outcome; no source read is requested without snapshot/source arguments", descriptor, fixture: fixture.name, role: fixture.role, expected: { discovery: expected, reasons: fixture.reasons, sourceRead: false }, actual: observed, processBound: bound, parseError, pass }));
    results.push({ property: fixture.property, role: fixture.role, pass, evidence, durationMs: performance.now() - started, indices: [23, 24] });
  }
  return results;
}
