/**
 * ADR 0026 observational baseline harness. Usage: `bun run bench:index-workers [packages] [files]`
 * (both default and bound the "disconnected-modules" corpus; the two hostile fallback corpora use
 * fixed bounded dimensions). Emits schemaVersion 2 JSON on stdout: per corpus, nine fresh-subprocess
 * samples (three repetitions of worker counts 1/2/4, in a deterministic alternating order), their
 * equivalence verdict across independently-fingerprinted claim/diagnostic/persisted-index/seal/graph
 * components, and per-worker-count duration/peak-RSS medians. A sample that did not take the path
 * its corpus requires (parallel, preflight fallback or single) fails the run before equivalence. Native peak RSS and CPU time are
 * NOT_MEASURED, honestly, whenever the runtime does not report them; CI applies no threshold, only
 * the exit status. Real-repository and Apple Silicon baselines remain NOT_MEASURED by this harness.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { indexRepositoryAsync } from "@semantic-context/app-services";
import {
  buildPersistedFingerprintComponents,
  buildReturnedFingerprintComponents,
  compareFingerprints,
  type SampleFingerprint,
} from "./benchmark-multicore-index/fingerprint";
import {
  CORPUS_IDS,
  HOSTILE_CORPUS_DIMENSIONS,
  captureFixtureIdentity,
  materializeCorpus,
  type CorpusDimensions,
  type CorpusId,
  type FixtureIdentity,
} from "./benchmark-multicore-index/fixtures";
import { captureHostIdentity, captureImplementationIdentity } from "./benchmark-multicore-index/host-identity";
import { parallelismMismatch } from "./benchmark-multicore-index/parallelism";
import { WORKER_COUNTS, buildSamplePlan, type SamplePlanEntry, type WorkerCount } from "./benchmark-multicore-index/plan";
import { observeCpuTime, observePeakRssBytes, type CpuTimeObservation, type PeakMemoryObservation } from "./benchmark-multicore-index/resource-usage";
import { summarizeDurations, summarizePeakRss, type MetricSummary } from "./benchmark-multicore-index/summary";

const CAPTURED_AT = "2026-08-25T00:00:00.000Z";
const REPOSITORY_ROOT = resolve(import.meta.dir, "..");

interface WorkerRunOutput {
  requestedWorkers: number;
  usedWorkers: number;
  mode: string;
  reason: string | null;
  durationMs: number;
  rssBytesAfter: number;
  nodes: number;
  edges: number;
  fingerprint: SampleFingerprint;
}

interface CorpusSample {
  position: number;
  repetition: 1 | 2 | 3;
  requestedWorkers: WorkerCount;
  usedWorkers: number;
  mode: string;
  reason: string | null;
  durationMs: number;
  rssBytesAfter: number;
  peakRssBytes: PeakMemoryObservation;
  cpuTime: CpuTimeObservation;
  nodes: number;
  edges: number;
  fingerprint: SampleFingerprint;
}

interface CorpusReport {
  id: CorpusId;
  dimensions: CorpusDimensions;
  fixture: FixtureIdentity;
  equivalence: ReturnType<typeof compareFingerprints>;
  samples: CorpusSample[];
  summary: { byWorkerCount: Record<string, { durationMs: MetricSummary; peakRssBytes: MetricSummary }> };
}

if (import.meta.main) {
  if (process.argv[2] === "--worker-run") {
    await runWorkerSample(process.argv[3], boundedInteger(process.argv[4], 1, 1, 8));
  } else {
    await runBenchmark();
  }
}

async function runWorkerSample(root: string | undefined, workers: number): Promise<void> {
  if (root === undefined) throw new Error("benchmark worker run requires a repository root");
  Bun.gc(true);
  const started = performance.now();
  const indexed = await indexRepositoryAsync(root, CAPTURED_AT, workers);
  const durationMs = performance.now() - started;
  const fingerprint: SampleFingerprint = {
    ...buildReturnedFingerprintComponents(indexed),
    ...buildPersistedFingerprintComponents(root),
  };
  const output: WorkerRunOutput = {
    requestedWorkers: workers,
    usedWorkers: indexed.parallelism?.used ?? 1,
    mode: indexed.parallelism?.mode ?? "single",
    reason: indexed.parallelism?.reason ?? null,
    durationMs: Math.round(durationMs * 100) / 100,
    rssBytesAfter: process.memoryUsage().rss,
    nodes: indexed.analysis.graph.nodes.length,
    edges: indexed.analysis.graph.edges.length,
    fingerprint,
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function runBenchmark(): Promise<void> {
  const packageCount = boundedInteger(process.argv[2], 24, 1, 200);
  const filesPerPackage = boundedInteger(process.argv[3], 20, 2, 200);
  const plan = buildSamplePlan();
  const host = captureHostIdentity();
  const implementation = captureImplementationIdentity(REPOSITORY_ROOT);
  const corpora: CorpusReport[] = [];
  for (const id of CORPUS_IDS) {
    const dimensions = id === "disconnected-modules"
      ? { packages: packageCount, filesPerPackage }
      : HOSTILE_CORPUS_DIMENSIONS;
    corpora.push(runCorpus(id, dimensions, plan));
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 2,
    capturedAt: CAPTURED_AT,
    host,
    implementation,
    note: "Observational benchmark only; CI applies no wall-time or memory threshold. "
      + "Real-repository and Apple Silicon baselines remain NOT_MEASURED.",
    corpora,
  }, null, 2)}\n`);
}

function runCorpus(id: CorpusId, dimensions: CorpusDimensions, plan: readonly SamplePlanEntry[]): CorpusReport {
  const root = mkdtempSync(join(tmpdir(), `semctx-benchmark-${id}-`));
  try {
    materializeCorpus(id, root, dimensions);
    const fixture = captureFixtureIdentity(root);
    const samples: CorpusSample[] = plan.map((entry) => runSample(id, root, entry));
    for (const sample of samples) {
      const mismatch = parallelismMismatch(id, sample);
      if (mismatch !== null) {
        throw new Error(`corpus ${id} sample ${sample.position} (workers=${sample.requestedWorkers}) did not take its expected path: ${mismatch}`);
      }
    }
    const equivalence = compareFingerprints(samples.map((sample) => sample.fingerprint));
    if (!equivalence.equivalent) {
      throw new Error(
        `corpus ${id} sample ${equivalence.divergentSampleIndex} diverged in component `
          + `"${equivalence.component}" relative to sample 0`,
      );
    }
    const byWorkerCount = Object.fromEntries(WORKER_COUNTS.map((workers) => {
      const group = samples.filter((sample) => sample.requestedWorkers === workers);
      return [String(workers), {
        durationMs: summarizeDurations(group.map((sample) => sample.durationMs)),
        peakRssBytes: summarizePeakRss(group.map((sample) => sample.peakRssBytes)),
      }];
    }));
    return { id, dimensions, fixture, equivalence, samples, summary: { byWorkerCount } };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runSample(id: CorpusId, root: string, entry: SamplePlanEntry): CorpusSample {
  const child = Bun.spawnSync([
    process.execPath,
    import.meta.path,
    "--worker-run",
    root,
    String(entry.workers),
  ], { stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) {
    throw new Error(
      `corpus ${id} sample ${entry.position} (workers=${entry.workers}) failed: `
        + new TextDecoder().decode(child.stderr),
    );
  }
  const output = JSON.parse(new TextDecoder().decode(child.stdout)) as WorkerRunOutput;
  return {
    position: entry.position,
    repetition: entry.repetition,
    requestedWorkers: entry.workers,
    usedWorkers: output.usedWorkers,
    mode: output.mode,
    reason: output.reason,
    durationMs: output.durationMs,
    rssBytesAfter: output.rssBytesAfter,
    peakRssBytes: observePeakRssBytes(child.resourceUsage),
    cpuTime: observeCpuTime(child.resourceUsage),
    nodes: output.nodes,
    edges: output.edges,
    fingerprint: output.fingerprint,
  };
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`expected an integer from ${minimum} through ${maximum}, received ${value}`);
  }
  return parsed;
}
