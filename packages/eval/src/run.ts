import { defaultTaskExtractor, extractionContext, prepareContextPack } from "@semantic-context/context-engine";
import type { RepositoryGraph, EvidenceRecord, Claim, TaskFrameInput } from "@semantic-context/core";
import type { BenchCase, BenchReport, BenchCaseResult } from "./spec";
import { scoreCase } from "./scorer";

export interface RunBenchArgs {
  graph: RepositoryGraph;
  evidence: EvidenceRecord[];
  claims: Claim[];
  cases: BenchCase[];
  /** Minimum aggregate score to pass (default 1 — strict regression gate). */
  threshold?: number;
}

// Two distinct injected clocks so the determinism metric is meaningful.
const CLOCK_A = "2026-01-01T00:00:00.000Z";
const CLOCK_B = "2026-02-02T00:00:00.000Z";

function mean(values: readonly number[]): number {
  if (values.length === 0) return 1;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Run a benchmark suite against an indexed repository. Fully deterministic: the only
 * varying inputs are the two injected clocks, and the scorer normalises them out.
 */
export function runBench(args: RunBenchArgs): BenchReport {
  const threshold = args.threshold ?? 1;

  const results: BenchCaseResult[] = args.cases.map((benchCase) => {
    const seed: TaskFrameInput = benchCase.mode !== undefined
      ? { rawTask: benchCase.task, mode: benchCase.mode }
      : { rawTask: benchCase.task };

    const frameA = defaultTaskExtractor.extract(seed, extractionContext(args.graph, CLOCK_A));
    const frameB = defaultTaskExtractor.extract(seed, extractionContext(args.graph, CLOCK_B));

    const packA = prepareContextPack({
      graph: args.graph,
      evidence: args.evidence,
      claims: args.claims,
      taskFrame: frameA,
      now: CLOCK_A,
    });
    const packB = prepareContextPack({
      graph: args.graph,
      evidence: args.evidence,
      claims: args.claims,
      taskFrame: frameB,
      now: CLOCK_B,
    });

    return scoreCase(benchCase.id, packA, packB, benchCase.expect);
  });

  const score = mean(results.map((r) => r.score));
  const passed = results.every((r) => r.passed) && score >= threshold;
  return { threshold, score, passed, cases: results };
}
