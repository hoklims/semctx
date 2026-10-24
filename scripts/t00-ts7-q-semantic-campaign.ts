import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { semanticWitnessesA, semanticWitnessesAFocal } from "./t00-ts7-q-semantic-witnesses-a";
import { semanticWitnessesB } from "./t00-ts7-q-semantic-witnesses-b";
import { operatorWitnesses, projectOperators } from "./t00-ts7-q-semantic-operators";
import { closeProjection } from "./t00-ts7-q-semantic-projection";
import { projectRuntimeReasons } from "./t00-ts7-q-semantic-runtime-projection";
import type { ProjectionRun } from "./t00-ts7-q-semantic-projection";
import { compareReasons, digest, record, selectIndices, selectShard, semanticObservation, verifyArtifact, verifyProducerCompletion } from "./t00-ts7-q-semantic-core";
import type { Artifact, SemanticWitness } from "./t00-ts7-q-semantic-core";
import { contractProjectionInventory, projectContract } from "./t00-ts7-q-semantic-contract-projector";
import { closeContractProjection } from "./t00-ts7-q-semantic-contract-closure";
import type { ContractClosureRun } from "./t00-ts7-q-semantic-contract-closure";
import { resolveContractQueries } from "./t00-ts7-q-semantic-contract-queries";
import { contractWitnesses, contractWitnessLimitations, verifyContractWitness } from "./t00-ts7-q-semantic-contract-witnesses";
import type { ContractWitness } from "./t00-ts7-q-semantic-contract-witnesses";
import { compareContractOwnership, projectContractOwnership } from "./t00-ts7-q-semantic-contract-ownership";
import type { OwnershipProjection } from "./t00-ts7-q-semantic-contract-ownership";

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
    if (!key || !["--candidate", "--platform", "--out", "--shard", "--indices"].includes(key) || !value || value.startsWith("--") || result[key] !== undefined) throw Error("INVALID_ARGUMENTS");
    result[key] = value;
  }
  if (!result["--candidate"] || !result["--out"] || !["macos", "linux"].includes(result["--platform"] ?? "")) throw Error("Usage: --candidate MANIFEST --platform macos|linux --out DIR [--shard i/n] [--indices first-last]");
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

