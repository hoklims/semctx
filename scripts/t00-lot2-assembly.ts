import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

type Value = Record<string, unknown>;
const record = (value: unknown): Value => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const read = (path: string): Value => record(JSON.parse(readFileSync(path, "utf8")) as unknown);
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const save = (path: string, value: unknown): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + "\n"); };
const strings = (values: unknown): unknown[] => Array.isArray(values) ? values as unknown[] : [];
const sorted = (values: unknown): unknown[] => strings(values).map(canonical).toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(record(value)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
const identity = (value: unknown): string => "sha256:" + sha(JSON.stringify(canonical(value)));

export function compareAssembly(sourceValue: unknown, nativeValue: unknown, execution?: { index: unknown; verification: unknown }): { pass: boolean; properties: Record<string, boolean> } {
  const source = record(sourceValue), native = record(nativeValue);
  const populated = strings(record(source["graph"])["nodes"]).length > 0 && strings(record(native["graph"])["nodes"]).length > 0;
  const complete = (value: Value): boolean => Array.isArray(record(value["graph"])["edges"]) && Array.isArray(value["imports"]) && value["integrityReasons"] !== undefined && ["admitted", "rejected"].includes(String(record(value["admission"])["status"])) && Array.isArray(record(value["admission"])["reasons"]) && strings(record(record(value["admission"])["changeCoverage"])["files"]).length > 0;
  const processSucceeded = (value: unknown): boolean => { const capture = record(value); return capture["kind"] === "success" && capture["exit_code"] === 0 && capture["error"] === undefined; };
  const properties: Record<string, boolean> = { populated, complete: complete(source) && complete(native), "process.index": processSucceeded(execution?.index), "process.verification": processSucceeded(execution?.verification) };
  for (const key of ["nodes", "edges"]) properties["graph." + key] = populated && isDeepStrictEqual(sorted(record(source["graph"])[key]), sorted(record(native["graph"])[key]));
  for (const key of ["integrityReasons", "imports"]) properties[key] = populated && isDeepStrictEqual(source[key], native[key]);
  for (const key of ["status", "reasons"]) properties["admission." + key] = populated && isDeepStrictEqual(record(source["admission"])[key], record(native["admission"])[key]);
  const coverage = (value: unknown): unknown[] => sorted(strings(record(record(value)["changeCoverage"])["files"]).map(file => ({ path: record(file)["path"], status: record(file)["status"], reasons: record(file)["reasons"] ?? [] })));
  properties["admission.changeCoverage.files"] = populated && isDeepStrictEqual(coverage(source["admission"]), coverage(native["admission"]));
  return { pass: Object.values(properties).every(Boolean), properties };
}

export const assemblyCases = [
  { id: "literal-test", path: "test/main.test.ts", text: "export async function check() { return import('../src/main'); }\n", pair: "static-test" },
  { id: "static-test", path: "test/main.test.ts", text: "import { main } from '../src/main'; export function check() { return main(); }\n", pair: "literal-test" },
  { id: "literal-src-test", path: "src/main.test.ts", text: "export async function check() { return import('./main'); }\n", pair: "static-src-test" },
  { id: "static-src-test", path: "src/main.test.ts", text: "import { main } from './main'; export function check() { return main(); }\n", pair: "literal-src-test" },
  { id: "nonliteral-test", path: "test/main.test.ts", text: "const moduleName = '../src/main'; export async function check() { return import(moduleName); }\n", pair: "literal-test" },
  { id: "twoarg-test", path: "test/main.test.ts", text: "export async function check() { return import('../src/main', {}); }\n", pair: "literal-test" },
  { id: "unresolved-test", path: "test/main.test.ts", text: "export async function check() { return import('../src/absent'); }\n", pair: "literal-test" },
];

function invoke(argv: string[], cwd: string): Value {
  const start = performance.now();
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd, timeout: 60_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GOPORT_LIB_PARSE_SNAPSHOT: "0", GOPORT_LIB_SNAPSHOT: "0", GIT_AUTHOR_DATE: "2026-10-23T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-23T00:00:00Z" } });
  const stdout = result.stdout ?? Buffer.alloc(0), stderr = result.stderr ?? Buffer.alloc(0);
  return { kind: result.status === 0 ? "success" : "nonzero", exit_code: result.status, duration_ms: Math.floor(performance.now() - start), stdout: stdout.toString(), stderr: stderr.toString(), stdout_bytes: stdout.length, stderr_bytes: stderr.length, stdout_hash: sha(stdout), stderr_hash: sha(stderr), error: result.error?.message };
}

