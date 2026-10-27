import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CampaignContext, Evidence, PropertyResult } from "./t00-ts7-q-config-campaign";
import { resolutionFromTrace } from "./t00-ts7-q-config-cr";

export type CanonicalEvidence = { path: string } | { error: string };
export interface WrapperOracleInput {
  containing_file: string;
  specifier: string;
  configured: boolean;
  retained: boolean;
  declaration_path: string | null;
  runtime_exists: boolean;
  repository_root?: string;
  canonical_root?: CanonicalEvidence;
  canonical_runtime?: CanonicalEvidence;
}
export interface WrapperOracleResult {
  resolved_path: string | null;
  runtime_path: string | null;
  runtime_exists: boolean | null;
  canonical_attempted: boolean;
  refused_inputs: string[];
  canonical_errors: { path: string; error: string }[];
}

export function projectRuntimeModule(input: WrapperOracleInput): WrapperOracleResult {
  const unchanged: WrapperOracleResult = { resolved_path: input.declaration_path, runtime_path: null, runtime_exists: null, canonical_attempted: false, refused_inputs: [], canonical_errors: [] };
  if (!input.configured || input.declaration_path === null || !/\.d\.(mts|cts|ts)$/.test(input.declaration_path)) return unchanged;
  const runtimePath = input.declaration_path.replace(/\.d\.(mts|cts|ts)$/, (_suffix, extension: string) => extension === "mts" ? ".mjs" : extension === "cts" ? ".cjs" : ".js");
  const result = { ...unchanged, runtime_path: runtimePath, runtime_exists: input.runtime_exists };
  if (!input.runtime_exists) return result;
  if (input.retained || input.repository_root === undefined) return { ...result, resolved_path: runtimePath };
  result.canonical_attempted = true;
  const reject = (canonical_errors: { path: string; error: string }[] = []): WrapperOracleResult => ({ ...result, resolved_path: null, refused_inputs: [runtimePath], canonical_errors });
  if (input.canonical_root === undefined) throw new Error("canonical evidence missing: repository root");
  if ("error" in input.canonical_root) return reject([{ path: input.repository_root, error: input.canonical_root.error }]);
  if (input.canonical_runtime === undefined) throw new Error("canonical evidence missing: runtime companion");
  if ("error" in input.canonical_runtime) return reject([{ path: runtimePath, error: input.canonical_runtime.error }]);
  const relation = relative(input.canonical_root.path, input.canonical_runtime.path).replaceAll("\\", "/");
  if (relation === ".." || relation.startsWith("../") || isAbsolute(relation)) return reject();
  return { ...result, resolved_path: runtimePath };
}

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function evaluateRuntimeWrapper(observed: unknown, expected: WrapperOracleResult, input: WrapperOracleInput, root: string, sdkInputId: string): boolean {
  const value = object(observed);
  const imports = object(value.extraction).imports;
  const trace = { configured: input.configured, retained: input.retained, declaration_path: input.declaration_path,
    runtime_path: expected.runtime_path, runtime_exists: expected.runtime_exists, canonical_attempted: expected.canonical_attempted,
    canonical_errors: expected.canonical_errors, resolved_path: expected.resolved_path };
  if (value.executed !== true || !isDeepStrictEqual(value.unsupported, []) || value.sdk_input_id !== sdkInputId || value.configured !== input.configured || value.retained !== input.retained ||
    !isDeepStrictEqual(value.runtime_resolution, [trace]) || !Array.isArray(imports) || imports.length !== 1) return false;
  const link = object(imports[0]);
  if (link.fromRelPath !== relative(root, input.containing_file).replaceAll("\\", "/") || link.moduleSpecifier !== input.specifier) return false;
  if (expected.resolved_path === null ? Object.hasOwn(link, "resolvedRelPath") : link.resolvedRelPath !== relative(root, expected.resolved_path).replaceAll("\\", "/")) return false;
  const inputs = object(value.inputs);
  return expected.refused_inputs.every(path => Object.hasOwn(inputs, path) && inputs[path] === null);
}

type WrapperFixture = {
  name: string;
  retained: boolean;
  configured: boolean;
  extension?: "ts" | "mts" | "cts";
  runtime?: "present" | "missing" | "escape" | "internal-link" | "captured-only";
  unresolved?: boolean;
  sourceTarget?: boolean;
  alias?: boolean;
  rootless?: boolean;
  canonicalFault?: "root" | "runtime";
};

