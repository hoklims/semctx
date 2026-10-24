import { file, spawn, version } from "bun";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, readdir, lstat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const reject = () => { throw new Error("HOLDOUT_FORMAT_NONCONFORMING"); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0;
const keys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const target = value => Array.isArray(value) && value.length > 0 && value.every(part => text(part) || Number.isSafeInteger(part) && part >= 0 || keys(part, ["path"]) && text(part.path));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

export function parseNativeHoldout(input, receipt) {
  if (!keys(input, ["schema_version", "oracle", "units"]) || input.schema_version !== 1 || !keys(input.oracle, ["typescript_version", "baseline"], ["sourceIdentities", "inputs_sha256"]) || input.oracle.typescript_version !== "5.9.3" || input.oracle.baseline !== receipt.baseline || !Array.isArray(input.units) || input.units.length !== receipt.counts.totalVariants) reject();
  const ids = new Set();
  const families = new Map(receipt.counts.byPrimaryFamily.map(row => [row.family, 0]));
  for (const unit of input.units) {
    if (!keys(unit, ["unit_id", "primary_family", "surface", "checks", "gaps"], ["requests", "primitive_requests", "relations", "physical_live_after_capture", "independent_input_origin", "obligation_indices", "oracle_full_value", "oracle_full_values"]) || !text(unit.unit_id) || ids.has(unit.unit_id) || !families.has(unit.primary_family) || !Array.isArray(unit.gaps) || unit.gaps.length !== 0) reject();
    ids.add(unit.unit_id);
    families.set(unit.primary_family, families.get(unit.primary_family) + 1);
    const requestField = unit.surface === "raw_cli" ? "requests" : unit.surface === "primitive_cli" ? "primitive_requests" : undefined;
    if (!requestField || !Array.isArray(unit[requestField]) || unit[requestField].length < 1 || unit[requestField].length > 2 || Object.hasOwn(unit, requestField === "requests" ? "primitive_requests" : "requests")) reject();
    if (unit.physical_live_after_capture !== undefined && (!object(unit.physical_live_after_capture) || Object.keys(unit.physical_live_after_capture).length !== 0)) reject();
    for (const request of unit[requestField]) {
      if (!object(request)) reject();
      if (requestField === "primitive_requests" ? !text(request.operation) : !text(request.id) || !text(request.sdk_directory) || !object(request.files) || Object.keys(request.files).length === 0 || !Object.values(request.files).every(value => typeof value === "string") || !Array.isArray(request.roots) || request.roots.length === 0 || !request.roots.every(text) || !object(request.options)) reject();
    }
    if (!Array.isArray(unit.checks) || unit.checks.length === 0) reject();
    for (const check of unit.checks) {
      if (!keys(check, ["target", "mode", "expected", "expected_origin", "actual_transform"], ["observation", "operation_binding"]) || !target(check.target) || check.mode !== "eq" || check.expected_origin !== "typescript-5.9.3" || !["none", "outline_without_digest_bytes", "baseline_raw_extraction"].includes(check.actual_transform) || !Number.isSafeInteger(check.observation ?? 0) || (check.observation ?? 0) < 0 || (check.observation ?? 0) >= unit[requestField].length) reject();
    }
    if (unit.relations !== undefined) {
      if (!Array.isArray(unit.relations)) reject();
      for (const relation of unit.relations) {
        if (!keys(relation, ["left_observation", "right_observation", "target", "transform", "expected_equal"], ["origin"]) || !target(relation.target) || relation.transform !== "none" || typeof relation.expected_equal !== "boolean" || ![relation.left_observation, relation.right_observation].every(index => Number.isSafeInteger(index) && index >= 0 && index < unit[requestField].length)) reject();
      }
    }
  }
  if (!receipt.counts.byPrimaryFamily.every(row => families.get(row.family) === row.variants)) reject();
  return input;
}

export function publicHoldoutAggregate(receipt, state, results = []) {
  const families = receipt.counts.byPrimaryFamily.map(row => {
    const reported = results.filter(result => result.family === row.family);
    return { family: row.family, total: row.variants, pass: reported.filter(result => result.pass === true && result.compared === true).length, formatFailure: state === "FORMAT_NONCONFORMING" ? row.variants : 0, reported: reported.length, compared: reported.filter(result => result.compared === true).length, executionUnavailable: state === "EXECUTION_UNAVAILABLE" ? row.variants : 0 };
  });
  return { schemaVersion: 1, state, variantsTotal: receipt.counts.totalVariants, variantsPass: families.reduce((sum, row) => sum + row.pass, 0), variantsFormatFailure: state === "FORMAT_NONCONFORMING" ? receipt.counts.totalVariants : 0, variantsReported: results.length, variantsCompared: families.reduce((sum, row) => sum + row.compared, 0), variantsExecutionUnavailable: state === "EXECUTION_UNAVAILABLE" ? receipt.counts.totalVariants : 0, byPrimaryFamily: families, arbitrationCredit: 0, formalR0ObligationQualified: false };
}

export function jointHoldoutAggregate(receipt, left, right) {
  const unavailable = () => publicHoldoutAggregate(receipt, "EXECUTION_UNAVAILABLE");
  const fields = ["candidateSourceCommit", "candidateFreezeSha256", "contractSha256", "frozenRunnerSha256", "publicReceiptSha256", "inputCommitmentSha256"];
  if (left?.aggregate?.platform !== "macos" || right?.aggregate?.platform !== "linux" || !fields.every(key => text(left.aggregate[key]) && left.aggregate[key] === right.aggregate[key]) || left.aggregate.inputCommitmentSha256 !== receipt.privateCommitments.expectationsSha256) return unavailable();
  if (left.aggregate.state === "FORMAT_NONCONFORMING" && right.aggregate.state === "FORMAT_NONCONFORMING") return publicHoldoutAggregate(receipt, "FORMAT_NONCONFORMING");
  if (![left, right].every(record => record.aggregate.state === "REPORTED" && Array.isArray(record.units) && record.units.length === receipt.counts.totalVariants)) return unavailable();
  const ids = new Set();
  const families = new Map(receipt.counts.byPrimaryFamily.map(row => [row.family, 0]));
  const results = [];
  for (let index = 0; index < left.units.length; index++) {
    const a = left.units[index];
    const b = right.units[index];
    if (!text(a.unitId) || ids.has(a.unitId) || a.unitId !== b.unitId || !families.has(a.family) || a.family !== b.family || ![a, b].every(row => typeof row.pass === "boolean" && typeof row.compared === "boolean" && (!row.pass || row.compared))) return unavailable();
    ids.add(a.unitId);
    families.set(a.family, families.get(a.family) + 1);
    results.push({ family: a.family, pass: a.pass && b.pass, compared: a.compared && b.compared });
  }
  if (!receipt.counts.byPrimaryFamily.every(row => families.get(row.family) === row.variants)) return unavailable();
  return publicHoldoutAggregate(receipt, "REPORTED", results);
}

function comparisonCompleted(result, unit) {
  const known = row => ["PASS_PROJECTED_PROPERTY", "MISMATCH"].includes(row?.result?.state);
  return Array.isArray(result.checks) && result.checks.length === unit.checks.length && result.checks.every((row, index) => known(row) && isDeepStrictEqual(row.target, unit.checks[index].target) && (row.observation ?? 0) === (unit.checks[index].observation ?? 0)) && Array.isArray(result.relations) && result.relations.length === (unit.relations ?? []).length && result.relations.every(known);
}

async function sealPrivateTree(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new Error("UNEXPECTED_PRIVATE_OUTPUT_KIND");
  await chmod(path, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) for (const name of await readdir(path)) await sealPrivateTree(resolve(path, name));
}

async function exactFile(path, expected) {
  const bytes = await readFile(path);
  if (sha(bytes) !== expected) throw new Error("FROZEN_IDENTITY_MISMATCH");
  return bytes;
}

async function invokeObserver(command, environment, cwd, stdoutPath, stderrPath) {
  await writeFile(stdoutPath, "", { mode: 0o600, flag: "wx" });
  await writeFile(stderrPath, "", { mode: 0o600, flag: "wx" });
  const process = spawn(command, { env: environment, cwd, stdout: file(stdoutPath), stderr: file(stderrPath), timeout: 1_200_000, killSignal: "SIGKILL" });
  return await process.exited;
}

export async function runFrozenHoldout(options, invoke = invokeObserver) {
  const { inputPath, outputDirectory, receiptPath, freezePath, platform } = options;
  const repository = await realpath(fileURLToPath(new URL("../../../", import.meta.url)));
  const inside = path => path === repository || path.startsWith(repository + sep);
  const outputParent = await realpath(dirname(resolve(outputDirectory)));
  if ([resolve(inputPath), await realpath(inputPath), resolve(outputDirectory), resolve(outputParent, basename(outputDirectory))].some(inside)) throw new Error("PRIVATE_DATA_IN_REPOSITORY_REFUSED");
  const freezeBytes = await readFile(freezePath);
  const freeze = JSON.parse(freezeBytes.toString());
  if (version !== "1.4.3") throw new Error("FROZEN_RUNTIME_MISMATCH");
  await exactFile(process.execPath, freeze.runtimeSha256[platform]);
  await exactFile(fileURLToPath(import.meta.url), freeze.runnerSha256);
  await exactFile(freeze.contractPath, freeze.contractSha256);
  const receiptBytes = await exactFile(receiptPath, freeze.receiptSha256);
  const receipt = JSON.parse(receiptBytes.toString());
  const candidateBytes = await exactFile(freeze.candidateFreezePath, freeze.candidateFreezeSha256);
  const candidate = JSON.parse(candidateBytes.toString());
  const lane = candidate.lanes[platform]?.manifest;
  if (!lane || candidate.sourceCommit !== freeze.candidateSourceCommit || !["macos", "linux"].includes(platform)) throw new Error("FROZEN_CANDIDATE_UNAVAILABLE");
  const identities = ["artifact", "helper", "transport_fixture", "qualification_observer", "sdk"].map(name => [lane[name + "_path"], lane[name + "_sha256"]]);
  identities.push([freeze.platformFreezePaths[platform], candidate.lanes[platform].freezeSha256]);
  for (const [path, hash] of identities) await exactFile(path, hash);
  if (!isDeepStrictEqual(JSON.parse((await readFile(freeze.platformFreezePaths[platform])).toString()), lane)) throw new Error("FROZEN_MANIFEST_INCOHERENT");
  const inputBytes = await exactFile(inputPath, receipt.privateCommitments.expectationsSha256);
  await mkdir(outputDirectory, { mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  const privateWrite = async (name, value) => {
    await writeFile(resolve(outputDirectory, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  };
  const startedUtc = new Date().toISOString();
  let manifest;
  let aggregate;
  let processExit = null;
  let observerProcessInvocations = 0;
  let variantResults = [];
  try {
    manifest = parseNativeHoldout(JSON.parse(inputBytes.toString()), receipt);
  } catch (error) {
    aggregate = publicHoldoutAggregate(receipt, "FORMAT_NONCONFORMING");
    await privateWrite("input-failure.json", { error: String(error) });
  }
  if (manifest) {
    const observerManifest = resolve(outputDirectory, "observer-input.json");
    await writeFile(observerManifest, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
    const evidenceDirectory = resolve(outputDirectory, "native-evidence");
    const command = [lane.qualification_observer_path, "suite_replay::suite_phase_a_replay_requires_frozen_manifest", "--exact", "--nocapture"];
    const environment = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GOPORT_LIB_PARSE_SNAPSHOT: "0", GOPORT_LIB_SNAPSHOT: "0", RUST_TEST_THREADS: "1", SEMCTX_PROCESS_HELPER: lane.helper_path, SEMCTX_SUITE_MANIFEST: observerManifest, SEMCTX_SUITE_SHA256: sha(await readFile(observerManifest)), SEMCTX_QUALIFICATION_FREEZE_MANIFEST: freeze.platformFreezePaths[platform], SEMCTX_SUITE_EVIDENCE: evidenceDirectory };
    await privateWrite("invocation.json", { command, environment, inputSha256: sha(await readFile(inputPath)) });
    try {
      processExit = await invoke(command, environment, outputDirectory, resolve(outputDirectory, "observer-stdout.log"), resolve(outputDirectory, "observer-stderr.log"));
      observerProcessInvocations = 1;
      const report = JSON.parse(await readFile(resolve(evidenceDirectory, "report.json"), "utf8"));
      if (report.artifact_sha256 !== lane.artifact_sha256 || report.helper_sha256 !== lane.helper_sha256 || report.manifest_sha256 !== environment.SEMCTX_SUITE_SHA256 || !Array.isArray(report.units) || report.units.length !== manifest.units.length || !report.units.every((row, index) => row.unit_id === manifest.units[index].unit_id && typeof row.result?.pass === "boolean") || ![0, 101].includes(processExit) || (processExit === 0) !== report.units.every(row => row.result.pass)) throw new Error("NATIVE_REPORT_UNBOUND_OR_INCOMPLETE");
      const results = report.units.map((row, index) => ({ unitId: manifest.units[index].unit_id, family: manifest.units[index].primary_family, pass: row.result.pass, compared: comparisonCompleted(row.result, manifest.units[index]) }));
      if (results.some((row, index) => row.pass && (!row.compared || ![...report.units[index].result.checks, ...report.units[index].result.relations].every(check => check.result.state === "PASS_PROJECTED_PROPERTY")))) throw new Error("PASS_WITHOUT_COMPLETE_COMPARISON");
      variantResults = results;
      aggregate = publicHoldoutAggregate(receipt, "REPORTED", results);
    } catch (error) {
      aggregate = publicHoldoutAggregate(receipt, "EXECUTION_UNAVAILABLE");
      await privateWrite("execution-failure.json", { error: String(error) });
    }
  }
  for (const [path, hash] of identities) await exactFile(path, hash);
  await exactFile(inputPath, receipt.privateCommitments.expectationsSha256);
  await sealPrivateTree(outputDirectory);
  aggregate = { ...aggregate, platform, startedUtc, finishedUtc: new Date().toISOString(), frozenRunnerSha256: freeze.runnerSha256, contractSha256: freeze.contractSha256, candidateSourceCommit: freeze.candidateSourceCommit, candidateFreezeSha256: freeze.candidateFreezeSha256, publicReceiptSha256: freeze.receiptSha256, inputCommitmentSha256: receipt.privateCommitments.expectationsSha256, observerInvocationAttempts: manifest ? 1 : 0, observerProcessInvocations, observerExitCode: processExit };
  await privateWrite("execution-record.json", { aggregate, units: variantResults });
  await privateWrite("aggregate.json", aggregate);
  return aggregate;
}

async function publishJoint(leftPath, rightPath, outputDirectory, receiptPath, freezePath) {
  const repository = await realpath(fileURLToPath(new URL("../../../", import.meta.url)));
  const inside = path => path === repository || path.startsWith(repository + sep);
  for (const path of [leftPath, rightPath]) if ([resolve(path), await realpath(path)].some(inside)) throw new Error("PRIVATE_DATA_IN_REPOSITORY_REFUSED");
  if ([resolve(outputDirectory), resolve(await realpath(dirname(resolve(outputDirectory))), basename(outputDirectory))].some(inside)) throw new Error("PRIVATE_DATA_IN_REPOSITORY_REFUSED");
  const freeze = JSON.parse(await readFile(freezePath, "utf8"));
  if (version !== "1.4.3") throw new Error("FROZEN_RUNTIME_MISMATCH");
  await exactFile(process.execPath, freeze.runtimeSha256.macos);
  await exactFile(fileURLToPath(import.meta.url), freeze.runnerSha256);
  await exactFile(freeze.contractPath, freeze.contractSha256);
  await exactFile(freeze.candidateFreezePath, freeze.candidateFreezeSha256);
  const receipt = JSON.parse((await exactFile(receiptPath, freeze.receiptSha256)).toString());
  const left = JSON.parse(await readFile(leftPath, "utf8"));
  const right = JSON.parse(await readFile(rightPath, "utf8"));
  const expected = { candidateSourceCommit: freeze.candidateSourceCommit, candidateFreezeSha256: freeze.candidateFreezeSha256, contractSha256: freeze.contractSha256, frozenRunnerSha256: freeze.runnerSha256, publicReceiptSha256: freeze.receiptSha256 };
  if (![left, right].every(record => Object.entries(expected).every(([key, value]) => record.aggregate?.[key] === value))) throw new Error("FOREIGN_EXECUTION_RECORD");
  const aggregate = { ...jointHoldoutAggregate(receipt, left, right), platform: "joint", finishedUtc: new Date().toISOString(), ...expected };
  await mkdir(outputDirectory, { mode: 0o700 });
  await writeFile(resolve(outputDirectory, "aggregate.json"), JSON.stringify(aggregate, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return aggregate;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const joint = args[0] === "--joint";
    if ((joint ? args.slice(1) : args).length !== 5 || !(joint ? args.slice(1) : args).every(text)) throw new Error("MISSING_FROZEN_RUN_ARGUMENT");
    const aggregate = joint ? await publishJoint(...args.slice(1)) : await runFrozenHoldout({ inputPath: args[0], outputDirectory: args[1], receiptPath: args[2], freezePath: args[3], platform: args[4] });
    process.stdout.write(JSON.stringify(aggregate) + "\n");
    process.exitCode = aggregate.variantsPass === aggregate.variantsTotal ? 0 : 1;
  } catch {
    process.stderr.write("FROZEN_HOLDOUT_RUN_REFUSED\n");
    process.exitCode = 2;
  }
}