async function oracle(baseline: string, inputPath: string, outputPath: string): Promise<void> {
  const activeTypeScript = await import("typescript");
  const canonicalTypeScript = await import(resolve(baseline, "node_modules/typescript/lib/typescript.js")) as { default: { version: string } };
  if (activeTypeScript.default !== canonicalTypeScript.default || canonicalTypeScript.default.version !== "5.9.3") throw Error("Oracle compiler binding differs from canonical TypeScript 5.9.3");
  const core = await import(resolve(baseline, "packages/core/src/index.ts")) as typeof import("../packages/core/src/index");
  const store = await import(resolve(baseline, "packages/repository-store/src/index.ts")) as typeof import("../packages/repository-store/src/index");
  const indexing = await import(resolve(baseline, "packages/app-services/src/indexing.ts")) as typeof import("../packages/app-services/src/indexing");
  const freshness = await import(resolve(baseline, "packages/app-services/src/freshness.ts")) as typeof import("../packages/app-services/src/freshness");
  const analyzer = await import(resolve(baseline, "packages/ts-analyzer/src/analyze.ts")) as typeof import("../packages/ts-analyzer/src/analyze");
  const symbols = await import(resolve(baseline, "packages/ts-analyzer/src/ts-symbols.ts")) as typeof import("../packages/ts-analyzer/src/ts-symbols");
  const verify = await import(resolve(baseline, "packages/app-services/src/verify.ts")) as typeof import("../packages/app-services/src/verify");
  const units: unknown[] = [];
  for (const value of strings(read(inputPath)["units"])) {
    const unit = record(value), root = String(unit["root"]);
    try {
      const config = { ...core.createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*.ts", "test/**/*.ts"] } as unknown as import("../packages/core/src/index").SemctxConfig;
      store.initWorkspace(root, config);
      indexing.indexRepository(root, "2026-10-23T10:01:00.000Z");
      const consumed = freshness.captureQualifiedAnalysisInputs(config);
      const retained = new Map(consumed.files.map(file => [resolve(root, file.path), Buffer.from(file.bytes).toString("utf8")]));
      const analysis = analyzer.analyzeRepository(config, undefined, retained);
      const extraction = symbols.extractTypeScript([...retained.keys()].filter(path => path.endsWith(".ts")), root, retained);
      const verification = verify.runVerify(root, { kind: "working-tree" });
      units.push({ id: unit["id"], graph: analysis.graph, imports: extraction.imports, extraction, integrityReasons: Object.fromEntries(analyzer.getQualifiedCallIntegrityReasons(analysis)), admission: verification.report.analysisAdmission, verification, retainedPaths: consumed.files.map(file => file.path), retainedDigest: consumed.digest });
    } catch (error) { units.push({ id: unit["id"], error: String(error), stack: error instanceof Error ? error.stack : undefined }); }
  }
  save(outputPath, { typescript: canonicalTypeScript.default.version, typescriptEntrySha256: sha(readFileSync(resolve(baseline, "node_modules/typescript/lib/typescript.js"))), baseline, baselineCommit: "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b", units });
}

function oracleConfig(baseline: string, path: string): void {
  const paths: Record<string, string[]> = {};
  for (const directory of readdirSync(resolve(baseline, "packages"))) {
    const metadata = read(resolve(baseline, "packages", directory, "package.json")), name = String(metadata["name"]);
    for (const [key, value] of Object.entries(record(metadata["exports"]))) if (typeof value === "string") paths[name + (key === "." ? "" : key.slice(1))] = [resolve(baseline, "packages", directory, value)];
    paths[name] ??= [resolve(baseline, "packages", directory, "src/index.ts")];
  }
  for (const directory of readdirSync(resolve(baseline, "node_modules/.bun"))) {
    const modules = resolve(baseline, "node_modules/.bun", directory, "node_modules");
    try {
      for (const name of readdirSync(modules).flatMap(name => name.startsWith("@") ? readdirSync(resolve(modules, name)).map(child => name + "/" + child) : [name])) {
        try { if (lstatSync(resolve(modules, name)).isSymbolicLink()) continue; const metadata = read(resolve(modules, name, "package.json")), entry = metadata["module"] ?? metadata["main"]; if (typeof entry === "string") paths[name] ??= [resolve(modules, name, entry)]; } catch { continue; }
      }
    } catch { continue; }
  }
  paths["typescript"] = [resolve(baseline, "node_modules/typescript/lib/typescript.js")];
  save(path, { extends: resolve(baseline, "tsconfig.json"), compilerOptions: { baseUrl: baseline, paths } });
}

function baselineProvenance(baseline: string): Value {
  const commit = "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b";
  const tree = invoke(["git", "ls-tree", "-r", "-z", commit, "--", "packages"], resolve(import.meta.dir, ".."));
  if (tree["exit_code"] !== 0) throw Error("Independent baseline Git tree unavailable");
  const checked: { path: string; blob: string; sha256: string; bytes: number }[] = [];
  for (const entry of String(tree["stdout"]).split("\0").filter(Boolean)) {
    const match = /^100[0-9]+ blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (match === null) throw Error("Unsupported baseline tree entry: " + entry);
    const path = match[2]!, bytes = readFileSync(resolve(baseline, path));
    const blob = createHash("sha1").update("blob " + String(bytes.length) + "\0").update(bytes).digest("hex");
    if (blob !== match[1]) throw Error("Independent baseline content mismatch: " + path);
    checked.push({ path, blob, sha256: sha(bytes), bytes: bytes.length });
  }
  if (checked.length === 0) throw Error("Empty independent baseline source inventory");
  return { commit, checked };
}

async function campaign(freezePath: string, baseline: string, output: string): Promise<void> {
  mkdirSync(output, { recursive: false });
  const freeze = read(freezePath), evidence: unknown[] = [], units: { id: string; root: string }[] = [];
  save(resolve(output, "baseline-provenance.json"), baselineProvenance(baseline));
  const pinned = (): void => { for (const key of ["artifact", "helper", "sdk"]) if (sha(readFileSync(String(freeze[key + "_path"]))) !== freeze[key + "_sha256"]) throw Error("Frozen input mismatch: " + key); };
  pinned();
  for (const fixture of assemblyCases) {
    const directory = resolve(output, fixture.id), root = resolve(directory, "workspace");
    mkdirSync(root, { recursive: true });
    const files = { "src/main.ts": "export function main() { return 1; }\n", [fixture.path]: fixture.text, ".gitignore": ".semctx/\n" };
    for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(resolve(root, path)), { recursive: true }); writeFileSync(resolve(root, path), text); }
    const setup: unknown[] = [];
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=T00Fixture", "-c", "user.email=t00@example.test", "commit", "-qm", "initial"]]) { const capture = invoke(["git", ...args], root); setup.push(capture); if (capture["exit_code"] !== 0) throw Error("Git setup failed: " + JSON.stringify(capture)); }
    const head = invoke(["git", "rev-parse", "--verify", "HEAD"], root);
    files["src/main.ts"] = "export function main() { return 2; }\n"; writeFileSync(resolve(root, "src/main.ts"), files["src/main.ts"]);
    const request = { id: fixture.id, cwd: root, case_sensitive: process.platform !== "darwin", files: Object.fromEntries(Object.entries(files).map(([path, text]) => [resolve(root, path), text])), roots: Object.keys(files).filter(path => path.endsWith(".ts")).map(path => resolve(root, path)).sort(), options: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowJs: true, jsx: "Preserve", skipLibCheck: true, noEmit: true, strict: false }, retained: true, qualified: true, sdk_directory: "/sdk/lib", roles: { [fixture.path]: "test" }, selection: {}, disabled: [], utf16_files: {}, raw_files: {} };
    const requestPath = resolve(directory, "request.json"); save(requestPath, request);
    const index = invoke([String(freeze["artifact_path"]), "--batch", requestPath, String(freeze["sdk_path"])], root);
    const descriptor = { repositoryRoot: root, processHelper: freeze["helper_path"], include: ["src/**/*.ts", "test/**/*.ts"], exclude: ["node_modules", "dist", ".semctx", ".git", "coverage"], index: { analysis: request, outcome: index, baseCommit: String(head["stdout"]).trim() } };
    const descriptorPath = resolve(directory, "descriptor.json"); save(descriptorPath, descriptor);
    const verification = invoke([String(freeze["artifact_path"]), "verify", "working-tree", descriptorPath, String(freeze["sdk_path"]), "--fail-on", "none"], root);
    save(resolve(directory, "setup-capture.json"), setup); save(resolve(directory, "index-capture.json"), index); save(resolve(directory, "verify-capture.json"), verification);
    let report: Value; try { report = record(JSON.parse(String(verification["stdout"])) as unknown); } catch { report = { error: verification["stderr"] }; }
    save(resolve(directory, "native-report.json"), report);
    const broad = record(report["broad_analysis"]), assembly = record(broad["assembly"]);
    evidence.push({ id: fixture.id, pair: fixture.pair, execution: { index, verification }, indexExit: index["exit_code"], verificationExit: verification["exit_code"], binding: { indexedExtractionReceived: report["indexed_extraction_received"] === true, producerBound: report["producer_artifact_id"] === "sha256:" + String(freeze["artifact_sha256"]), requestDescriptorBound: report["request_descriptor_id"] === identity(descriptor), sdkInputBound: report["sdk_input_id"] === identity(read(String(freeze["sdk_path"]))), gitObserved: record(report["head_git_outcome"])["exit_code"] === 0 && record(report["changed_git_outcome"])["exit_code"] === 0 }, native: { graph: { nodes: assembly["nodes"], edges: assembly["edges"] }, integrityReasons: assembly["integrityReasons"], imports: record(broad["raw_extraction"])["imports"], admission: report["analysisAdmission"] } });
    units.push({ id: fixture.id, root });
  }
  const input = resolve(output, "oracle-input.json"), oracleOutput = resolve(output, "oracle-output.json"), config = resolve(output, "oracle-tsconfig.json");
  save(input, { units }); oracleConfig(baseline, config);
  const oracleCapture = invoke([process.execPath, "--tsconfig-override", config, resolve(import.meta.path), "oracle", baseline, input, oracleOutput], baseline);
  save(resolve(output, "oracle-capture.json"), oracleCapture);
  if (oracleCapture["exit_code"] !== 0) throw Error("Oracle failed: " + JSON.stringify(oracleCapture));
  const source = strings(read(oracleOutput)["units"]);
  const results = evidence.map(value => { const unit = record(value), expected = source.find(item => record(item)["id"] === unit["id"]); const execution = record(unit["execution"]); const comparison = compareAssembly(expected, unit["native"], { index: execution["index"], verification: execution["verification"] }); for (const [key, valid] of Object.entries(record(unit["binding"]))) comparison.properties["binding." + key] = valid === true; comparison.pass = Object.values(comparison.properties).every(Boolean); return { ...unit, comparison }; });
  pinned(); save(resolve(output, "observations.json"), { freeze, environment: { platform: process.platform, arch: process.arch, bun: Bun.version }, oracleBaseline: "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b", results });
  process.stdout.write(JSON.stringify({ output, results: results.map(item => ({ id: record(item)["id"], comparison: item.comparison })) }) + "\n");
}

if (import.meta.main) {
  const [mode, first, second, third] = process.argv.slice(2);
  if (!first || !second || !third) throw Error("Usage: t00-lot2-assembly.ts campaign FREEZE BASELINE OUTPUT | oracle BASELINE INPUT OUTPUT");
  if (mode === "oracle") await oracle(first, second, third);
  else if (mode === "campaign") await campaign(first, second, third);
  else throw Error("Unknown mode");
}
