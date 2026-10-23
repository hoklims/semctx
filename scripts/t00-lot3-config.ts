import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type typeScript from "typescript";
import { rawContextChecks } from "../tools/rust-ts-r0/qualification/public-closure-20261022/public-native-context.mjs";

type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
type Check = { name: string; actual: unknown; expected: unknown; pass: boolean };
type Context = { request: Json; sdk: Json; artifactSha256: string; sdkVersion: string; path: string; mode: string };
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const canonical = (value: Json): string => JSON.stringify(value, (_key: string, nested: unknown) => nested !== null && typeof nested === "object" && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : nested);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function configurationChecks(observed: unknown, expected: string[], context: Context): Check[] {
  const value = object(observed);
  const subjects = Array.isArray(value.subjects) ? value.subjects.filter(subject => object(subject).path === context.path) : [];
  const component = object(object(object(subjects[0]).moduleConfigurationObservations)[context.mode]);
  const checks = [
    ["subject-denominator", subjects.length, 1],
    ["request", value.request, object(context.request).id],
    ["request-binding", value.request_id, `sha256:${sha256(canonical(context.request))}`],
    ["producer", value.producer_artifact_id, `sha256:${context.artifactSha256}`],
    ["sdk-version", value.sdk_version, context.sdkVersion],
    ["complete", value.complete, true],
    ["status", value.status, "development_observation_not_qualification"],
    ["engine-revision", value.engine_revision, "780dc512d64f40afebffa6a7028207649fb7ed1c"],
    ["compiler-version", value.native_compiler_version, "7.1.0-dev"],
    ["global-admission", value.global_admission_inferred, false],
    ["executed", component.executed, true],
    ["unsupported", component.unsupported, []],
    ["reasons", component.reasons, expected],
  ].map(([name, actual, wanted]) => ({ name: String(name), actual, expected: wanted, pass: isDeepStrictEqual(actual, wanted) }));
  const contextChecks = rawContextChecks(observed, context.request, context.sdk) as Record<string, boolean>;
  return [...checks, ...Object.entries(contextChecks).map(([name, actual]) => ({ name, actual, expected: true, pass: actual === true }))];
}

type Unit = { id: string; path: string; operation: string; mode: string; files: Record<string, string>; obligation_indices: number[] };

export function fixtureSource(unit: Pick<Unit, "id" | "path" | "files">): string {
  const content = unit.files[unit.path];
  if (content === undefined) throw new Error(`source missing from fixture ${unit.id}`);
  return content;
}