function observe(witness: SemanticWitness, label: "activate" | "control", files: Record<string, string>, expected: string[] | null, artifacts: Record<string, Artifact>, out: string, contractWitness?: ContractWitness): { properties: Record<string, unknown>; evidence: Artifact[]; projection: ProjectionRun | null; contractRun: ContractClosureRun | null } {
  const directory = resolve(out, String(witness.index), basename(witness.id), label);
  const absoluteFiles = Object.fromEntries(Object.entries(files).map(([path, text]) => {
    if (path.startsWith("/") || path.split("/").includes("..")) throw Error("INVALID_WITNESS_PATH:" + path);
    return ["/project/" + path, text];
  }));
  const roots = Object.keys(absoluteFiles).filter(path => /\.[cm]?[jt]sx?$/.test(path)).sort();
  const compilerOptions = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowJs: true, jsx: "Preserve", skipLibCheck: true, noEmit: true, strict: false };
  const request = { id: witness.id + ":" + label, cwd: "/project", sdk_directory: "/sdk/lib", case_sensitive: process.platform !== "darwin", roots, files: absoluteFiles, options: compilerOptions, retained: true, qualified: true, roles: {}, selection: {}, disabled: [], utf16_files: {}, raw_files: {} };
  const evidence = [save(resolve(directory, "producer-request.json"), request), save(resolve(directory, "oracle-request.json"), { files: absoluteFiles, roots })];
  let oracle = invoke([artifacts["semanticOracle"]!.path, evidence[1]!.path, artifacts["sdk"]!.path]);
  const producer = invoke([artifacts["producer"]!.path, evidence[0]!.path, artifacts["sdk"]!.path]);
  evidence.push(save(resolve(directory, "oracle-capture.json"), oracle), save(resolve(directory, "producer-capture.json"), producer));
  if (oracle.error !== null || oracle.signal !== null || oracle.exitCode !== 0) throw Error("ORACLE_EXECUTION_FAILED:" + directory);
  verifyProducerCompletion(producer);
  let oracleValue = record(decode(oracle.stdout));
  const producerValue = record(decode(producer.stdout));
  if (Object.keys(oracleValue).length === 0 || (producer.exitCode === 0 && Object.keys(producerValue).length === 0)) throw Error("INVALID_PROCESS_JSON:" + directory);
  if (contractWitness !== undefined && (oracleValue["compilerVersion"] !== "7.1.0-dev" || oracleValue["revision"] !== "780dc512d64f40afebffa6a7028207649fb7ed1c")) throw Error("ORACLE_IDENTITY_MISMATCH:" + directory);
  const observed = semanticObservation(producerValue, witness.path);
  const ownershipState: { projection: OwnershipProjection | null } = { projection: null };
  const contractObservation = contractWitness === undefined ? null : resolveContractQueries(oracleValue, value => {
    ownershipState.projection = null;
    const projected = projectContract(value, "/project/" + witness.path, files);
    if (!projected.gaps.includes("CONTRACT_EXTERNAL_UNAVAILABLE:ownership")) return projected;
    const ownership = projectContractOwnership(value, witness.path, files);
    ownershipState.projection = ownership;
    return ownership.status === "projected" ? projectContract(value, "/project/" + witness.path, files, ownership.proof)
      : { ...projected, gaps: ownership.gaps, ...(ownership.queries === undefined ? {} : { queries: ownership.queries }) };
  }, (factQueries, round) => {
    const nativeRequest = save(resolve(directory, `native-round-${round}`, "oracle-request.json"), { files: absoluteFiles, roots, factQueries });
    oracle = invoke([artifacts["semanticOracle"]!.path, nativeRequest.path, artifacts["sdk"]!.path]);
    evidence.push(nativeRequest, save(resolve(directory, `native-round-${round}`, "oracle-capture.json"), oracle));
    if (oracle.error !== null || oracle.signal !== null || oracle.exitCode !== 0) throw Error("ORACLE_EXECUTION_FAILED:" + nativeRequest.path);
    const value = record(decode(oracle.stdout));
    if (value["compilerVersion"] !== "7.1.0-dev" || value["revision"] !== "780dc512d64f40afebffa6a7028207649fb7ed1c") throw Error("ORACLE_IDENTITY_MISMATCH:" + nativeRequest.path);
    return value;
  });
  if (contractObservation !== null) oracleValue = record(contractObservation.oracle);
  const contractProjection = contractObservation?.projection;
  const contractVerification = contractWitness === undefined || contractProjection === undefined ? null : verifyContractWitness(oracleValue, contractProjection, contractWitness, label, witness.path);
  const oracleFiles = Array.isArray(oracleValue["files"]) ? oracleValue["files"] : [];
  const factsPresent = oracleFiles.some(value => { const file = record(value); return file["path"] === "/project/" + witness.path && Array.isArray(file["nodes"]) && file["nodes"].length > 0; });
  const projected = [61, 97, 102].includes(witness.index) ? projectOperators(oracleValue, "/project/" + witness.path) : null;
  const runtime = [68, 74, 82, 89, 135].includes(witness.index) ? projectRuntimeReasons(oracleValue, "/project/" + witness.path) : null;
  const projectedReasons = contractProjection !== undefined ? contractProjection.status === "projected" ? contractProjection.reasons : null : projected?.status === "projected" ? projected.reasons : runtime?.reasons ?? expected;
  const exactReasons = compareReasons(observed, projectedReasons);
  const exactOwnership = ownershipState.projection === null ? null : ownershipState.projection.status === "projected" ? compareContractOwnership(producerValue, ownershipState.projection) : null;
  const matrixWitness = operatorWitnesses.find(row => row.index === witness.index && witness.id.endsWith(":" + row.idSuffix));
  const expectedOperator = label === "activate" ? matrixWitness?.expectedOperator : matrixWitness?.controlOperator;
  const expectedKind = label === "activate" ? matrixWitness?.expectedKind : matrixWitness?.controlKind;
  const expectedActivation = label === "activate" ? matrixWitness?.activationReasons : matrixWitness?.controlReasons;
  const witnessActivated = projected !== null && projected.operators?.length === 1
    && projected.operators[0]?.operator === expectedOperator && projected.operators[0]?.kind === expectedKind
    && JSON.stringify(projected.reasons) === JSON.stringify(expectedActivation);
  const processVerified = oracle.exitCode === 0 && producer.exitCode === 0 && factsPresent
    && oracleValue["compilerVersion"] === "7.1.0-dev" && oracleValue["revision"] === "780dc512d64f40afebffa6a7028207649fb7ed1c";
  const projection: ProjectionRun | null = projected === null ? null : {
    scenario: witness.id, label: label as "activate" | "control", projected: projected.status === "projected" && witnessActivated, exactReasons, processVerified,
    predicateMatched: witness.index === 61 ? projected.operators?.[0]?.coercingBinary === true : witness.index === 97 ? projected.operators?.[0]?.numericUnary === true : projected.operators?.[0]?.propertyMembership === true,
    ...(projected.operators?.[0]?.leftPrimitive !== undefined && projected.operators[0].rightPrimitive !== undefined ? { operands: { leftPrimitive: projected.operators[0].leftPrimitive, rightPrimitive: projected.operators[0].rightPrimitive } } : {}),
    sites: projected.sites.filter(site => site.index === witness.index), gaps: [...projected.gaps, ...(witnessActivated ? [] : ["Declared operator alternative was not observed in the native projection"])],
  };
  if (projected !== null) evidence.push(save(resolve(directory, "independent-projection.json"), projected));
  if (runtime !== null) evidence.push(save(resolve(directory, "independent-runtime-projection.json"), runtime));
  const contractRun: ContractClosureRun | null = contractProjection === undefined ? null : {
    scenario: witness.id, label, projected: contractProjection.status === "projected", exactReasons: exactReasons && exactOwnership !== false, processVerified,
    witnessVerified: contractVerification?.passed === true, gaps: [...contractProjection.gaps, ...(contractVerification?.gaps ?? []), ...(exactOwnership === false ? ["OWNERSHIP_GRAPH_COMPARISON_FAILED"] : [])],
    sites: contractProjection.sites, branches: contractProjection.branches,
  };
  if (contractProjection !== undefined) evidence.push(save(resolve(directory, "independent-contract-projection.json"), { ...contractProjection, rounds: contractObservation?.rounds, witnessVerification: contractVerification }));
  if (ownershipState.projection !== null) evidence.push(save(resolve(directory, "independent-ownership-projection.json"), { ...ownershipState.projection, exactOwnership, ...(ownershipState.projection.status === "projected" ? { callbacks: [...ownershipState.projection.proof.callbacks] } : {}) }));
  return { evidence, projection, contractRun, properties: {
    oracleProcess: oracle.exitCode === 0 && oracle.error === null,
    oracleIdentity: oracleValue["compilerVersion"] === "7.1.0-dev" && oracleValue["revision"] === "780dc512d64f40afebffa6a7028207649fb7ed1c",
    oracleFactsPresent: factsPresent,
    producerProcess: producer.exitCode === 0 && producer.error === null,
    exactReasons,
    exactOwnership,
    expectedReasons: projectedReasons,
    independentReasons: contractProjection?.status === "projected" || projected?.status === "projected" || (runtime !== null && runtime.reasons !== null),
    observedReasons: observed["reasons"] ?? null,
    requiredFacts: witness.requiredFacts,
    independentCumulativeProjection: { status: "not_qualified", reason: witness.qualificationGap ?? "TS7 facts are captured; exhaustive API-site and independent Semctx graph/ownership projection has not been established." },
  } };
}