const fixtures: WrapperFixture[] = [
  ...[false, true].flatMap(retained => {
    const profile = retained ? "snapshot" : "live";
    return [
      ...(["ts", "mts", "cts"] as const).map(extension => ({ name: `${profile}-${extension}-companion`, retained, configured: true, extension, runtime: "present" as const })),
      { name: `${profile}-unconfigured`, retained, configured: false, runtime: "present" as const },
      { name: `${profile}-runtime-missing`, retained, configured: true, runtime: "missing" as const },
      { name: `${profile}-unresolved`, retained, configured: true, unresolved: true },
      { name: `${profile}-source-target`, retained, configured: true, sourceTarget: true },
      ...[false, true].map(configured => ({ name: `${profile}-alias-${configured ? "configured" : "standard"}`, retained, configured, alias: true, runtime: "present" as const })),
    ];
  }),
  { name: "live-canonical-root-failure", retained: false, configured: true, runtime: "present", canonicalFault: "root" },
  { name: "live-canonical-runtime-failure", retained: false, configured: true, runtime: "present", canonicalFault: "runtime" },
  { name: "live-escape-refused", retained: false, configured: true, runtime: "escape" },
  { name: "live-escape-rootless", retained: false, configured: true, runtime: "escape", rootless: true },
  { name: "live-internal-symlink", retained: false, configured: true, runtime: "internal-link" },
  { name: "live-rootless-companion", retained: false, configured: true, runtime: "present", rootless: true },
  { name: "snapshot-ignores-canonical-fault", retained: true, configured: true, runtime: "present", canonicalFault: "runtime" },
  { name: "live-rootless-ignores-canonical-fault", retained: false, configured: true, runtime: "present", rootless: true, canonicalFault: "root" },
  { name: "snapshot-runtime-absent-on-disk", retained: true, configured: true, runtime: "captured-only" },
];

const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, nested: unknown) => nested !== null && typeof nested === "object" && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : nested);
async function save(path: string, value: unknown): Promise<Evidence> {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, bytes, { flag: "wx" });
  return { path, sha256: sha(bytes), bytes: Buffer.byteLength(bytes) };
}

async function canonicalFilesystemPath(path: string): Promise<string> {
  const absolute = resolve(path);
  for (let ancestor = absolute; ; ancestor = dirname(ancestor)) {
    try { return resolve(await realpath(ancestor), relative(ancestor, absolute)); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "ENOENT" && code !== "ENOTDIR") || dirname(ancestor) === ancestor) throw error;
    }
  }
}

