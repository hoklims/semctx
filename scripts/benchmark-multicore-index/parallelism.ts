import type { CorpusId } from "./fixtures";

/**
 * Equivalence across worker counts proves nothing if the parallel path was never taken: a run that
 * silently fell back to one worker compares single-worker results with themselves (HOK-823). Each
 * sample must therefore report the mode its corpus and requested worker count call for. The hostile
 * corpora exist to force the preflight fallback, so for them a parallel run is the defect.
 */
export interface ObservedParallelism {
  requestedWorkers: number;
  usedWorkers: number;
  mode: string;
  reason: string | null;
}

export interface ExpectedParallelism {
  usedWorkers: number;
  mode: "single" | "parallel" | "preflight-fallback";
  reasonPrefix: string | null;
}

const FALLBACK_REASON_PREFIX: Record<Exclude<CorpusId, "disconnected-modules">, string> = {
  "global-script-fallback": "global script: ",
  "module-augmentation-fallback": "global or module augmentation: ",
};

export function expectedParallelism(corpus: CorpusId, requestedWorkers: number): ExpectedParallelism {
  if (requestedWorkers === 1) return { usedWorkers: 1, mode: "single", reasonPrefix: null };
  if (corpus === "disconnected-modules") {
    return { usedWorkers: requestedWorkers, mode: "parallel", reasonPrefix: null };
  }
  return { usedWorkers: 1, mode: "preflight-fallback", reasonPrefix: FALLBACK_REASON_PREFIX[corpus] };
}

/** Returns why the sample did not take its expected path, or null when it did. */
export function parallelismMismatch(corpus: CorpusId, observed: ObservedParallelism): string | null {
  const expected = expectedParallelism(corpus, observed.requestedWorkers);
  const reasonMatches = expected.reasonPrefix === null
    ? observed.reason === null
    : typeof observed.reason === "string" && observed.reason.startsWith(expected.reasonPrefix);
  if (observed.mode === expected.mode && observed.usedWorkers === expected.usedWorkers && reasonMatches) return null;
  return `expected mode "${expected.mode}" with ${expected.usedWorkers} worker(s)`
    + `${expected.reasonPrefix === null ? " and no fallback reason" : ` and a reason starting "${expected.reasonPrefix}"`}, `
    + `observed mode "${observed.mode}" with ${observed.usedWorkers} worker(s) and reason ${JSON.stringify(observed.reason)}`;
}
