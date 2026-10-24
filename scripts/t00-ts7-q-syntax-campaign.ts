import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { combineCampaignCases, comparisonMatches, projectComparison } from "./t00-ts7-q-syntax-checker-cases.js";
import { readAt, shardIndices, verifyFile } from "./t00-ts7-q-syntax-core.js";
import type { CampaignCase, CandidateManifest, FileRef, PlatformArtifacts } from "./t00-ts7-q-syntax-types.js";

const revision = "780dc512d64f40afebffa6a7028207649fb7ed1c";
const libraryManifestHash = "b1fa7b60aa83d187453b26c0b56a096875a47e61977954aba7deba16161fd7ad";
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error("expected array");
  return value as unknown[];
};
const text = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("expected string");
  return value;
};
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8")) as unknown;

function artifact(value: unknown): FileRef {
  const item = object(value);
  if (!isAbsolute(text(item.path)) || !/^[a-f0-9]{64}$/.test(text(item.sha256)) ||
      typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes <= 0)
    throw new Error("invalid artifact path/hash/size");
  return { path: text(item.path), sha256: text(item.sha256), bytes: item.bytes };
}

export async function loadCandidate(path: string, platform: "macos" | "linux"): Promise<{
  manifest: CandidateManifest; artifacts: PlatformArtifacts; refs: FileRef[]; manifestHash: string;
}> {
  const bytes = await readFile(path);
  const value = object(JSON.parse(bytes.toString()) as unknown);
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(text(value.sourceCommit)))
    throw new Error("invalid candidate schemaVersion/sourceCommit");
  const source = object(object(value.platforms)[platform]);
  const artifacts = {
    producer: artifact(source.producer), helper: artifact(source.helper), observer: artifact(source.observer),
    sdk: artifact(source.sdk), oracle: artifact(source.oracle), oracleLibraries: artifact(source.oracleLibraries),
    syntaxOracle: artifact(source.syntaxOracle),
  };
  const refs = Object.values(artifacts);
  for (const ref of refs) await verifyFile(ref);
  if (artifacts.oracleLibraries.sha256 !== libraryManifestHash)
    throw new Error("oracleLibraries is not the pinned TS7 inventory");
  const libraries = array(await json(artifacts.oracleLibraries.path));
  if (libraries.length !== 115) throw new Error("115 TS7 libraries required");
  const sdk = object(await json(artifacts.sdk.path));
  const captured = object(sdk.files);
  if (sdk.version !== "7.1.0-dev" || sdk.source_revision !== revision ||
      sdk.library_manifest_sha256 !== libraryManifestHash || Object.keys(captured).length !== 115)
    throw new Error("explicit SDK7 descriptor with 115 libraries required");
  const names = new Set<string>();
  const sdkRoots = [...new Set([dirname(await realpath(artifacts.oracle.path)), dirname(await realpath(artifacts.syntaxOracle.path))])];
  for (const entry of libraries) {
    const lib = object(entry);
    const name = text(lib.path);
    if (!/^lib(?:\.[a-zA-Z0-9.-]+)?\.d\.ts$/.test(name) || names.has(name))
      throw new Error("invalid/duplicate library name");
    names.add(name);
    for (const sdkRoot of sdkRoots) {
      const ref = artifact({ ...lib, path: join(sdkRoot, name) });
      if (await realpath(ref.path) !== ref.path) throw new Error("oracle library symlink not accepted");
      await verifyFile(ref);
      refs.push(ref);
    }
    const content = text(captured[`/sdk/lib/${name}`]);
    if (Buffer.byteLength(content) !== lib.bytes || hash(content) !== lib.sha256)
      throw new Error(`captured SDK library mismatch: ${name}`);
  }
  for (const sdkRoot of sdkRoots) {
    const physical = (await readdir(sdkRoot)).filter(name => /^lib.*\.d\.ts$/.test(name));
    if (physical.length !== 115 || physical.some(name => !names.has(name)))
      throw new Error("physical oracle SDK inventory mismatch");
  }
  return {
    manifest: { schemaVersion: 1, sourceCommit: text(value.sourceCommit), platforms: { [platform]: artifacts },
      ...(value.purpose === "rehearsal" ? { purpose: "rehearsal" as const } : {}) },
    artifacts, refs, manifestHash: hash(bytes),
  };
}