export async function runRuntimeModuleWrapper(ctx: CampaignContext, libraries: string[]): Promise<{ properties: PropertyResult[]; evidence: Evidence[]; durationMs: number }> {
  const started = performance.now();
  const properties: PropertyResult[] = [];
  const evidence: Evidence[] = [];
  const producerId = `sha256:${sha(await readFile(ctx.producer))}`;
  const sdkId = `sha256:${sha(canonical(JSON.parse(await readFile(ctx.sdk, "utf8"))))}`;
  for (const fixture of fixtures) {
    const caseEvidence: Evidence[] = [];
    const location = resolve(ctx.out, "wrapper-205", fixture.name);
    const root = resolve(location, "repository");
    await mkdir(root, { recursive: true });
    const containing = resolve(root, "main.mjs");
    const extension = fixture.extension ?? "mts";
    const runtimeName = extension === "ts" ? "target.js" : extension === "mts" ? "target.mjs" : "target.cjs";
    const runtime = resolve(root, runtimeName);
    const specifier = fixture.alias ? "wrapper-alias" : fixture.unresolved ? "./missing.mjs" : fixture.sourceTarget ? "./target.js" : `./${runtimeName}`;
    const config = { compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "bundler", ...(fixture.alias ? { paths: { "wrapper-alias": ["./target.d.mts"] } } : {}) } };
    const files: Record<string, string> = { [containing]: `import { value } from ${JSON.stringify(specifier)}; export { value };`, [resolve(root, "tsconfig.json")]: JSON.stringify(config) };
    if (fixture.sourceTarget) files[resolve(root, "target.ts")] = "export const value = 1;";
    else if (!fixture.unresolved) files[resolve(root, `target.d.${extension}`)] = "export declare const value: number;";
    for (const [path, source] of Object.entries(files)) await writeFile(path, source, { flag: "wx" });
    if (fixture.runtime === "escape") {
      const outside = resolve(location, "outside.mjs");
      await writeFile(outside, "export const value = 1;", { flag: "wx" });
      await symlink(outside, runtime);
    } else if (fixture.runtime === "internal-link") {
      const actual = resolve(root, "inside.mjs");
      await writeFile(actual, "export const value = 1;", { flag: "wx" });
      await symlink(actual, runtime);
    } else if (fixture.runtime === "present" || fixture.runtime === "captured-only") {
      await writeFile(runtime, "export const value = 1;", { flag: "wx" });
    }
    if (fixture.retained && fixture.runtime !== "missing" && fixture.runtime !== undefined) files[runtime] = "export const value = 1;";
    if (fixture.runtime === "captured-only") await rm(runtime);
    const faultPath = fixture.canonicalFault === "root" ? root : runtime;
    const fault = "wrapper_205_canonical_fault";
    const request = { root, ...(!fixture.rootless ? { repository_root: root } : {}), containing_file: containing, configured: fixture.configured, retained: fixture.retained, files,
      canonical_failures: fixture.canonicalFault ? { [faultPath]: fault } : {} };
    caseEvidence.push(await save(resolve(location, "request.json"), request));
    const project = { ...(fixture.configured ? { extends: resolve(root, "tsconfig.json") } : {}), compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "bundler", allowJs: true, checkJs: true, skipLibCheck: true, noLib: true, noEmit: true }, files: [containing, ...libraries], include: [] };
    caseEvidence.push(await save(resolve(location, "oracle-project.json"), project));
    try {
      const oracle = await ctx.run(`wrapper-205-${fixture.name}-oracle`, [ctx.oracle, "--noEmit", "--pretty", "false", "--traceResolution", "--project", resolve(location, "oracle-project.json")], root);
      caseEvidence.push(...oracle.evidence);
      if (![0, 2].includes(oracle.exitCode) || oracle.stderr.trim() !== "") throw new Error("TS7 wrapper declaration resolution failed");
      const declarationPath = resolutionFromTrace(oracle.stdout, specifier);
      const runtimePath = declarationPath?.replace(/\.d\.(mts|cts|ts)$/, (_suffix, selected: string) => selected === "mts" ? ".mjs" : selected === "cts" ? ".cjs" : ".js");
      const isDeclaration = declarationPath !== null && /\.d\.(mts|cts|ts)$/.test(declarationPath);
      const exists = fixture.retained ? runtimePath !== undefined && Object.hasOwn(files, runtimePath) : runtimePath !== undefined && await stat(runtimePath).then(value => value.isFile(), () => false);
      if (fixture.configured && isDeclaration && exists !== (fixture.runtime !== "missing" && fixture.runtime !== undefined)) throw new Error("mandatory runtime existence control did not activate");
      const input: WrapperOracleInput = { containing_file: containing, specifier, configured: fixture.configured, retained: fixture.retained, declaration_path: declarationPath, runtime_exists: exists,
        ...(!fixture.rootless ? { repository_root: root } : {}) };
      if (fixture.configured && isDeclaration && exists && !fixture.retained && !fixture.rootless) {
        input.canonical_root = fixture.canonicalFault === "root" ? { error: fault } : { path: await canonicalFilesystemPath(root) };
        if ("path" in input.canonical_root) input.canonical_runtime = fixture.canonicalFault === "runtime" ? { error: fault } : { path: await canonicalFilesystemPath(runtimePath!) };
      }
      const expected = projectRuntimeModule(input);
      caseEvidence.push(await save(resolve(location, "independent-expected.json"), { authority: "TS7 trace for declaration selection + frozen consumer205 wrapper predicate + authored native/snapshot inputs; no producer-derived expectations", input, expected }));
      const native = await ctx.run(`wrapper-205-${fixture.name}-producer`, [ctx.producer, "--observe-runtime-module", resolve(location, "request.json"), ctx.sdk], root);
      caseEvidence.push(...native.evidence);
      let observed: unknown;
      try { observed = JSON.parse(native.stdout) as unknown; } catch { observed = null; }
      const value = object(observed);
      const bound = value.request_descriptor_id === `sha256:${sha(canonical(request))}` && value.producer_artifact_id === producerId;
      const passed = native.exitCode === 0 && native.stderr.trim() === "" && bound && evaluateRuntimeWrapper(observed, expected, input, root, sdkId);
      caseEvidence.push(await save(resolve(location, "comparison.json"), { expected, observed, bound, passed }));
      properties.push({ property: `owning module wrapper: ${fixture.name}`, status: passed ? "pass" : "fail", reason: "Actual Program-selected declaration, actual ordinary::extract import link, complete owner branch trace, exact canonical fault activation and refused-input presence compared independently.", evidence: caseEvidence });
    } catch (error) {
      caseEvidence.push(await save(resolve(location, "error.json"), { error: String(error) }));
      properties.push({ property: `owning module wrapper: ${fixture.name}`, status: "fail", reason: String(error), evidence: caseEvidence });
    }
    evidence.push(...caseEvidence);
  }
  return { properties, evidence, durationMs: performance.now() - started };
}