export function loadCandidateArtifacts(path: string, platform: "macos" | "linux") {
  const manifestPath = resolve(path), manifestBytes = readFileSync(manifestPath), manifest = record(decode(manifestBytes.toString()));
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
  return { manifestPath, manifestBytes, manifest, artifacts };
}

export function campaign(argv: string[]): void {
  const started = performance.now(), args = options(argv), platform = args["--platform"]!;
  if (process.arch !== "arm64" || process.platform !== (platform === "macos" ? "darwin" : "linux")) throw Error("PLATFORM_MISMATCH");
  const { manifestPath, manifestBytes, manifest, artifacts } = loadCandidateArtifacts(args["--candidate"]!, platform as "macos" | "linux");
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
  const contractPath = resolve(import.meta.dir, "../docs/research/rust-ts-r0/qualification/suite-20261022/consumer-contracts.json");
  const contractBytes = readFileSync(contractPath), contracts = record(decode(contractBytes.toString()))["rows"];
  if (!Array.isArray(contracts)) throw Error("MISSING_CONSUMER_CONTRACTS");
  const contractEvidence = { path: contractPath, sha256: digest(contractBytes), bytes: contractBytes.length };
  const selected = selectShard(selectIndices(witnesses, args["--indices"]), args["--shard"]), out = resolve(args["--out"]!);
  mkdirSync(out, { recursive: false });
  save(resolve(out, "candidate.json"), manifest);
  const results = selected.map(witness => {
    const start = performance.now();
    const matrix = operatorWitnesses.filter(row => row.index === witness.index);
    const contractMatrix = witness.index === 52 ? contractWitnesses.filter(row => row.index === witness.index) : [];
    const projectedMatrix = [...matrix, ...contractMatrix];
    const scenarios: SemanticWitness[] = projectedMatrix.length === 0 ? [witness, ...semanticWitnessesAFocal.filter(row => row.index === witness.index)] : projectedMatrix.map(row => ({
      ...witness, id: witness.id + ":" + row.idSuffix, files: row.files, controlFiles: row.controlFiles,
      path: "path" in row && typeof row.path === "string" ? row.path : witness.path,
      expectedReasons: null, controlExpectedReasons: null,
    }));
    const projectionRuns: ProjectionRun[] = [];
    const contractRuns: ContractClosureRun[] = [];
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
        const contractWitness = contractMatrix.find(row => scenario.id === witness.id + ":" + row.idSuffix);
        const result = observe(scenario, label, label === "activate" ? scenario.files : scenario.controlFiles, label === "activate" ? scenario.expectedReasons : scenario.controlExpectedReasons, artifacts, out, contractWitness);
        if (result.projection !== null) projectionRuns.push(result.projection);
        if (result.contractRun !== null) contractRuns.push(result.contractRun);
        for (const key of ["oracleProcess", "oracleIdentity", "oracleFactsPresent", "producerProcess", "exactReasons"]) {
          const status = key === "exactReasons" && result.properties["expectedReasons"] === null ? "not_run" : result.properties[key] === true ? "passed" : "failed";
          properties.push({ id: scenario.id + ":" + label + ":" + key, status, reason: key === "exactReasons" ? (result.properties["independentReasons"] === true ? "Complete reason-array comparison against independent TS7 facts projected from the consumer contract." : "Complete Semctx reason-array comparison against the authored focal policy expectation; compiler predicate projection remains separate.") : "Fresh isolated process observation: " + key, evidence: result.evidence, details: result.properties });
        }
        if (result.properties["exactOwnership"] !== null) properties.push({ id: scenario.id + ":" + label + ":exactOwnership", status: result.properties["exactOwnership"] === true ? "passed" : "failed", reason: "Retained owner and target coordinates, calls edges and evidence lines compared to an independent native-source graph projection.", evidence: result.evidence });
        const completeProjection = result.projection?.projected === true || (result.contractRun?.projected === true && result.contractRun.witnessVerified);
        properties.push({ id: scenario.id + ":" + label + ":independentCumulativeProjection", status: completeProjection ? "passed" : "not_run", reason: completeProjection ? "Independent reason projection and native witness conditions executed; cumulative site and alternative closure assessed separately." : scenario.qualificationGap ?? "Exhaustive TS7 API-site and independent Semctx graph/ownership projection remains unestablished.", evidence: result.evidence, details: result.contractRun ?? result.projection ?? { requiredFacts: scenario.requiredFacts } });
        if (projectedMatrix.length === 0) for (const fact of scenario.requiredFacts) properties.push({ id: scenario.id + ":" + label + ":compilerPredicate:" + fact, status: "not_run", reason: "Raw TS7 facts are captured separately; this required consumer predicate has no complete independent comparison yet.", evidence: result.evidence });
        evidence.push(...result.evidence);
      }
    }
    const contract = record(contracts[witness.index]);
    if (contract["id"] !== witness.id) throw Error("CONSUMER_CONTRACT_ID_MISMATCH");
    const apiSites = record(contract["source"])["apiSites"];
    if (!Array.isArray(apiSites) || apiSites.some(site => typeof record(site)["expression"] !== "string")) throw Error("MISSING_API_SITES");
    const closure = contractMatrix.length > 0
      ? closeContractProjection(witness.index, apiSites.map((site, position) => ({ index: witness.index, site: `${witness.index}:${position}`, expression: String(record(site)["expression"]) })), contractProjectionInventory(), scenarios.map(scenario => scenario.id), contractRuns, contractWitnessLimitations.filter(limitation => limitation.index === witness.index))
      : closeProjection(witness.index, apiSites.map(site => String(record(site)["expression"])), matrix.length === 0 ? [] : scenarios.map(scenario => scenario.id), projectionRuns);
    const closureEvidence = save(resolve(out, String(witness.index), "site-closure.json"), closure);
    evidence.push(contractEvidence, closureEvidence);
    if (projectedMatrix.length > 0) {
      for (const property of properties.slice(0, cumulative.length)) {
        property.status = closure.status;
        property.reason = closure.status === "passed" ? "Every declared native witness, consumer API site and contract alternative has fresh independent comparisons." : closure.gaps.join("; ") || "Independent reason comparison failed";
        property.evidence = [inventoryEvidence, contractEvidence, closureEvidence, ...evidence];
      }
    }
    const qualified = projectedMatrix.length > 0 && properties.every(property => property.status === "passed");
    return { index: witness.index, id: witness.id, status: qualified ? "qualified" : "not_qualified", reason: qualified ? "Consumer contract projected independently from TS7 facts, all declared alternatives and API sites compared." : closure.gaps.join("; ") || witness.qualificationGap || "Independent cumulative projection remains unestablished.", contractSource: witness.contractSource, properties, evidence, durationMs: performance.now() - start };
  });
  for (const artifact of Object.values(artifacts)) verifyArtifact(artifact);
  validateOracleLibraries(artifacts["oracle"]!.path, artifacts["oracleLibraries"]!.path);
  if (digest(readFileSync(manifestPath)) !== digest(manifestBytes)) throw Error("CANDIDATE_CHANGED_DURING_RUN");
  const [shardIndex, shardCount] = (args["--shard"] ?? "1/1").split("/").map(Number);
  const summary = { schemaVersion: 1, lot: "q-semantic", mode: manifest["mode"] ?? "qualification", finalQualificationEvidence: false, sourceCommit: manifest["sourceCommit"], candidateManifestSha256: digest(manifestBytes), platform, architecture: process.arch, bun: Bun.version, shard: { index: shardIndex, count: shardCount }, obligations: results.length, qualified: results.filter(result => result.status === "qualified").length, notQualified: results.filter(result => result.status !== "qualified").length, durationMs: performance.now() - started, artifacts, cumulativePropertyInventory: inventoryEvidence };
  save(resolve(out, "results.json"), { ...summary, results });
  save(resolve(out, "summary.json"), summary);
  process.stdout.write(JSON.stringify(summary) + "\n");
}

if (import.meta.main) campaign(process.argv.slice(2));