async function save(path: string, value: unknown): Promise<FileRef> {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  await writeFile(path, bytes, { flag: "wx" });
  return { path, sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
}

async function execute(argv: string[], cwd: string, input?: unknown): Promise<{
  argv: string[]; cwd: string; exitCode: number; stdout: string; stderr: string; durationMs: number;
}> {
  const started = performance.now();
  const env: Record<string, string | undefined> = { ...process.env, GOPORT_LIB_PARSE_SNAPSHOT: "0", GOPORT_LIB_SNAPSHOT: "0" };
  delete env.GOPORT_BUILD_VERSION;
  delete env.GIT_CONFIG_GLOBAL;
  const child = Bun.spawn(argv, { cwd, env, stdin: input === undefined ? "ignore" : new TextEncoder().encode(JSON.stringify(input)),
    stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 16 * 1024 * 1024)
    throw new Error("process output limit exceeded");
  return { argv, cwd, exitCode, stdout, stderr, durationMs: performance.now() - started };
}

async function materialize(item: CampaignCase, root: string): Promise<Record<string, unknown>> {
  const template = item.request;
  const files = object(template.files);
  const absolute: Record<string, string> = {};
  for (const [path, value] of Object.entries(files)) {
    if (isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || part === "") || path.includes("\\"))
      throw new Error("fixture path escapes workspace");
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text(value), { flag: "wx" });
    absolute[target] = text(value);
  }
  const roots = (template.roots === undefined ? Object.keys(files) : array(template.roots).map(text)).map(path => {
    if (!Object.hasOwn(files, path)) throw new Error("fixture root is not captured");
    return join(root, path);
  });
  const sentinel = join(root, "T00NativeCaseSentinel");
  await writeFile(sentinel, "probe");
  const caseSensitive = !(await Bun.file(join(root, "t00nativecasesentinel")).exists());
  return { id: item.name, cwd: root, sdk_directory: "/sdk/lib", case_sensitive: caseSensitive,
    options: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowJs: true, jsx: "Preserve",
      skipLibCheck: true, noEmit: true, strict: false }, retained: true, qualified: false,
    roles: {}, selection: {}, disabled: [], utf16_files: {}, raw_files: {},
    ...template, files: absolute, roots };
}

async function runCase(item: CampaignCase, dir: string, artifacts: PlatformArtifacts) {
  const started = performance.now();
  await mkdir(dir);
  const root = join(dir, "workspace");
  await mkdir(root);
  const input = { ...item.oracleInput, sdk_directory: dirname(artifacts.oracle.path), sdk_input: artifacts.sdk.path };
  const evidence = [await save(join(dir, "oracle-input.json"), input)];
  const oracleRun = await execute([artifacts.syntaxOracle.path], root, input);
  evidence.push(await save(join(dir, "oracle-process.json"), oracleRun));
  if (oracleRun.exitCode !== 0) throw new Error(`oracle ${item.name} failed: ${oracleRun.stderr}`);
  const expected = object(JSON.parse(oracleRun.stdout) as unknown);
  if (expected.compilerVersion !== "7.1.0-dev" || expected.sourceRevision !== revision || expected.sdkLibraryCount !== 115)
    throw new Error("oracle identity mismatch");
  const request = item.mode === "primitive" ? item.request : await materialize(item, root);
  const requestPath = join(dir, "request.json");
  evidence.push(await save(requestPath, request));
  const args = item.mode === "primitive" ? ["--observe-primitives", requestPath] : [requestPath, artifacts.sdk.path];
  const producer = await execute([artifacts.producer.path, ...args], root);
  evidence.push(await save(join(dir, "producer-process.json"), producer));
  const actual: unknown = producer.exitCode === 0 ? JSON.parse(producer.stdout) as unknown : null;
  const checks = item.checks.map(check => {
    try {
      if (producer.exitCode !== 0) throw new Error(`producer exit ${producer.exitCode}: ${producer.stderr.trim()}`);
      const observed = projectComparison(readAt(actual, check.actual), check.transform);
      const wanted = readAt(expected, check.expected);
      const passed = comparisonMatches(observed, wanted, check.comparison);
      return { ...check, status: passed ? "passed" : "failed", reason: passed ? "exact independent TS7 comparison" : "independent TS7 mismatch",
        actualValue: observed, expectedValue: wanted };
    } catch (error) {
      return { ...check, status: "failed", reason: String(error) };
    }
  });
  if (!checks.length) throw new Error(`empty comparisons: ${item.name}`);
  evidence.push(await save(join(dir, "comparisons.json"), checks));
  return { name: item.name, indices: item.indices, checks, evidence, durationMs: performance.now() - started };
}

