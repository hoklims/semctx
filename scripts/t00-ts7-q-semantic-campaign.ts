import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { semanticWitnessesA, semanticWitnessesAFocal } from "./t00-ts7-q-semantic-witnesses-a";
import { semanticWitnessesB } from "./t00-ts7-q-semantic-witnesses-b";
import { compareReasons, digest, record, selectShard, semanticObservation, verifyArtifact, verifyProducerCompletion } from "./t00-ts7-q-semantic-core";
import type { Artifact, SemanticWitness } from "./t00-ts7-q-semantic-core";

const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;
const save = (path: string, value: unknown): Artifact => {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(path, bytes);
  return { path, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) };
};

function invoke(argv: string[]): { exitCode: number | null; signal: string | null; error: string | null; stdout: string; stderr: string; durationMs: number } {
  const start = performance.now();
  const env: NodeJS.ProcessEnv = { ...process.env, GOPORT_LIB_PARSE_SNAPSHOT: "0", GOPORT_LIB_SNAPSHOT: "0" };
  delete env.GIT_CONFIG_GLOBAL;
  delete env.GOPORT_BUILD_VERSION;
  const result = spawnSync(argv[0]!, argv.slice(1), { env, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  return { exitCode: result.status, signal: result.signal, error: result.error?.message ?? null, stdout: result.stdout?.toString() ?? "", stderr: result.stderr?.toString() ?? "", durationMs: performance.now() - start };
}

function decode(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

function options(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!key || !["--candidate", "--platform", "--out", "--shard"].includes(key) || !value || value.startsWith("--") || result[key] !== undefined) throw Error("INVALID_ARGUMENTS");
    result[key] = value;
  }
  if (!result["--candidate"] || !result["--out"] || !["macos", "linux"].includes(result["--platform"] ?? "")) throw Error("Usage: --candidate MANIFEST --platform macos|linux --out DIR [--shard i/n]");
  return result;
}

function validateSdk(sdkPath: string, inventoryPath: string): void {
  const reference = record(read(resolve(import.meta.dir, "../docs/research/rust-ts-r0/oracle-ts7.json")));
  const trustedInventory = record(record(reference["oracleSdk"])["manifest"]);
  verifyArtifact({ ...trustedInventory, path: inventoryPath });
  const inventory = read(inventoryPath);
  const sdk = record(read(sdkPath)), files = record(sdk["files"]);
  if (sdk["version"] !== "7.1.0-dev" || !Array.isArray(inventory) || inventory.length !== 115 || Object.keys(files).length !== 115) throw Error("SDK_TS7_COMPLETE_REQUIRED");
  for (const value of inventory) {
    const entry = record(value), content = files["/sdk/lib/" + String(entry["path"])];
    if (typeof content !== "string" || digest(content) !== entry["sha256"] || Buffer.byteLength(content) !== entry["bytes"]) throw Error("SDK_LIBRARY_MISMATCH:" + String(entry["path"]));
  }
}

function validateOracleLibraries(oraclePath: string, inventoryPath: string): void {
  const inventory = read(inventoryPath);
  if (!Array.isArray(inventory) || inventory.length !== 115) throw Error("ORACLE_LIBRARIES_INCOMPLETE");
  for (const value of inventory) {
    const entry = record(value), path = entry["path"];
    if (typeof path !== "string" || basename(path) !== path || !/^lib.*\.d\.ts$/.test(path)) throw Error("INVALID_ORACLE_LIBRARY_PATH");
    verifyArtifact({ ...entry, path: resolve(dirname(oraclePath), path) });
  }
}

function observe(witness: SemanticWitness, label: string, files: Record<string, string>, expected: string[] | null, artifacts: Record<string, Artifact>, out: string): { properties: Record<string, unknown>; evidence: Artifact[] } {
  const directory = resolve(out, String(witness.index), basename(witness.id), label);
  const absoluteFiles = Object.fromEntries(Object.entries(files).map(([path, text]) => {
    if (path.startsWith("/") || path.split("/").includes("..")) throw Error("INVALID_WITNESS_PATH:" + path);
    return ["/project/" + path, text];
  }));
  const roots = Object.keys(absoluteFiles).filter(path => /\.[cm]?[jt]sx?$/.test(path)).sort();
  const compilerOptions = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowJs: true, jsx: "Preserve", skipLibCheck: true, noEmit: true, strict: false };
  const request = { id: witness.id + ":" + label, cwd: "/project", sdk_directory: "/sdk/lib", case_sensitive: process.platform !== "darwin", roots, files: absoluteFiles, options: compilerOptions, retained: true, qualified: true, roles: {}, selection: {}, disabled: [], utf16_files: {}, raw_files: {} };
  const evidence = [save(resolve(directory, "producer-request.json"), request), save(resolve(directory, "oracle-request.json"), { files: absoluteFiles, roots })];
  const oracle = invoke([artifacts["semanticOracle"]!.path, evidence[1]!.path, artifacts["sdk"]!.path]);
  const producer = invoke([artifacts["producer"]!.path, evidence[0]!.path, artifacts["sdk"]!.path]);
  evidence.push(save(resolve(directory, "oracle-capture.json"), oracle), save(resolve(directory, "producer-capture.json"), producer));
  if (oracle.error !== null || oracle.signal !== null || oracle.exitCode !== 0) throw Error("ORACLE_EXECUTION_FAILED:" + directory);
  verifyProducerCompletion(producer);
  const oracleValue = record(decode(oracle.stdout)), producerValue = record(decode(producer.stdout));
  if (Object.keys(oracleValue).length === 0 || (producer.exitCode === 0 && Object.keys(producerValue).length === 0)) throw Error("INVALID_PROCESS_JSON:" + directory);
  const observed = semanticObservation(producerValue, witness.path);
  const oracleFiles = Array.isArray(oracleValue["files"]) ? oracleValue["files"] : [];
  const factsPresent = oracleFiles.some(value => { const file = record(value); return file["path"] === "/project/" + witness.path && Array.isArray(file["nodes"]) && file["nodes"].length > 0; });
  return { evidence, properties: {
    oracleProcess: oracle.exitCode === 0 && oracle.error === null,
    oracleIdentity: oracleValue["compilerVersion"] === "7.1.0-dev" && oracleValue["revision"] === "780dc512d64f40afebffa6a7028207649fb7ed1c",
    oracleFactsPresent: factsPresent,
    producerProcess: producer.exitCode === 0 && producer.error === null,
    exactReasons: compareReasons(observed, expected),
    expectedReasons: expected,
    observedReasons: observed["reasons"] ?? null,
    requiredFacts: witness.requiredFacts,
    independentCumulativeProjection: { status: "not_qualified", reason: witness.qualificationGap ?? "TS7 facts are captured; exhaustive API-site and independent Semctx graph/ownership projection has not been established." },
  } };
}

