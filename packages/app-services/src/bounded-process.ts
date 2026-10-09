/**
 * Run a read-only semctx computation in a child process that is stopped at its deadline. A
 * synchronous computation cannot be interrupted in-process, so the budget is enforced by killing
 * the child: the caller always gets an answer within the budget, a finished one or a timeout.
 */

export const DEFAULT_PREFLIGHT_BUDGET_MS = 15_000;
export const MIN_PREFLIGHT_BUDGET_MS = 1_000;
export const MAX_PREFLIGHT_BUDGET_MS = 600_000;
/** A bounded child answers with one bounded JSON document; anything larger is a fault, not a result. */
const MAX_CHILD_OUTPUT_BYTES = 16 * 1024 * 1024;

export type BoundedProcessOutcome =
  | { kind: "exited"; exitCode: number; stdout: string; stderr: string; elapsedMs: number }
  | { kind: "timeout"; elapsedMs: number };

export interface BoundedProcessOptions {
  cwd: string;
  budgetMs: number;
  env?: Record<string, string | undefined>;
}

async function readCapped(stream: ReadableStream<Uint8Array>, onOverflow: () => void): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > MAX_CHILD_OUTPUT_BYTES) {
      onOverflow();
      break;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function isValidPreflightBudget(budgetMs: number): boolean {
  return Number.isSafeInteger(budgetMs) && budgetMs >= MIN_PREFLIGHT_BUDGET_MS && budgetMs <= MAX_PREFLIGHT_BUDGET_MS;
}

export async function runProcessWithinBudget(argv: readonly string[], options: BoundedProcessOptions): Promise<BoundedProcessOutcome> {
  const started = performance.now();
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stop = (): void => {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  };
  let overflowed = false;
  const overflow = (): void => {
    overflowed = true;
    stop();
  };
  const completion = Promise.all([
    readCapped(child.stdout, overflow),
    readCapped(child.stderr, overflow),
    child.exited,
  ]).then(([stdout, stderr, exitCode]): BoundedProcessOutcome => {
    const elapsedMs = Math.round(performance.now() - started);
    if (overflowed) {
      return { kind: "exited", exitCode: exitCode === 0 ? 1 : exitCode, stdout: "", stderr: "bounded child output exceeded its byte limit", elapsedMs };
    }
    return { kind: "exited", exitCode, stdout, stderr, elapsedMs };
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The deadline answers on its own: it never waits for the child's pipes to drain, which a
  // grandchild still holding them could delay past the budget.
  const deadline = new Promise<BoundedProcessOutcome>((resolveDeadline) => {
    timer = setTimeout(() => {
      stop();
      resolveDeadline({ kind: "timeout", elapsedMs: Math.round(performance.now() - started) });
    }, options.budgetMs);
  });
  try {
    return await Promise.race([completion, deadline]);
  } finally {
    clearTimeout(timer);
    completion.catch(() => undefined);
  }
}