async function main() {
  const [baseline, inputPath, freezePath, output] = process.argv.slice(2).map(path => resolve(path));
  if (!baseline || !inputPath || !freezePath || !output) throw new Error("expected BASELINE INPUTS FREEZE OUTPUT");
  if (Bun.version !== "1.4.3") throw new Error("Bun 1.4.3 required");
  const { default: ts } = await import(resolve(baseline, "node_modules/typescript/lib/typescript.js")) as { default: typeof typeScript };
  if (ts.version !== "5.9.3") throw new Error("TypeScript 5.9.3 required");
  const diagnosticPath = resolve(baseline, "packages/ts-analyzer/src/javascript-diagnostics.ts");
  if (sha256(await readFile(diagnosticPath)) !== "24df500bd622310e0522f7d2ea13082d484e58ece753b102027853622d4ed097") throw new Error("foreign baseline diagnostics source");
  const diagnostic = await import(diagnosticPath) as { inspectModuleConfiguration(path: string, root: string, retained: ReadonlyMap<string, string> | undefined, source: typeScript.SourceFile | undefined): string[] };
  const freeze = JSON.parse(await readFile(freezePath, "utf8")) as { artifact_path: string; artifact_sha256: string; sdk_path: string; sdk_sha256: string; source_head: string };
  const verifyArtifacts = async () => {
    for (const kind of ["artifact", "sdk"] as const) if (sha256(await readFile(freeze[`${kind}_path`])) !== freeze[`${kind}_sha256`]) throw new Error(`frozen ${kind} mismatch`);
  };
  await verifyArtifacts();
  const sdk = JSON.parse(await readFile(freeze.sdk_path, "utf8")) as Json;
  await mkdir(output);
  const bytes = await readFile(inputPath);
  const original = JSON.parse(bytes.toString()) as { units: Unit[] };
  const units = original.units.filter(unit => unit.operation === "configuration" && unit.obligation_indices.some(index => [23, 26, 27].includes(index)));
  if (units.length === 0 || new Set(units.map(unit => unit.id)).size !== units.length) throw new Error("empty or duplicate diagnostics");
  const reports = [];
  for (const [ordinal, unit] of units.entries()) {
    const root = resolve(output, `unit-${String(ordinal).padStart(3, "0")}`, "workspace");
    await mkdir(root, { recursive: true });
    const retained = new Map<string, string>();
    for (const [relative, content] of Object.entries(unit.files)) {
      const path = resolve(root, relative);
      if (!path.startsWith(`${root}/`)) throw new Error("input outside workspace");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      retained.set(path, content);
    }
    const absolute = resolve(root, unit.path);
    const source = ts.createSourceFile(absolute, fixtureSource(unit), ts.ScriptTarget.Latest, true);
    const expected = diagnostic.inspectModuleConfiguration(absolute, root, unit.mode === "ordinaryWithoutSnapshot" ? undefined : retained, unit.mode === "retainedWithSource" ? source : undefined);
    const request = {
      id: unit.id, cwd: root, sdk_directory: "/sdk/lib", case_sensitive: ts.sys.useCaseSensitiveFileNames,
      roots: Object.keys(unit.files).filter(path => /\.(?:[cm]?[tj]sx?)$/.test(path)).map(path => resolve(root, path)), files: Object.fromEntries(retained),
      options: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowJs: true, jsx: "Preserve", skipLibCheck: true, noEmit: true, strict: false },
      retained: true, qualified: false, roles: {}, selection: {}, disabled: [], utf16_files: {}, raw_files: {},
    };
    const requestPath = resolve(dirname(root), "request.json");
    await writeFile(requestPath, JSON.stringify(request, null, 2) + "\n");
    await writeFile(resolve(dirname(root), "oracle.json"), JSON.stringify({ authority: { baseline: "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b", typescript: ts.version }, path: absolute, mode: unit.mode, expected }, null, 2) + "\n");
    const processResult = Bun.spawnSync([freeze.artifact_path, requestPath, freeze.sdk_path], { cwd: root, env: { ...process.env, GOPORT_LIB_PARSE_SNAPSHOT: "0", GOPORT_LIB_SNAPSHOT: "0" }, stdout: "pipe", stderr: "pipe", timeout: 40_000 });
    await writeFile(resolve(dirname(root), "stdout.json"), processResult.stdout);
    await writeFile(resolve(dirname(root), "stderr.txt"), processResult.stderr);
    if (processResult.exitCode !== 0) throw new Error(`native process failed ${unit.id}: ${processResult.exitCode}`);
    const observed = JSON.parse(new TextDecoder().decode(processResult.stdout)) as unknown;
    const checks = configurationChecks(observed, expected, { request, sdk, artifactSha256: freeze.artifact_sha256, sdkVersion: ts.version, path: unit.path, mode: unit.mode });
    reports.push({ id: unit.id, mode: unit.mode, obligationIndices: unit.obligation_indices.filter(index => [23, 26, 27].includes(index)), checks, pass: checks.every(check => check.pass) });
  }
  await verifyArtifacts();
  const result = { schemaVersion: 1, environment: { platform: process.platform, architecture: process.arch, bun: Bun.version, caseSensitive: ts.sys.useCaseSensitiveFileNames, typescript: ts.version }, authority: { baseline: "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b", sourceSha256: sha256(await readFile(diagnosticPath)), inputSha256: sha256(bytes) }, candidate: freeze, units: reports, pass: reports.every(unit => unit.pass), formalR0ObligationQualified: false };
  await writeFile(resolve(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ units: reports.length, pass: reports.filter(unit => unit.pass).length, failures: reports.filter(unit => !unit.pass).map(unit => ({ id: unit.id, checks: unit.checks.filter(check => !check.pass) })) }));
}

if (import.meta.main) await main();
