import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BuildPlanningBundleCommandV1Schema,
  buildPlanningBundle,
  reconcileWorkingTree,
  type BuildPlanningBundleCommandV1,
} from "@semantic-context/app-services/reconciliation";
import {
  ReconcileWorkingTreeInputV1Schema,
  serializeControlReport,
  type ReconcileWorkingTreeInputV1,
} from "@semantic-context/control-model/reconciliation";
import type { ParsedArgs } from "../args";
import { flagString } from "../args";
import { info } from "../output";

export const CONTROL_RECONCILIATION_HELP = `  control plan-change <change-id> --task-id <task-id> --input <planner.json> [--json]
      compile a versioned pre-edit PlanningBundle with executionAuthority "none"
  control reconcile-diff <input.json> [--json]
      read-only reconciliation of the current worktree against a strict
      {schemaVersion:1, planningBundle} input; no caller-selected Git refs`;

const FORBIDDEN_GIT_REFERENCE_FLAGS = [
  "base",
  "head",
  "base-ref",
  "head-ref",
  "baseRef",
  "headRef",
] as const;

type ReconciliationSubcommand = "plan-change" | "reconcile-diff";

/**
 * Dedicated non-authorizing CLI transport for issue #27.
 *
 * Returns undefined when the subcommand belongs to the legacy control handler.
 * Both handled commands emit the exact normalized application-service result as
 * canonical JSON; the CLI does not derive reasons or reinterpret reports.
 */
export function runControlReconciliation(
  root: string,
  args: ParsedArgs,
): number | undefined {
  const subcommand = args.positionals[1];
  if (subcommand !== "plan-change" && subcommand !== "reconcile-diff") {
    return undefined;
  }
  rejectCallerSelectedGitRefs(args, subcommand);

  if (subcommand === "plan-change") {
    return runPlanChange(root, args);
  }
  return runReconcileDiff(root, args);
}

function runPlanChange(root: string, args: ParsedArgs): number {
  assertPositionalCount(args, 3, "semctx control plan-change <change-id> --task-id <task-id> --input <planner.json>");
  const changeId = requiredPositional(
    args,
    2,
    "semctx control plan-change <change-id> --task-id <task-id> --input <planner.json>",
  );
  const taskFrameId = requiredFlag(args, "task-id");
  const inputFile = requiredFlag(args, "input");
  const plannerInputs = readJsonObject(root, inputFile, "planner input");
  const reservedKeys = ["schemaVersion", "taskFrameId", "changeId"].filter((key) =>
    Object.hasOwn(plannerInputs, key)
  );
  if (reservedKeys.length > 0) {
    throw new Error(
      `planner input must not redefine CLI-bound fields: ${reservedKeys.join(", ")}`,
    );
  }
  const command = BuildPlanningBundleCommandV1Schema.parse({
    schemaVersion: 1,
    ...plannerInputs,
    taskFrameId,
    changeId,
  }) as BuildPlanningBundleCommandV1;
  const bundle = buildPlanningBundle(root, command);
  info(serializeControlReport(bundle));
  return 0;
}

function runReconcileDiff(root: string, args: ParsedArgs): number {
  assertPositionalCount(args, 3, "semctx control reconcile-diff <input.json>");
  const inputFile = requiredPositional(
    args,
    2,
    "semctx control reconcile-diff <input.json>",
  );
  const rawInput = readJsonObject(root, inputFile, "reconciliation input");
  const parsed = ReconcileWorkingTreeInputV1Schema.safeParse(rawInput);
  if (!parsed.success) {
    throw new Error(
      `reconciliation input failed the shared schema: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const input = parsed.data as ReconcileWorkingTreeInputV1;
  const report = reconcileWorkingTree(root, input);
  info(serializeControlReport(report));
  return report.terminalStatus === "REALIZED" ? 0 : 3;
}

function rejectCallerSelectedGitRefs(
  args: ParsedArgs,
  subcommand: ReconciliationSubcommand,
): void {
  const forbidden = FORBIDDEN_GIT_REFERENCE_FLAGS.filter((name) => args.flags.has(name));
  if (forbidden.length > 0) {
    throw new Error(
      `semctx control ${subcommand} does not accept caller-selected Git refs: ${forbidden.map((name) => `--${name}`).join(", ")}`,
    );
  }
}

function readJsonObject(
  root: string,
  file: string,
  label: string,
): Record<string, unknown> {
  const path = resolve(root, file);
  if (!existsSync(path)) throw new Error(`${label} file does not exist: ${path}`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`${label} file is not valid JSON: ${String(cause)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requiredFlag(args: ParsedArgs, name: string): string {
  const value = flagString(args, name);
  if (value === undefined || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function requiredPositional(
  args: ParsedArgs,
  index: number,
  usage: string,
): string {
  const value = args.positionals[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`usage: ${usage}`);
  }
  return value;
}

function assertPositionalCount(
  args: ParsedArgs,
  expected: number,
  usage: string,
): void {
  if (args.positionals.length !== expected) {
    throw new Error(`usage: ${usage}`);
  }
}
