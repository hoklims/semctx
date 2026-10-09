/**
 * Budgeted read-only preflights for the MCP transport. `semctx_control_status` and
 * `semctx_index_health` run in a one-shot child of this same server entry, stopped at its deadline,
 * so a slow repository yields a typed TIMEOUT within the budget instead of a call that blocks the
 * server (and every queued call behind it) or never answers.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  controlStatusExplained,
  controlStatusTimeout,
  indexHealthTimeout,
  indexHealthView,
  runProcessWithinBudget,
  type IndexHealthReportV2,
  type IndexHealthTimeoutReportV2,
  type IndexHealthViewRequest,
} from "@semantic-context/app-services";
import { isSemctxError, SemctxError, type SemctxErrorCode } from "@semantic-context/core";
import type { ControlStatusPreflightReport } from "@semantic-context/control-model";
import { ToolPublicError } from "./public-tool-error";

export const BOUNDED_CALL_FLAG = "--semctx-bounded-call";

type BoundedRequest =
  | { operation: "control_status"; root: string }
  | { operation: "index_health"; root: string; request: IndexHealthViewRequest };

type ChildAnswer =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } };

/** The server entry this code was loaded from: the packaged bundle, or the source entry. */
function serverEntry(): string {
  const packaged = resolve(import.meta.dir, "semctx-mcp.js");
  return existsSync(packaged) ? packaged : resolve(import.meta.dir, "index.ts");
}

function compute(request: BoundedRequest): unknown {
  return request.operation === "control_status"
    ? controlStatusExplained(request.root)
    : indexHealthView(request.root, request.request);
}

/** Child side: answer exactly one request on stdout, then exit. Returns false when argv is not a bounded call. */
export function runBoundedCallFromArgv(argv: readonly string[]): boolean {
  if (argv[2] !== BOUNDED_CALL_FLAG || argv[3] === undefined) return false;
  let answer: ChildAnswer;
  try {
    answer = { ok: true, value: compute(JSON.parse(argv[3]) as BoundedRequest) };
  } catch (error) {
    answer = {
      ok: false,
      error: isSemctxError(error)
        ? { code: error.code, message: error.message }
        : { code: "INTERNAL_ERROR", message: "bounded call failed" },
    };
  }
  process.stdout.write(`${JSON.stringify(answer)}\n`, () => process.exit(0));
  return true;
}

async function callWithinBudget(request: BoundedRequest, budgetMs: number): Promise<{ kind: "value"; value: unknown } | { kind: "timeout"; elapsedMs: number }> {
  const entry = serverEntry();
  // The child runs from the runtime's own directory, never from the repository: a repository
  // bunfig.toml or .env must not configure the process that reads it.
  const outcome = await runProcessWithinBudget(
    [process.execPath, entry, BOUNDED_CALL_FLAG, JSON.stringify(request)],
    { cwd: dirname(entry), budgetMs },
  );
  if (outcome.kind === "timeout") return outcome;
  let answer: ChildAnswer;
  try {
    answer = JSON.parse(outcome.stdout.trim()) as ChildAnswer;
  } catch {
    throw new ToolPublicError("INTERNAL_ERROR", { cause: { exitCode: outcome.exitCode, stderr: outcome.stderr.slice(0, 2_048) } });
  }
  if (answer.ok) return { kind: "value", value: answer.value };
  if (answer.error.code === "INTERNAL_ERROR") throw new ToolPublicError("INTERNAL_ERROR", { cause: answer.error.message });
  throw new SemctxError(answer.error.code as SemctxErrorCode, answer.error.message);
}

export async function boundedControlStatus(root: string, budgetMs: number): Promise<ControlStatusPreflightReport> {
  const result = await callWithinBudget({ operation: "control_status", root }, budgetMs);
  return result.kind === "timeout"
    ? controlStatusTimeout(budgetMs, result.elapsedMs)
    : result.value as ControlStatusPreflightReport;
}

export async function boundedIndexHealth(
  root: string,
  request: IndexHealthViewRequest,
  budgetMs: number,
): Promise<IndexHealthReportV2 | IndexHealthTimeoutReportV2> {
  const result = await callWithinBudget({ operation: "index_health", root, request }, budgetMs);
  return result.kind === "timeout"
    ? indexHealthTimeout(budgetMs, result.elapsedMs)
    : result.value as IndexHealthReportV2;
}
