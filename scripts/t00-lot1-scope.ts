import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

type JsonObject = Record<string, unknown>;
interface Freeze { artifact_path: string; artifact_sha256: string; helper_path: string; helper_sha256: string; sdk_path: string; sdk_sha256: string; source_head: string }
interface Fixture { id: string; main: string; extra?: Record<string, string> }

export const fixtures: readonly Fixture[] = [
  { id: "inherited-positive", main: "export function main() { return 2; }\n" },
  { id: "unretained-reference", extra: { "build/generated.ts": "export const generated=1;\n" }, main: "/// <reference path=\"../build/generated.ts\" />\nexport function main() { return 2; }\n" },
  { id: "declared-optional", extra: { "package.json": '{"name":"fixture","optionalDependencies":{"optional":"1.0.0"}}' }, main: "import { value } from 'optional'; export function main() { return value(); }\n" },
  { id: "undeclared-optional", extra: { "package.json": '{"name":"fixture"}' }, main: "import { value } from 'optional'; export function main() { return value(); }\n" },
  { id: "excluded-dependent", extra: { "hidden.ts": "import { main } from './src/main'; export function hidden() { return main(); }\n" }, main: "export function main() { return 2; }\n" },
  { id: "excluded-computed", extra: { "hidden.ts": "const name='./src/main'; export function hidden() { return import(name); }\n" }, main: "export function main() { return 2; }\n" },
  { id: "excluded-unresolved", extra: { "hidden.ts": "import { value } from './absent'; export const hidden=value;\n" }, main: "export function main() { return 2; }\n" },
  { id: "import-type", extra: { "src/target.ts": "export interface Value { n:number }\n" }, main: "export type Type=import('./target').Value;\n" },
  { id: "type-only-control", extra: { "src/target.ts": "export interface Value { n:number }\n" }, main: "import type {Value} from './target';export type Type=Value;\n" },
  { id: "external-import-equals", extra: { "src/target.ts": "export const value=1;\n" }, main: "import dep = require('./target'); export const value=dep;\n" },
  { id: "internal-alias-control", main: "namespace Own {export const value=1;} import ref=Own;export {ref};\n" },
  { id: "computed-import", main: "const name='./target';export function main(){return import(name);}\n" },
  { id: "two-arguments-import", extra: { "src/target.ts": "export const value=1;\n" }, main: "export function main(){return import('./target', {with:{type:'json'}});}\n" },
  { id: "literal-import-control", extra: { "src/target.ts": "export const value=1;\n" }, main: "export function main(){return import('./target');}\n" },
  { id: "unresolved-literal-import", main: "export function main(){return import('./absent');}\n" },
];

