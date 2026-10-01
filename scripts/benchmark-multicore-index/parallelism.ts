import type { CorpusId } from "./fixtures";

export interface ObservedParallelism {
  requestedWorkers: number;
  usedWorkers: number;
  mode: string;
  reason: string | null;
}

const FALLBACK_REASON_PREFIX: Record<Exclude<CorpusId, "disconnected-modules">, string> = {
  "global-script-fallback": "global script: ",
  "module-augmentation-fallback": "global or module augmentation: ",
};

/** Returns a precise refusal when equivalence was measured on the wrong execution path. */
export function parallelismMismatch(corpus: CorpusId, observed: ObservedParallelism): string | null {
  const expected = observed.requestedWorkers === 1
    ? { mode: "single", usedWorkers: 1, reasonPrefix: null }
    : corpus === "disconnected-modules"
      ? { mode: "parallel", usedWorkers: observed.requestedWorkers, reasonPrefix: null }
      : { mode: "preflight-fallback", usedWorkers: 1, reasonPrefix: FALLBACK_REASON_PREFIX[corpus] };
  const reasonMatches = expected.reasonPrefix === null
    ? observed.reason === null
    : observed.reason?.startsWith(expected.reasonPrefix) === true;
  if (observed.mode === expected.mode && observed.usedWorkers === expected.usedWorkers && reasonMatches) return null;
  return `expected mode "${expected.mode}" with ${expected.usedWorkers} worker(s)`
    + `${expected.reasonPrefix === null ? " and no fallback reason" : ` and a reason starting "${expected.reasonPrefix}"`}, `
    + `observed mode "${observed.mode}" with ${observed.usedWorkers} worker(s) and reason ${JSON.stringify(observed.reason)}`;
}
