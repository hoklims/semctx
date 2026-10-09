/**
 * Run a read-only semctx computation in a child process that is stopped at its deadline. A
 * synchronous computation cannot be interrupted in-process, so the budget is enforced by killing
 * the child and every process it started: the caller always gets an answer within the budget, a
 * finished one or a timeout, and a timed-out preflight leaves no Git scan running behind it.
 */

import { spawn } from "node:child_process";

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

export function isValidPreflightBudget(budgetMs: number): boolean {
  return Number.isSafeInteger(budgetMs) && budgetMs >= MIN_PREFLIGHT_BUDGET_MS && budgetMs <= MAX_PREFLIGHT_BUDGET_MS;
}

/**
 * Kill a child and its descendants. POSIX children lead their own process group (`detached`), so
 * the group is signalled at once. On Windows `taskkill /T` walks the tree; it is started and left
 * to finish on its own, so the deadline is answered without waiting for it.
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
}

export async function runProcessWithinBudget(argv: readonly string[], options: BoundedProcessOptions): Promise<BoundedProcessOutcome> {
  const started = performance.now();
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("bounded process requires a command");
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const elapsed = (): number => Math.round(performance.now() - started);

  return await new Promise<BoundedProcessOutcome>((resolveOutcome) => {
    let settled = false;
    let overflowed = false;
    let bytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const settle = (outcome: BoundedProcessOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOutcome(outcome);
    };
    const collect = (sink: Buffer[]) => (chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > MAX_CHILD_OUTPUT_BYTES) {
        if (!overflowed) {
          overflowed = true;
          killTree(child.pid);
        }
        return;
      }
      sink.push(chunk);
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    // The deadline answers on its own: it never waits for pipes that a descendant could hold open.
    const timer = setTimeout(() => {
      killTree(child.pid);
      settle({ kind: "timeout", elapsedMs: elapsed() });
    }, options.budgetMs);
    child.on("error", (error) => {
      settle({ kind: "exited", exitCode: 1, stdout: "", stderr: String(error), elapsedMs: elapsed() });
    });
    child.on("close", (code) => {
      if (overflowed) {
        settle({ kind: "exited", exitCode: code === 0 || code === null ? 1 : code, stdout: "", stderr: "bounded child output exceeded its byte limit", elapsedMs: elapsed() });
        return;
      }
      settle({
        kind: "exited",
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        elapsedMs: elapsed(),
      });
    });
  });
}
