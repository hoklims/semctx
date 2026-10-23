import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { admissionObservations } from "./t00-ts7-q-boundary-admission";
import { filesystemObservations } from "./t00-ts7-q-boundary-filesystem";
import { asset, checkAsset, createContext, loadCandidate, parseArguments, record, resultStatus, sdkMatchesLibraries, selectShard, verifyAssets, type Observation } from "./t00-ts7-q-boundary-common";

export const obligations = [
  {
    "index": 0,
    "id": "T00-OBL-packages-app-services-src-qualified-analysis-ts-inspectretainedqualifiedscope-bd751ded9d",
    "primaryReasonGroup": "Q"
  },
  {
    "index": 1,
    "id": "T00-OBL-packages-app-services-src-qualified-analysis-ts-inspectretainedqualifiedscope-visit-04b87875b6",
    "primaryReasonGroup": "Q"
  },
  {
    "index": 2,
    "id": "T00-OBL-packages-ts-analyzer-src-analyze-ts-assemblerepository-6ce629281c",
    "primaryReasonGroup": "A"
  },
  {
    "index": 3,
    "id": "T00-OBL-packages-ts-analyzer-src-analyze-ts-assemblerepository-visit-29bc606f63",
    "primaryReasonGroup": "A"
  },
  {
    "index": 4,
    "id": "T00-OBL-packages-ts-analyzer-src-analyze-ts-assertsnapshotinputs-c112c2b6f5",
    "primaryReasonGroup": "A"
  },
  {
    "index": 5,
    "id": "T00-OBL-packages-ts-analyzer-src-discovery-ts-createqualifiedpatheligibility-34b5ccf114",
    "primaryReasonGroup": "D"
  },
  {
    "index": 6,
    "id": "T00-OBL-packages-ts-analyzer-src-discovery-ts-escapeddependencyreason-54c513873b",
    "primaryReasonGroup": "D"
  },
  {
    "index": 136,
    "id": "T00-OBL-packages-ts-analyzer-src-semantic-dependency-diagnostics-ts-key-131c1fcb59",
    "primaryReasonGroup": "F"
  },
  {
    "index": 168,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-dialect-version-a301ccdca0",
    "primaryReasonGroup": "V"
  },
  {
    "index": 169,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-assertconfinedtypescriptsources-c9ea0125fa",
    "primaryReasonGroup": "D"
  },
  {
    "index": 170,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-canonicaltypescriptfilekey-c3dd471648",
    "primaryReasonGroup": "F"
  },
  {
    "index": 216,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-snapshotsystem-c1c525f129",
    "primaryReasonGroup": "F"
  },
  {
    "index": 217,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-snapshotsystem-directoryexists-ee83d1d5c8",
    "primaryReasonGroup": "F"
  },
  {
    "index": 218,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-snapshotsystem-fileexists-5ecaa00d92",
    "primaryReasonGroup": "F"
  },
  {
    "index": 219,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-snapshotsystem-readfile-f4dc7533c6",
    "primaryReasonGroup": "F"
  },
  {
    "index": 220,
    "id": "T00-OBL-packages-ts-analyzer-src-ts-symbols-ts-typescriptlibrarydirectory-e9855a4e4f",
    "primaryReasonGroup": "K"
  },
  {
    "index": 229,
    "id": "T00-OBL-scripts-analyzer-identity-ts-analyzeridentity-530b120929",
    "primaryReasonGroup": "K"
  },
  {
    "index": 230,
    "id": "T00-OBL-scripts-pilot-baselines-ts-extractrelativeimportspecifiers-95b94116e6",
    "primaryReasonGroup": "I"
  },
  {
    "index": 231,
    "id": "T00-OBL-scripts-pilot-baselines-ts-extractrelativeimportspecifiers-visit-087252e9e7",
    "primaryReasonGroup": "I"
  },
  {
    "index": 232,
    "id": "T00-OBL-packages-app-services-src-qualified-analysis-ts-bindopaquecallbackgraph-44b96ab139",
    "primaryReasonGroup": "Q"
  },
  {
    "index": 233,
    "id": "T00-OBL-packages-app-services-src-qualified-analysis-ts-qualifiedadmission-5e3c15f48a",
    "primaryReasonGroup": "Q"
  },
  {
    "index": 234,
    "id": "T00-OBL-packages-app-services-src-qualified-analysis-ts-scope-token-revalidation-and-opaque-ow-b3c8039572",
    "primaryReasonGroup": "Q"
  },
  {
    "index": 235,
    "id": "T00-OBL-packages-app-services-src-plane-a-runtime-ts-produce-extract-plane-a-runtime-analyzere-73e2719cc6",
    "primaryReasonGroup": "A"
  },
  {
    "index": 236,
    "id": "T00-OBL-packages-app-services-src-verify-ts-immutable-base-capture-inspectretainedqualifiedsco-ee99401afd",
    "primaryReasonGroup": "Q"
  },
  {
    "index": 237,
    "id": "T00-OBL-packages-app-services-src-verify-ts-verify-qualifiedadmission-08496630a9",
    "primaryReasonGroup": "Q"
  },
  {
    "index": 238,
    "id": "T00-OBL-packages-app-services-src-verify-ts-verify-admission-arguments-bindopaquecallbackgraph-d6d3e9c98f",
    "primaryReasonGroup": "Q"
  }
] as const;

