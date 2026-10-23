import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export type Evidence = { path: string; sha256: string; bytes: number };
export type PropertyResult = { property: string; status: "pass" | "fail" | "not_qualified"; reason: string; evidence?: Evidence[] };
export type ObligationResult = { index: number; id: string; status: "qualified" | "not_qualified"; reason: string; properties: PropertyResult[]; evidence: Evidence[]; durationMs: number };
export type CampaignContext = { producer: string; helper: string; sdk: string; oracle: string; extractionOracle?: string; out: string; platform: "macos" | "linux"; run: (name: string, argv: string[], cwd?: string) => Promise<{ exitCode: number; stdout: string; stderr: string; evidence: Evidence[] }> };
export const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const indices = [12, 13, 14, 15, 16, 20, 21, 22, 23, 24, 25, 26, 27, 44, 45, 46, 47, 167, 171, 172, 173, 174, 175, 192, 193, 194, 195, 196, 198, 199, 200, 201, 202, 203, 204, 205, 210, 211, 212, 213, 223, 224, 225, 226, 227, 228, 239];
const configurationResolution = new Set([23, 24, 25, 26, 27, 44, 45, 46, 47, 198, 199, 200, 201, 202, 203, 204, 205, 223, 224, 225, 226, 227, 228]);
type Artifact = Evidence;
export type PlatformArtifacts = { producer: Artifact; helper: Artifact; observer: Artifact; sdk: Artifact; oracle: Artifact; oracleLibraries: Artifact; extractionOracle?: Artifact };
export type CandidateManifest = { schemaVersion: 1; sourceCommit: string; kind?: "development" | "frozen"; platforms: Partial<Record<"macos" | "linux", PlatformArtifacts>> };
type Options = { candidate: string; platform: "macos" | "linux"; out: string; shard?: string };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function selectIndices(shard?: string): number[] {
  if (shard === undefined) return [...indices];
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(shard)) throw new Error("invalid shard: expected i/n, 1 <= i <= n");
  const [i, n] = shard.split("/").map(Number) as [number, number];
  if (!Number.isSafeInteger(i) || !Number.isSafeInteger(n) || i > n) throw new Error("invalid shard range");
  return indices.filter((_index, ordinal) => ordinal % n === i - 1);
}

export function parseOptions(argv: string[]): Options {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!;
    const value = argv[i + 1];
    if (!["--candidate", "--platform", "--out", "--shard"].includes(key) || !value || value.startsWith("--") || options.has(key)) throw new Error("unknown, duplicate or incomplete option");
    options.set(key, value);
  }
  const candidate = options.get("--candidate");
  const out = options.get("--out");
  const platform = options.get("--platform");
  if (!candidate || !out || (platform !== "macos" && platform !== "linux")) throw new Error("expected --candidate MANIFEST --platform macos|linux --out FRESH_DIRECTORY [--shard i/n]");
  selectIndices(options.get("--shard"));
  return { candidate: resolve(candidate), platform, out: resolve(out), shard: options.get("--shard") };
}

function artifact(value: unknown, name: string): Artifact {
  if (!object(value) || typeof value.path !== "string" || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) || typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 1) throw new Error(`invalid artifact ${name}: require path, sha256, bytes`);
  if (!isAbsolute(value.path)) throw new Error(`artifact path must be absolute: ${name}`);
  return { path: value.path, sha256: value.sha256, bytes: value.bytes };
}

export function parseManifest(value: unknown, platform: "macos" | "linux"): { manifest: CandidateManifest; artifacts: PlatformArtifacts } {
  if (!object(value) || value.schemaVersion !== 1 || typeof value.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(value.sourceCommit) || (value.kind !== undefined && (typeof value.kind !== "string" || !["development", "frozen"].includes(value.kind))) || !object(value.platforms)) throw new Error("invalid candidate manifest identity");
  const cell = value.platforms[platform];
  if (!object(cell)) throw new Error(`missing candidate platform ${platform}`);
  const artifacts = { producer: artifact(cell.producer, "producer"), helper: artifact(cell.helper, "helper"), observer: artifact(cell.observer, "observer"), sdk: artifact(cell.sdk, "sdk"), oracle: artifact(cell.oracle, "oracle"), oracleLibraries: artifact(cell.oracleLibraries, "oracleLibraries"), ...(cell.extractionOracle === undefined ? {} : { extractionOracle: artifact(cell.extractionOracle, "extractionOracle") }) };
  return { manifest: { schemaVersion: 1, sourceCommit: value.sourceCommit, kind: value.kind as "development" | "frozen", platforms: { [platform]: artifacts } }, artifacts };
}