export function campaign(argv: string[]): void {
  const started = performance.now(), args = options(argv), platform = args["--platform"]!;
  if (process.arch !== "arm64" || process.platform !== (platform === "macos" ? "darwin" : "linux")) throw Error("PLATFORM_MISMATCH");
  const manifestPath = resolve(args["--candidate"]!), manifestBytes = readFileSync(manifestPath), manifest = record(decode(manifestBytes.toString()));
  if (manifest["schemaVersion"] !== 1 || typeof manifest["sourceCommit"] !== "string" || !/^[a-f0-9]{40}$/.test(manifest["sourceCommit"])) throw Error("INVALID_CANDIDATE_MANIFEST");
  for (const target of ["macos", "linux"]) {
    const declared = record(record(manifest["platforms"])[target]);
    for (const name of ["producer", "helper", "observer", "sdk", "oracle", "oracleLibraries"]) if (Object.keys(record(declared[name])).length === 0) throw Error("MISSING_PLATFORM_ARTIFACT:" + target + ":" + name);
  }
  const binding = record(record(manifest["platforms"])[platform]);
  const artifacts: Record<string, Artifact> = {};
  for (const name of ["producer", "helper", "observer", "sdk", "oracle", "semanticOracle", "oracleLibraries"]) {
    if (!Number.isSafeInteger(record(binding[name])["bytes"]) || Number(record(binding[name])["bytes"]) < 0) throw Error("ARTIFACT_SIZE_REQUIRED:" + name);
    artifacts[name] = verifyArtifact(binding[name]);
  }
  validateSdk(artifacts["sdk"]!.path, artifacts["oracleLibraries"]!.path);
  validateOracleLibraries(artifacts["oracle"]!.path, artifacts["oracleLibraries"]!.path);
  const reference = record(read(resolve(import.meta.dir, "../docs/research/rust-ts-r0/oracle-ts7.json")));
  const oraclePin = record(record(record(reference["platforms"])[platform === "macos" ? "macosArm64" : "linuxAarch64"])["binary"]);
  if (oraclePin["sha256"] !== artifacts["oracle"]!.sha256) throw Error("UNPINNED_TS7_ORACLE");
  const version = invoke([artifacts["oracle"]!.path, "--version"]);
  if (version.exitCode !== 0 || version.stdout.trim() !== "Version 7.1.0-dev") throw Error("ORACLE_VERSION_MISMATCH");
  const witnesses: SemanticWitness[] = [...semanticWitnessesA, ...semanticWitnessesB];
  if (witnesses.length !== 87 || new Set(witnesses.map(row => row.index)).size !== 87 || witnesses.some(row => row.index < 49 || row.index > 135)) throw Error("OBLIGATION_INVENTORY_INCOMPLETE");
  const inventoryPath = resolve(import.meta.dir, "../docs/research/rust-ts-r0/cases/qualification/obligations.json");
  const inventoryBytes = readFileSync(inventoryPath), inventory = record(decode(inventoryBytes.toString()));
  const obligations = inventory["obligations"];
  if (!Array.isArray(obligations)) throw Error("MISSING_CUMULATIVE_PROPERTY_INVENTORY");
  const inventoryEvidence = { path: inventoryPath, sha256: digest(inventoryBytes), bytes: inventoryBytes.length };
  const selected = selectShard(witnesses, args["--shard"]), out = resolve(args["--out"]!);
  mkdirSync(out, { recursive: false });
  save(resolve(out, "candidate.json"), manifest);
  const results = selected.map(witness => {
    const start = performance.now();
    const scenarios = [witness, ...semanticWitnessesAFocal.filter(row => row.index === witness.index)];
    const properties: { id: string; status: string; reason: string; evidence: Artifact[]; details?: unknown }[] = [], evidence: Artifact[] = [];
    const obligation = record(obligations[witness.index]), cumulative = obligation["cumulative_properties"];
    if (obligation["obligation_id"] !== witness.id || !Array.isArray(cumulative) || cumulative.length === 0) throw Error("INVALID_CUMULATIVE_PROPERTIES:" + String(witness.index));
    for (const value of cumulative) {
      const property = record(value);
      if (typeof property["property"] !== "string") throw Error("INVALID_CUMULATIVE_PROPERTY_NAME");
      properties.push({ id: property["property"], status: "not_run", reason: witness.qualificationGap ?? "Cumulative contract property remains unqualified against TS7.", evidence: [inventoryEvidence], details: property });
    }
    for (const scenario of scenarios) {
      for (const label of ["activate", "control"] as const) {
        const result = observe(scenario, label, label === "activate" ? scenario.files : scenario.controlFiles, label === "activate" ? scenario.expectedReasons : scenario.controlExpectedReasons, artifacts, out);
        for (const key of ["oracleProcess", "oracleIdentity", "oracleFactsPresent", "producerProcess", "exactReasons"]) {
          const status = key === "exactReasons" && result.properties["expectedReasons"] === null ? "not_run" : result.properties[key] === true ? "passed" : "failed";
          properties.push({ id: scenario.id + ":" + label + ":" + key, status, reason: key === "exactReasons" ? "Complete Semctx reason-array comparison against the authored focal policy expectation; compiler predicate projection remains separate." : "Fresh isolated process observation: " + key, evidence: result.evidence, details: result.properties });
        }
        properties.push({ id: scenario.id + ":" + label + ":independentCumulativeProjection", status: "not_run", reason: scenario.qualificationGap ?? "Exhaustive TS7 API-site and independent Semctx graph/ownership projection remains unestablished.", evidence: result.evidence, details: { requiredFacts: scenario.requiredFacts } });
        for (const fact of scenario.requiredFacts) properties.push({ id: scenario.id + ":" + label + ":compilerPredicate:" + fact, status: "not_run", reason: "Raw TS7 facts are captured separately; this required consumer predicate has no complete independent comparison yet.", evidence: result.evidence });
        evidence.push(...result.evidence);
      }
    }
    return { index: witness.index, id: witness.id, status: "not_qualified", reason: witness.qualificationGap ?? "Independent cumulative projection and all required API-site coverage remain unestablished.", contractSource: witness.contractSource, properties, evidence, durationMs: performance.now() - start };
  });
  for (const artifact of Object.values(artifacts)) verifyArtifact(artifact);
  validateOracleLibraries(artifacts["oracle"]!.path, artifacts["oracleLibraries"]!.path);
  if (digest(readFileSync(manifestPath)) !== digest(manifestBytes)) throw Error("CANDIDATE_CHANGED_DURING_RUN");
  const [shardIndex, shardCount] = (args["--shard"] ?? "1/1").split("/").map(Number);
  const summary = { schemaVersion: 1, lot: "q-semantic", mode: manifest["mode"] ?? "qualification", finalQualificationEvidence: false, sourceCommit: manifest["sourceCommit"], candidateManifestSha256: digest(manifestBytes), platform, architecture: process.arch, bun: Bun.version, shard: { index: shardIndex, count: shardCount }, obligations: results.length, qualified: 0, notQualified: results.length, durationMs: performance.now() - started, artifacts, cumulativePropertyInventory: inventoryEvidence };
  save(resolve(out, "results.json"), { ...summary, results });
  save(resolve(out, "summary.json"), summary);
  process.stdout.write(JSON.stringify(summary) + "\n");
}

if (import.meta.main) campaign(process.argv.slice(2));
