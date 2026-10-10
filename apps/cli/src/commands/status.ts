import {
  controlStatusExplained,
  controlStatusTimeout,
  isValidPreflightBudget,
  MAX_PREFLIGHT_BUDGET_MS,
  MIN_PREFLIGHT_BUDGET_MS,
  runProcessWithinBudget,
} from "@semantic-context/app-services";
import {
  ControlStatusExplainedReportSchema,
  serializeControlReport,
  type ControlStatusPreflightReport,
} from "@semantic-context/control-model";
import type { ParsedArgs } from "../args";
import { flagBool } from "../args";
import { fail, info, warn } from "../output";

function render(report: ControlStatusPreflightReport, json: boolean): void {
  if (json) {
    info(serializeControlReport(report));
    return;
  }
  info(`${report.verdict}${report.reasons.length === 0 ? "" : `: ${report.reasons.join(", ")}`}`);
  for (const entry of report.explanation) {
    info(`  ${entry.code}: ${entry.detail}${entry.remedy === null ? "" : ` (remedy: ${entry.remedy})`}`);
  }
}

function finish(report: ControlStatusPreflightReport, json: boolean): number {
  render(report, json);
  if ((report.reasons as readonly string[]).includes("SEMANTIC_LIFECYCLE_INVALID")) {
    warn("Run semctx semantic check; for EVIDENCE_BASELINE_STALE, recover with semctx index --record.");
  }
  return report.canRunHighRiskControl ? 0 : 3;
}

/**
 * `--budget-ms` runs the same preflight in a child of this CLI and stops it at the deadline, so
 * the answer is always one of FRESH, DIRTY_KNOWN, STALE, UNSEALED or TIMEOUT within the budget.
 */
async function runBudgetedStatus(root: string, budgetMs: number, json: boolean): Promise<number> {
  // The budget is wall-clock from this process's start, so a caller's own deadline of N ms holds
  // with this CLI's startup included.
  const spentMs = (): number => Math.round(process.uptime() * 1_000);
  const remainingMs = budgetMs - spentMs();
  if (remainingMs <= 0) return finish(controlStatusTimeout(budgetMs, spentMs()), json);
  const outcome = await runProcessWithinBudget(
    [process.execPath, Bun.main, "status", "--json", "--root", root],
    { cwd: process.cwd(), budgetMs: remainingMs },
  );
  if (outcome.kind === "timeout") return finish(controlStatusTimeout(budgetMs, spentMs()), json);
  const parsed = (() => {
    try {
      return ControlStatusExplainedReportSchema.safeParse(JSON.parse(outcome.stdout.trim()));
    } catch {
      return undefined;
    }
  })();
  if (parsed?.success === true) return finish(parsed.data as ControlStatusPreflightReport, json);
  // The child failed before it had a verdict: relay its own diagnostics and exit code unchanged.
  if (outcome.stdout.length > 0) process.stdout.write(outcome.stdout);
  if (outcome.stderr.length > 0) process.stderr.write(outcome.stderr);
  return outcome.exitCode === 0 ? 1 : outcome.exitCode;
}

export async function runStatus(root: string, args: ParsedArgs): Promise<number> {
  const json = flagBool(args, "json");
  const rawBudget = args.flags.get("budget-ms");
  if (rawBudget !== undefined) {
    const budgetMs = typeof rawBudget === "string" && /^\d+$/.test(rawBudget) ? Number(rawBudget) : Number.NaN;
    if (!isValidPreflightBudget(budgetMs)) {
      fail(`--budget-ms expects an integer from ${MIN_PREFLIGHT_BUDGET_MS} to ${MAX_PREFLIGHT_BUDGET_MS}`);
      return 2;
    }
    return runBudgetedStatus(root, budgetMs, json);
  }
  return finish(controlStatusExplained(root), json);
}