export async function verifyOracleLibraries(artifacts: PlatformArtifacts): Promise<Evidence[]> {
  const value: unknown = JSON.parse(await readFile(artifacts.oracleLibraries.path, "utf8"));
  if (!Array.isArray(value) || value.length !== 115) throw new Error("oracle requires pinned 115-library manifest");
  const libraries = value.map((item: unknown) => {
    if (!object(item) || typeof item.path !== "string" || !/^lib[.a-z0-9-]*\.d\.ts$/.test(item.path)) throw new Error("invalid oracle library path");
    return artifact({ ...item, path: resolve(dirname(artifacts.oracle.path), item.path) }, "oracle library");
  });
  const inventory = libraries.map(item => [item.path.slice(dirname(artifacts.oracle.path).length + 1), item.bytes, item.sha256]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
  if (sha256(JSON.stringify(inventory)) !== "e1520252c61048526e32dfe44874e4d6f541217966baebf34ba3e337d3c385c1") throw new Error("oracle library inventory differs from pinned TS7 revision");
  const evidence: Evidence[] = [];
  for (const expected of libraries) {
    const actual = await fileEvidence(expected.path);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw new Error(`oracle library mismatch: ${expected.path}`);
    evidence.push(actual);
  }
  return evidence;
}

export async function fileEvidence(path: string): Promise<Evidence> {
  const bytes = await readFile(path);
  return { path, sha256: sha256(bytes), bytes: bytes.length };
}

export async function verifyArtifacts(artifacts: PlatformArtifacts): Promise<Evidence[]> {
  const evidence = [];
  for (const [name, expected] of Object.entries(artifacts)) {
    const actual = await fileEvidence(expected.path);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw new Error(`candidate artifact mismatch: ${name}`);
    evidence.push(actual);
  }
  return evidence;
}

export function verifySdk(value: unknown): void {
  if (!object(value) || value.version !== "7.1.0-dev" || !object(value.files)) throw new Error("explicit TS7 SDK descriptor required");
  const libraries = Object.entries(value.files).map(([path, source]) => {
    if (!/^\/sdk\/lib\/lib[.a-z0-9-]*\.d\.ts$/.test(path) || typeof source !== "string") throw new Error("invalid explicit SDK library");
    return [path.slice("/sdk/lib/".length), Buffer.byteLength(source), sha256(source)];
  }).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
  if (libraries.length !== 115 || sha256(JSON.stringify(libraries)) !== "e1520252c61048526e32dfe44874e4d6f541217966baebf34ba3e337d3c385c1") throw new Error("SDK differs from pinned TS7 115-library inventory");
}

export function validateResults(results: ObligationResult[], selected: number[]): void {
  const actual = results.map(row => row.index).sort((a, b) => a - b);
  if (JSON.stringify(actual) !== JSON.stringify([...selected].sort((a, b) => a - b))) throw new Error("campaign obligation census mismatch");
  for (const row of results) {
    if (!row.id || !row.reason || !Number.isFinite(row.durationMs) || row.durationMs < 0 || row.properties.length === 0 || !["qualified", "not_qualified"].includes(row.status)) throw new Error(`invalid result ${row.index}`);
    if (row.properties.some(property => !property.property || !property.reason || !["pass", "fail", "not_qualified"].includes(property.status))) throw new Error(`invalid property ${row.index}`);
    if (row.status === "qualified" && (row.properties.some(property => property.status !== "pass") || row.evidence.length === 0)) throw new Error(`unsupported qualification ${row.index}`);
  }
}

export function createRunner(out: string): CampaignContext["run"] {
  const names = new Set<string>();
  return async (name, argv, cwd) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || names.has(name) || argv.length === 0) throw new Error("invalid or duplicate execution name");
    names.add(name);
    const directory = resolve(out, "processes", name);
    await mkdir(directory, { recursive: true });
    const started = performance.now();
    const environment: NodeJS.ProcessEnv = { ...process.env, GOPORT_LIB_PARSE_SNAPSHOT: "0", GOPORT_LIB_SNAPSHOT: "0" };
    delete environment.GIT_CONFIG_GLOBAL;
    delete environment.GOPORT_BUILD_VERSION;
    const result = Bun.spawnSync(argv, { cwd, env: environment, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, stdout: "pipe", stderr: "pipe" });
    const paths = [resolve(directory, "stdout"), resolve(directory, "stderr"), resolve(directory, "execution.json")];
    await writeFile(paths[0]!, result.stdout);
    await writeFile(paths[1]!, result.stderr);
    await writeFile(paths[2]!, JSON.stringify({ argv, cwd: cwd ?? process.cwd(), exitCode: result.exitCode, signalCode: result.signalCode, durationMs: performance.now() - started, snapshots: false }, null, 2) + "\n");
    if (result.signalCode || result.exitCode < 0) throw new Error(`technical process failure ${name}: ${result.signalCode ?? result.exitCode}; evidence ${directory}`);
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), evidence: await Promise.all(paths.map(fileEvidence)) };
  };
}