export function sha(bytes: string | Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("SCOPE_OBSERVATION_MISSING");
  return value as JsonObject;
}
function objects(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw new Error("SCOPE_ARRAY_MISSING");
  return value.map(object);
}
function save(path: string, value: unknown): void { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function invoke(argv: string[], cwd: string, timeout = 40_000) {
  const started = performance.now();
  const result = Bun.spawnSync(argv, { cwd, env: { ...process.env, GOPORT_LIB_PARSE_SNAPSHOT: "0", GOPORT_LIB_SNAPSHOT: "0" }, stdout: "pipe", stderr: "pipe", timeout, maxBuffer: 64 * 1024 * 1024 });
  const stdout = Buffer.from(result.stdout).toString("utf8"); const stderr = Buffer.from(result.stderr).toString("utf8");
  return { argv, cwd, kind: result.exitCode === 0 ? "success" : "nonzero", exit_code: result.exitCode, duration_ms: Math.round(performance.now() - started), stdout, stderr, stdout_bytes: result.stdout.length, stderr_bytes: result.stderr.length, stdout_hash: sha(result.stdout), stderr_hash: sha(result.stderr) };
}

export function compareScope(oracle: unknown, native: unknown, exit: number) {
  const source = object(oracle); const report = object(native);
  const admission = object(source.admission); const observed = object(report.analysisAdmission);
  const scope = object(source.scope);
  const expectedFiles = objects(object(admission.changeCoverage).files).map(({ path, status }) => ({ path, status }));
  const selected = object(report.selected_analysis); const broad = object(report.broad_analysis);
  const reasonPrefix = (value: unknown) => Array.isArray(value) && value.some(reason => typeof reason === "string" && reason.startsWith("DEPENDENCY_SCOPE_"));
  const subjects = objects(broad.subjects);
  const opaqueLimitations = (value: unknown) => Array.isArray(value) ? value.filter(entry => typeof entry === "string" && entry.startsWith("Opaque external static module boundaries")) : null;
  const componentExecuted = (value: unknown) => {
    const component = object(value);
    return component.executed === true && isDeepStrictEqual(component.unsupported, []);
  };
  const retainedPaths = source.retainedPaths;
  if (!Array.isArray(retainedPaths) || !retainedPaths.every(path => typeof path === "string")) throw new Error("ORACLE_RETAINED_PATHS_MISSING");
  const broadPaths = retainedPaths.filter(path => /\.[cm]?[jt]sx?$/.test(path)).sort();
  const selectedPaths = broadPaths.filter(path => path.startsWith("src/"));
  const scopeExecuted = (analysis: JsonObject, expectedPaths: string[]) => {
    const analyzedSubjects = objects(analysis.subjects);
    return analysis.executed !== false && analysis.global_admission_inferred === false && analyzedSubjects.length > 0
      && isDeepStrictEqual(analyzedSubjects.map(subject => subject.path).sort(), expectedPaths) && analyzedSubjects.every(subject =>
      componentExecuted(subject.retainedScopeSyntaxObservation) && componentExecuted(subject.sourceParsingObservation)
      && componentExecuted(object(subject.moduleConfigurationObservations).retainedWithSource));
  };
  return {
    admissionStatus: admission.status === observed.status,
    cliExit: exit === (admission.status === "admitted" ? 0 : 3),
    changeCoverage: isDeepStrictEqual({ expected: object(admission.changeCoverage).expected, files: expectedFiles }, observed.changeCoverage),
    completeAdmissionReasons: isDeepStrictEqual(admission.reasons, observed.reasons),
    completeScopeReasons: Array.isArray(scope.reasons) && isDeepStrictEqual(scope.reasons, report.scopeReasons),
    completeUnresolvedImports: Array.isArray(scope.unresolvedImports) && isDeepStrictEqual(scope.unresolvedImports, report.unresolvedImports),
    scopeLinks: isDeepStrictEqual([...new Set((scope.links as unknown[]).map(link => JSON.stringify(link)))].sort(), [...new Set((report.links as unknown[]).map(link => JSON.stringify(link)))].sort()),
    excludedScopeRefusal: !reasonPrefix(scope.reasons) || (observed.status === "rejected" && (reasonPrefix(observed.reasons) || subjects.some(subject => reasonPrefix(subject.reasons)))),
    externalModuleSpecifiers: Array.isArray(scope.externalModuleSpecifiers) && isDeepStrictEqual(scope.externalModuleSpecifiers, observed.externalModuleSpecifiers),
    opaqueLimitation: opaqueLimitations(admission.limitations)?.length === 1 && isDeepStrictEqual(opaqueLimitations(admission.limitations), opaqueLimitations(observed.limitations)),
    executed: scopeExecuted(selected, selectedPaths) && scopeExecuted(broad, broadPaths) && report.indexed_extraction_received === true,
  };
}

async function campaign(freezePath: string, baseline: string, output: string) {
  const runnerHash = sha(readFileSync(import.meta.path));
  const freeze = JSON.parse(readFileSync(freezePath, "utf8")) as Freeze;
  for (const key of ["artifact", "helper", "sdk"] as const) {
    if (sha(readFileSync(freeze[`${key}_path`])) !== freeze[`${key}_sha256`]) throw new Error(`FREEZE_MISMATCH:${key}`);
  }
  const baselineCommit = "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b";
  const repository = resolve(import.meta.dir, "..");
  const inventory = invoke(["git", "ls-tree", "-r", "--name-only", baselineCommit, "--", "packages", "tsconfig.json", "tsconfig.base.json", "bun.lock", "package.json", "apps/cli/package.json"], repository);
  if (inventory.exit_code !== 0 || inventory.stdout.trim() === "") throw new Error("ORACLE_BASELINE_INVENTORY_MISSING");
  const sourceManifest = inventory.stdout.trim().split("\n").map(path => {
    const expected = Bun.spawnSync(["git", "show", `${baselineCommit}:${path}`], { cwd: repository, stdout: "pipe", stderr: "pipe" });
    const bytes = readFileSync(resolve(baseline, path));
    if (expected.exitCode !== 0 || !Buffer.from(expected.stdout).equals(bytes)) throw new Error(`ORACLE_BASELINE_FILE_MISMATCH:${path}`);
    return { path, sha256: sha(bytes), bytes: bytes.length };
  });
  const ts = JSON.parse(readFileSync(resolve(baseline, "node_modules/typescript/package.json"), "utf8")) as { version: string };
  if (ts.version !== "5.9.3" || Bun.version !== "1.4.3") throw new Error("PINNED_VERSION_MISMATCH");
  mkdirSync(output, { recursive: false });
  save(resolve(output, "baseline-source-manifest.json"), { baselineCommit, files: sourceManifest });
  const units: { id: string; root: string; capture: ReturnType<typeof invoke>; report: unknown }[] = [];
  for (const fixture of fixtures) {
    const directory = resolve(output, fixture.id); const root = resolve(directory, "workspace");
    mkdirSync(root, { recursive: true });
    const files: Record<string, string> = { "src/main.ts": "export function main(){return 1;}\n", "base.json": '{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler"}}', "tsconfig.json": '{"extends":"./base.json"}', ".gitignore": ".semctx/\nbuild/\n", ...fixture.extra };
    for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(resolve(root, path)), { recursive: true }); writeFileSync(resolve(root, path), text); }
    const setup = [["init", "-q"], ["add", "."], ["-c", "user.name=T00Fixture", "-c", "user.email=t00@example.test", "commit", "-qm", "initial"]].map(args => invoke(["git", ...args], root));
    if (setup.some(result => result.exit_code !== 0)) throw new Error(JSON.stringify(setup));
    save(resolve(directory, "setup.json"), setup);
    files["src/main.ts"] = fixture.main; writeFileSync(resolve(root, "src/main.ts"), fixture.main);
    const retained = Object.fromEntries(Object.entries(files).filter(([path]) => !path.startsWith("build/")).map(([path, text]) => [resolve(root, path), text]));
    const request = { id: fixture.id, cwd: root, case_sensitive: process.platform !== "darwin", files: retained, roots: Object.keys(retained).filter(path => path.includes("/src/") && path.endsWith(".ts")).sort(), options: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowJs: true, jsx: "Preserve", skipLibCheck: true, noEmit: true, strict: false }, retained: true, qualified: true, sdk_directory: "/sdk/lib", roles: {}, selection: {}, disabled: [], utf16_files: {}, raw_files: {} };
    const requestPath = resolve(directory, "request.json"); save(requestPath, request);
    const index = invoke([freeze.artifact_path, "--batch", requestPath, freeze.sdk_path], root); save(resolve(directory, "index-capture.json"), index);
    const { argv: indexArgv, cwd: indexCwd, ...outcome } = index;
    save(resolve(directory, "index-invocation.json"), { argv: indexArgv, cwd: indexCwd });
    const descriptor = { repositoryRoot: root, processHelper: freeze.helper_path, include: ["src/**/*.ts"], exclude: ["node_modules", "dist", ".semctx", ".git", "coverage"], index: { analysis: request, outcome, baseCommit: invoke(["git", "rev-parse", "HEAD"], root).stdout.trim() } };
    const descriptorPath = resolve(directory, "descriptor.json"); save(descriptorPath, descriptor);
    const capture = invoke([freeze.artifact_path, "verify", "working-tree", descriptorPath, freeze.sdk_path, "--fail-on", "none"], root); save(resolve(directory, "native-capture.json"), capture);
    let report: unknown;
    try { report = JSON.parse(capture.stdout); } catch { report = { processError: capture.stderr }; }
    save(resolve(directory, "native-report.json"), report);
    if (fixture.id === "inherited-positive") {
      const guards: unknown[] = [];
      for (const fault of ["stdout-hash", "sdk-identity", "missing-capture", "changed-bytes", "base-commit"]) {
        const mutated = structuredClone(descriptor);
        if (fault === "stdout-hash") mutated.index.outcome.stdout_hash = "0".repeat(64);
        if (fault === "sdk-identity") {
          const foreignSdk = object(JSON.parse(readFileSync(freeze.sdk_path, "utf8")));
          const sdkFiles = object(foreignSdk.files); const firstPath = Object.keys(sdkFiles).sort()[0]!;
          if (typeof sdkFiles[firstPath] !== "string") throw new Error("SDK_SOURCE_MISSING");
          sdkFiles[firstPath] += "\n";
          const sdkPath = resolve(directory, "foreign-sdk.json"); save(sdkPath, foreignSdk);
          const foreign = invoke([freeze.artifact_path, "--batch", requestPath, sdkPath], root);
          save(resolve(directory, "foreign-sdk-index-capture.json"), foreign);
          const { argv: foreignArgv, cwd: foreignCwd, ...foreignOutcome } = foreign;
          save(resolve(directory, "foreign-sdk-invocation.json"), { argv: foreignArgv, cwd: foreignCwd });
          mutated.index.outcome = foreignOutcome;
        }
        if (fault === "missing-capture") delete mutated.index.analysis.files[resolve(root, "base.json")];
        if (fault === "changed-bytes") mutated.index.analysis.files[resolve(root, "src/main.ts")] += "\n";
        if (fault === "base-commit") mutated.index.baseCommit = "0".repeat(40);
        const path = resolve(directory, `guard-${fault}.json`); save(path, mutated);
        const observation = invoke([freeze.artifact_path, "verify", "working-tree", path, freeze.sdk_path, "--fail-on", "none"], root);
        save(resolve(directory, `guard-${fault}-capture.json`), observation);
        guards.push({ fault, refused: observation.exit_code !== 0, exit: observation.exit_code, stderr: observation.stderr });
      }
      save(resolve(output, "guards.json"), guards);
    }
    units.push({ id: fixture.id, root, capture, report });
  }
  const paths: Record<string, string[]> = {};
  for await (const path of new Bun.Glob("packages/*/package.json").scan({ cwd: baseline, absolute: true })) {
    const metadata = JSON.parse(readFileSync(path, "utf8")) as { name: string; exports?: Record<string, unknown>; main?: string };
    for (const [key, value] of Object.entries(metadata.exports ?? {})) if (typeof value === "string") paths[metadata.name + (key === "." ? "" : key.slice(1))] = [resolve(dirname(path), value)];
    paths[metadata.name] ??= [resolve(dirname(path), metadata.main ?? "src/index.ts")];
  }
  const coreMetadata = JSON.parse(readFileSync(resolve(baseline, "packages/core/package.json"), "utf8")) as { dependencies: Record<string, string> };
  const dependencies = ["node_modules/.bun/*/node_modules/*/package.json", "node_modules/.bun/*/node_modules/@*/*/package.json"].flatMap(pattern => [...new Bun.Glob(pattern).scanSync({ cwd: baseline, absolute: true, followSymlinks: true })]).sort();
  for (const path of dependencies) {
    const metadata = JSON.parse(readFileSync(path, "utf8")) as { name?: string; version: string; module?: string; main?: string };
    const entry = metadata.module ?? metadata.main;
    if (metadata.name === "zod" && !Bun.semver.satisfies(metadata.version, coreMetadata.dependencies.zod!)) continue;
    if (metadata.name && entry) paths[metadata.name] ??= [resolve(dirname(path), entry)];
  }
  const config = resolve(output, "oracle-tsconfig.json"); save(config, { extends: resolve(baseline, "tsconfig.json"), compilerOptions: { baseUrl: baseline, paths } });
  const inputPath = resolve(output, "oracle-input.json"); const oracleOutput = resolve(output, "oracle-output.json");
  save(inputPath, { units: units.map(({ id, root }) => ({ id, root })) });
  const oracle = invoke([process.execPath, "--tsconfig-override", config, resolve(import.meta.dir, "../tools/rust-ts-r0/qualification/public-closure-20261022/scope-oracle.mjs"), baseline, inputPath, oracleOutput], baseline, 180_000);
  save(resolve(output, "oracle-capture.json"), oracle);
  if (oracle.exit_code !== 0) throw new Error(`ORACLE_FAILED:${oracle.stderr}`);
  const expected = object(JSON.parse(readFileSync(oracleOutput, "utf8")));
  if (expected.typescript !== "5.9.3") throw new Error("ORACLE_TYPESCRIPT_MISMATCH");
  const sourceUnits = objects(expected.units);
  if (sourceUnits.length !== fixtures.length || new Set(sourceUnits.map(unit => unit.id)).size !== fixtures.length) throw new Error("INCOMPLETE_ORACLE_UNITS");
  const results = units.map(unit => {
    const source = sourceUnits.find(row => row.id === unit.id);
    try { return { id: unit.id, comparisons: compareScope(source, unit.report, unit.capture.exit_code), nativeExit: unit.capture.exit_code }; }
    catch (error) { return { id: unit.id, comparisons: null, nativeExit: unit.capture.exit_code, unavailable: String(error) }; }
  });
  for (const key of ["artifact", "helper", "sdk"] as const) if (sha(readFileSync(freeze[`${key}_path`])) !== freeze[`${key}_sha256`]) throw new Error(`FREEZE_CHANGED:${key}`);
  for (const file of sourceManifest) if (sha(readFileSync(resolve(baseline, file.path))) !== file.sha256) throw new Error(`ORACLE_BASELINE_CHANGED:${file.path}`);
  if (runnerHash !== sha(readFileSync(import.meta.path))) throw new Error("RUNNER_CHANGED_DURING_CAMPAIGN");
  save(resolve(output, "summary.json"), { candidate: freeze, baselineCommit, baselineRecheckedAfterExecution: true, runnerHash, typescript: expected.typescript, platform: process.platform, arch: process.arch, bun: Bun.version, fixtureIds: fixtures.map(fixture => fixture.id), results });
  console.log(JSON.stringify({ output, units: results.length }));
}

if (import.meta.main) {
  const [freeze, baseline, output] = process.argv.slice(2);
  if (!freeze || !baseline || !output) throw new Error("usage: t00-lot1-scope.ts FREEZE BASELINE NEW_OUTPUT");
  await campaign(resolve(freeze), resolve(baseline), resolve(output));
}