export async function campaign(args: string[]): Promise<void> {
  const started = performance.now();
  const flags = parseArguments(args);
  if (process.arch !== "arm64" || process.platform !== (flags.platform === "macos" ? "darwin" : "linux") || Bun.version !== "1.4.3") throw Error("campaign requires selected arm64 platform and Bun 1.4.3");
  const { candidate, assets } = await loadCandidate(flags.candidate, flags.platform);
  await mkdir(flags.out, { recursive: true });
  if ((await readdir(flags.out)).length > 0) throw Error("output directory must be empty");
  const context = await createContext(flags.out, flags.platform, assets, candidate.dryRun);
  const selected = selectShard(obligations.map(row => row.index), flags.shard);
  const sdkFiles = record(context.sdk.files);
  const sdkMatchesOracle = await sdkMatchesLibraries(context.sdk, dirname(assets.oracle.path), assets.oracleLibraries.path);
  const manifestEvidence = await asset(flags.candidate);
  const observations: (Observation & { durationMs: number; measurementScope: string })[] = [];
  const technicalFailures: string[] = [];
  for (const [name, collect, indices] of [
    ["admission", admissionObservations, selected.filter(index => [0, 1, 2, 3, 4, 232, 233, 234, 235, 236, 237, 238].includes(index))],
    ["filesystem", filesystemObservations, selected.filter(index => ![0, 1, 2, 3, 4, 232, 233, 234, 235, 236, 237, 238].includes(index))],
  ] as const) {
    if (!indices.length) continue;
    const boundaryStarted = performance.now();
    let batch: Observation[];
    try {
      batch = await collect(context, indices);
      if (batch.length !== indices.length || new Set(batch.map(item => item.index)).size !== indices.length || batch.some(item => !indices.includes(item.index))) throw Error("boundary returned missing/duplicate/foreign obligation");
    } catch (error) {
      technicalFailures.push(String(error));
      const failure = await context.save(name + "-runner-failure", { error: String(error), stack: error instanceof Error ? error.stack : undefined });
      batch = indices.map(index => ({ index, complete: false, reason: "Boundary execution failed: " + String(error), properties: [], evidence: [failure] }));
    }
    const durationMs = performance.now() - boundaryStarted;
    for (const observation of batch) {
      for (const evidence of observation.evidence) await checkAsset(evidence);
      observations.push({ ...observation, properties: [...observation.properties, { name: "candidate-sdk-is-independent-115-library-TS7-inventory", pass: sdkMatchesOracle, expected: "115 exact upstream library payloads", actual: { libraries: Object.keys(sdkFiles).length, matches: sdkMatchesOracle, version: context.sdk.version }, oracle: "Independent pinned TS7 SDK inventory" }], evidence: [...observation.evidence, manifestEvidence], durationMs, measurementScope: "shared-" + name + "-boundary" });
    }
  }
  await verifyAssets(assets, flags.platform);
  await checkAsset(manifestEvidence);
  const durationMs = performance.now() - started;
  const results = observations.sort((left, right) => left.index - right.index).map(observation => ({
    ...observation, id: obligations.find(row => row.index === observation.index)!.id, status: resultStatus(observation, candidate.dryRun),
    properties: [...observation.properties.map(property => ({ ...property, id: property.name, status: property.pass ? "passed" : "failed", reason: property.pass ? "Observed expected value; oracle: " + property.oracle : "Observed value differs; oracle: " + property.oracle, evidence: observation.evidence })), { id: "complete-cumulative-owning-boundary", status: observation.complete ? "passed" : "not_run", reason: observation.reason, evidence: observation.evidence }],
    reason: [candidate.dryRun ? "Development rehearsal; zero final qualification credit." : "", observation.reason, observation.properties.filter(property => !property.pass).map(property => property.name + " failed").join("; ")].filter(Boolean).join(" "),
    platform: flags.platform, sourceCommit: candidate.sourceCommit, dryRun: candidate.dryRun, campaignDurationMs: durationMs,
  }));
  const [shardIndex, shardCount] = flags.shard.split("/").map(Number);
  await writeFile(resolve(flags.out, "results.json"), JSON.stringify({ schemaVersion: 1, lot: "q-boundary", platform: flags.platform, sourceCommit: candidate.sourceCommit, candidateManifestSha256: manifestEvidence.sha256, shard: { index: shardIndex, count: shardCount }, durationMs, dryRun: candidate.dryRun, results }, null, 2) + "\n");
  await writeFile(resolve(flags.out, "run-summary.json"), JSON.stringify({ schemaVersion: 1, sourceCommit: candidate.sourceCommit, dryRun: candidate.dryRun, platform: flags.platform, arch: process.arch, bun: Bun.version, shard: flags.shard, durationMs, obligations: results.length, qualified: results.filter(row => row.status === "qualified").length, failedProperties: results.flatMap(row => row.properties.filter(property => property.status === "failed")).length, candidateManifest: manifestEvidence, networkIsolation: process.platform === "linux" ? "Required from container launcher (--network none); inspect launch evidence." : "Required from sandbox-exec launcher; inspect launch evidence.", scope: "Single-platform observations only; aggregate both required platforms before qualification credit." }, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ out: flags.out, obligations: results.length, durationMs, dryRun: candidate.dryRun }) + "\n");
  if (technicalFailures.length) throw Error("Technical boundary failure: " + technicalFailures.join("; "));
}

if (import.meta.main) {
  try { await campaign(process.argv.slice(2)); }
  catch (error) { process.stderr.write(String(error) + "\n"); process.exitCode = 1; }
}