async function main(): Promise<void> {
  const started = performance.now();
  const options = parseOptions(process.argv.slice(2));
  if (Bun.version !== "1.4.3" || process.arch !== "arm64" || process.platform !== (options.platform === "macos" ? "darwin" : "linux")) throw new Error("campaign requires native macOS arm64 or Linux aarch64 with Bun 1.4.3");
  const input = await fileEvidence(options.candidate);
  const { manifest, artifacts } = parseManifest(JSON.parse(await readFile(options.candidate, "utf8")) as unknown, options.platform);
  const evidence = await verifyArtifacts(artifacts);
  await verifyOracleLibraries(artifacts);
  verifySdk(JSON.parse(await readFile(artifacts.sdk.path, "utf8")) as unknown);
  const oraclePin = options.platform === "macos" ? "5cbfaf1ebda63e251e3509fdca8c80711f300a7cdc684f3b332e155c7e4cfa62" : "14338f19b9d040c2e148387d72e8118c29a16d744119a0063fb8d13714b8a8dd";
  if (artifacts.oracle.sha256 !== oraclePin) throw new Error("oracle binary differs from pinned independent TS7 build");
  await mkdir(options.out);
  const execute = createRunner(options.out);
  let technicalFailure: unknown;
  const run: CampaignContext["run"] = async (...args) => {
    try { return await execute(...args); }
    catch (error) { technicalFailure ??= error; throw error; }
  };
  const version = await run("oracle-version", [artifacts.oracle.path, "--version"]);
  if (version.exitCode !== 0 || version.stdout.trim() !== "Version 7.1.0-dev") throw new Error("oracle runtime version mismatch");
  const context: CampaignContext = { producer: artifacts.producer.path, helper: artifacts.helper.path, sdk: artifacts.sdk.path, oracle: artifacts.oracle.path, extractionOracle: artifacts.extractionOracle?.path, out: options.out, platform: options.platform, run };
  const selected = selectIndices(options.shard);
  const { runConfigurationResolution } = await import("./t00-ts7-q-config-cr");
  const { runProgramEmissionWorkers } = await import("./t00-ts7-q-config-pew");
  const results = [...await runConfigurationResolution(context, selected.filter(index => configurationResolution.has(index))), ...await runProgramEmissionWorkers(context, selected.filter(index => !configurationResolution.has(index)))].sort((a, b) => a.index - b.index);
  if (technicalFailure !== undefined) throw technicalFailure instanceof Error ? technicalFailure : new Error("non-Error technical process failure");
  validateResults(results, selected);
  await verifyArtifacts(artifacts);
  await verifyOracleLibraries(artifacts);
  const after = await fileEvidence(options.candidate);
  if (after.sha256 !== input.sha256) throw new Error("candidate manifest changed during campaign");
  const evidenceToVerify = new Map<string, Evidence>();
  for (const row of results) {
    row.evidence.push(input, ...evidence, ...version.evidence);
    for (const item of row.evidence) evidenceToVerify.set(item.path, item);
  }
  for (const expected of evidenceToVerify.values()) {
    const actual = await fileEvidence(expected.path);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw new Error(`evidence changed: ${expected.path}`);
  }
  const [shardIndex, shardCount] = (options.shard ?? "1/1").split("/").map(Number);
  const output = { schemaVersion: 1, lot: "q-config", platform: options.platform, sourceCommit: manifest.sourceCommit, candidateManifestSha256: input.sha256, shard: { index: shardIndex!, count: shardCount! }, durationMs: performance.now() - started, kind: manifest.kind ?? "frozen", results: results.map(row => ({ ...row, properties: row.properties.map(property => ({ id: property.property, status: property.status === "pass" ? "passed" : property.status === "fail" ? "failed" : "not_run", reason: property.reason, evidence: property.evidence ?? (property.status === "not_qualified" ? [] : row.evidence) })) })) };
  await writeFile(resolve(options.out, "results.json"), JSON.stringify(output, null, 2) + "\n");
  const summary = { schemaVersion: 1, candidate: manifest, candidateManifest: input, platform: options.platform, arch: process.arch, bun: Bun.version, shard: options.shard ?? "1/1", obligations: results.length, qualified: results.filter(row => row.status === "qualified").length, notQualified: results.filter(row => row.status === "not_qualified").length, finalQualification: false, scope: manifest.kind === "development" ? "development rehearsal only; zero final qualification credit" : "single-platform finite campaign; cross-platform aggregation required", durationMs: performance.now() - started, results: await fileEvidence(resolve(options.out, "results.json")) };
  await writeFile(resolve(options.out, "campaign.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify({ obligations: summary.obligations, qualified: summary.qualified, notQualified: summary.notQualified, durationMs: summary.durationMs, results: summary.results.path }));
}

if (import.meta.main) await main();