async function main() {
  const started = performance.now();
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (!key || !["--candidate", "--platform", "--out", "--shard"].includes(key) || value === undefined || options.has(key))
      throw new Error("expected --candidate FILE --platform macos|linux --out DIR [--shard i/n]");
    options.set(key, value);
  }
  const platform = options.get("--platform");
  if (platform !== "macos" && platform !== "linux") throw new Error("invalid platform");
  if (process.platform !== (platform === "macos" ? "darwin" : "linux") || process.arch !== "arm64")
    throw new Error("campaign requires the declared native ARM64 platform");
  const candidatePath = resolve(text(options.get("--candidate")));
  const out = resolve(text(options.get("--out")));
  const shard = options.get("--shard") ?? "1/1";
  const candidate = await loadCandidate(candidatePath, platform);
  const modules = await Promise.all([import("./t00-ts7-q-syntax-j.js"), import("./t00-ts7-q-syntax-o.js"), import("./t00-ts7-q-syntax-x.js"), import("./t00-ts7-q-syntax-checker-j.js"), import("./t00-ts7-q-syntax-checker-x.js"), import("./t00-ts7-q-syntax-checker-partition.js"), import("./t00-ts7-q-syntax-checker-parsing.js")]);
  const { cases: allCases, gaps, propertyWitnesses: witnesses } = combineCampaignCases(modules);
  if (new Set(allCases.map(item => item.name)).size !== allCases.length) throw new Error("duplicate witness names");
  const indices = [7,8,9,10,11,17,18,19,...Array.from({length:16},(_,i)=>28+i),48,
    ...Array.from({length:30},(_,i)=>137+i),...Array.from({length:16},(_,i)=>176+i),197,206,207,208,209,214,215,221,222];
  const selected = new Set(shardIndices(indices, shard));
  const contractsPath = resolve(import.meta.dir, "../docs/research/rust-ts-r0/qualification/suite-20261022/consumer-contracts.json");
  const rows = array(object(await json(contractsPath)).rows).map(object).filter(row => selected.has(Number(row.index)));
  if (rows.length !== selected.size) throw new Error("missing obligation contract");
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out);
  const version = await execute([candidate.artifacts.oracle.path, "--version"], out);
  if (version.exitCode !== 0 || version.stdout.trim() !== "Version 7.1.0-dev") throw new Error("upstream tsgo identity mismatch");
  const versionRef = await save(join(out, "tsgo-version.json"), version);
  const runnerSources = await Promise.all(["campaign", "core", "types", "j", "o", "x", "checker-cases", "checker-graph", "checker-j", "checker-x", "checker-partition", "checker-parsing"].map(async name => {
    const path = join(import.meta.dir, `t00-ts7-q-syntax-${name}.ts`);
    const bytes = await readFile(path);
    return { path, sha256: hash(bytes), bytes: bytes.length };
  }));
  const binding = await save(join(out, "campaign-binding.json"), { candidateManifestSha256: candidate.manifestHash,
    sourceCommit: candidate.manifest.sourceCommit, artifacts: candidate.artifacts, contracts: hash(await readFile(contractsPath)),
    runnerSources,
    purpose: candidate.manifest.purpose ?? "qualification", helperAndObserver: "fingerprints checked; historical TS5 observer not executed" });
  const observations: Awaited<ReturnType<typeof runCase>>[] = [];
  const errors: { name: string; error: string; evidence: FileRef[] }[] = [];
  for (const item of allCases.filter(item => item.indices.some(index => selected.has(index)))) {
    const caseId = hash(item.name).slice(0, 16);
    try { observations.push(await runCase(item, join(out, `case-${caseId}`), candidate.artifacts)); }
    catch (error) {
      const detail = { name: item.name, error: String(error) };
      errors.push({ ...detail, evidence: [await save(join(out, `case-${caseId}-error.json`), detail)] });
    }
  }
  for (const ref of [...candidate.refs, ...runnerSources]) await verifyFile(ref);
  if (hash(await readFile(candidatePath)) !== candidate.manifestHash) throw new Error("candidate manifest changed during campaign");
  const results = rows.map(row => {
    const index = Number(row.index);
    const relevant = observations.filter(item => item.indices.includes(index));
    const relevantErrors = errors.filter(error => allCases.find(item => item.name === error.name)?.indices.includes(index));
    const evidence = [binding, versionRef, ...relevant.flatMap(item => item.evidence), ...relevantErrors.flatMap(error => error.evidence)];
    const contract = object(row.observableContract);
    const properties = array(contract.properties).map((property, position) => {
      const label = text(object(property).property);
      const names = witnesses[index]?.[label] ?? [];
      const cases = names.map(name => relevant.find(item => item.name === name));
      const complete = names.length > 0 && cases.every(item => item !== undefined && item.checks.every(check => check.status === "passed"));
      return { id: `${index}:${position}`, property: label, scope: object(property).scope,
        status: names.length === 0 ? "not_run" : complete ? "passed" : "failed",
        reason: names.length === 0 ? "independent activating/control witness mapping missing" : complete ? "all mapped independent TS7 comparisons passed" : "mapped witness failed or was not executable",
        witnesses: names, evidence: cases.flatMap(item => item?.evidence ?? []) };
    });
    const supports = array(row.requiredSupportIds).map(text);
    if (supports.length) properties.push({ id: `${index}:supports`, property: "cumulative required supports", scope: supports,
      status: "not_run", reason: "required support boundaries not executed by this syntax runner", witnesses: [], evidence: [] });
    if (gaps[index]) properties.push({ id: `${index}:gap`, property: "remaining consumer coverage", scope: "TS7 cumulative contract",
      status: "not_run", reason: gaps[index], witnesses: [], evidence: [] });
    const qualified = properties.length > 0 && properties.every(property => property.status === "passed") &&
      relevant.length > 0 && relevant.every(item => item.checks.every(check => check.status === "passed")) && relevantErrors.length === 0;
    return { index, id: text(row.id), status: qualified ? "qualified" : "not_qualified",
      reason: qualified ? "finite local-platform cumulative properties passed; cross-platform aggregation required" :
        gaps[index] ?? properties.find(property => property.status !== "passed")?.reason ?? "independent comparison or execution failed",
      properties, evidence, durationMs: relevant.reduce((total, item) => total + item.durationMs, 0),
      comparisons: relevant.flatMap(item => item.checks.map(check => ({ witness: item.name, ...check }))) };
  }).sort((a,b)=>a.index-b.index);
  const [index, count] = shard.split("/").map(Number);
  await save(join(out, "results.json"), { schemaVersion: 1, lot: "q-syntax", platform, architecture: process.arch,
    sourceCommit: candidate.manifest.sourceCommit, candidateManifestSha256: candidate.manifestHash,
    purpose: candidate.manifest.purpose ?? "qualification", shard: { index, count }, durationMs: performance.now() - started,
    technicalErrors: errors, results });
  console.log(JSON.stringify({ obligations: results.length, qualified: results.filter(row=>row.status==="qualified").length,
    technicalErrors: errors.length, out }));
  if (errors.length) process.exitCode = 1;
}

if (import.meta.main) await main().catch(error => { console.error(String(error)); process.exitCode = 1; });
