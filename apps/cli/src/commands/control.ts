import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SemctxError } from "@semantic-context/core";
import { loadControlState, planControlMigration, traceControl } from "@semantic-context/app-services";
import {
  ArchitectureDeltaSchema,
  ArchitectureSnapshotSchema,
  QualifiedCoordinateIdSchema,
  serializeControlReport,
  type ArchitectureDelta,
  type ArchitectureSnapshot,
  type QualifiedCoordinateId,
  type SemanticLevel,
  type TraversalDirection,
} from "@semantic-context/control-model";
import type { ParsedArgs } from "../args";
import { flagBool, flagString } from "../args";
import { info } from "../output";

const CONTROL_HELP = `semctx control — read-only semantic reconstruction control plane

Usage:
  semctx control trace <qualified-id> [--to 0..6] [--direction lift|lower]
      [--max-depth N] [--max-results N] [--json]
  semctx control plan <change-id> [--target <snapshot.json>] [--delta <delta.json>] [--json]
`;

function integerFlag(args: ParsedArgs, name: string, fallback: number, min: number, max: number): number {
  const raw = flagString(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SemctxError("INVALID_TASK_INPUT", `--${name} must be an integer between ${min} and ${max}`, { value: raw });
  }
  return value;
}

function directionFlag(args: ParsedArgs): TraversalDirection {
  const value = flagString(args, "direction") ?? "lift";
  if (value !== "lift" && value !== "lower") {
    throw new SemctxError("INVALID_TASK_INPUT", "--direction must be 'lift' or 'lower'", { value });
  }
  return value;
}

function requiredPositional(args: ParsedArgs, index: number, usage: string): string {
  const value = args.positionals[index];
  if (value === undefined || value.length === 0) throw new SemctxError("INVALID_TASK_INPUT", `usage: ${usage}`);
  return value;
}

function readJsonFile<T>(root: string, file: string, label: string, parse: (value: unknown) => T): T {
  const path = resolve(root, file);
  if (!existsSync(path)) throw new SemctxError("IO_ERROR", `${label} file does not exist`, { path });
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new SemctxError("INVALID_TASK_INPUT", `${label} file is not valid JSON`, { path, cause: String(cause) });
  }
  try {
    return parse(value);
  } catch (cause) {
    throw new SemctxError("INVALID_TASK_INPUT", `${label} file failed Plane C schema validation`, {
      path,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

export const loadCurrentControlState = loadControlState;

function emit(value: unknown, asJson: boolean, text: string): void {
  info(asJson ? serializeControlReport(value) : text);
}

export function runControl(root: string, args: ParsedArgs): number {
  const subcommand = args.positionals[1];
  if (subcommand === undefined || flagBool(args, "help")) {
    info(CONTROL_HELP);
    return 0;
  }

  if (subcommand === "trace") {
    const sourceInput = requiredPositional(args, 2, "semctx control trace <qualified-id>");
    const parsedSource = QualifiedCoordinateIdSchema.safeParse(sourceInput);
    if (!parsedSource.success) throw new SemctxError("INVALID_TASK_INPUT", "trace id must be qualified as repo:<id> or semantic:<id>", { sourceId: sourceInput });
    const sourceId = parsedSource.data as QualifiedCoordinateId;
    const direction = directionFlag(args);
    const targetLevel = integerFlag(args, "to", direction === "lift" ? 6 : 0, 0, 6) as SemanticLevel;
    const report = traceControl(root, {
      sourceId,
      direction,
      targetLevel,
      maxDepth: integerFlag(args, "max-depth", 8, 0, 100),
      maxResults: integerFlag(args, "max-results", 100, 1, 10_000),
    });
    emit(report, flagBool(args, "json"), `${direction} ${sourceId} -> L${targetLevel}: ${report.paths.length} path(s)${report.truncated ? " (truncated)" : ""}`);
    return 0;
  }

  if (subcommand === "plan") {
    const changeId = requiredPositional(args, 2, "semctx control plan <change-id>");
    const targetFile = flagString(args, "target");
    const deltaFile = flagString(args, "delta");
    const target = targetFile === undefined
      ? undefined
      : readJsonFile(root, targetFile, "target architecture", (value) => ArchitectureSnapshotSchema.parse(value) as ArchitectureSnapshot);
    const delta = deltaFile === undefined
      ? undefined
      : readJsonFile(root, deltaFile, "architecture delta", (value) => ArchitectureDeltaSchema.parse(value) as ArchitectureDelta);
    const report = planControlMigration(root, { changeId, ...(target !== undefined ? { target } : {}), ...(delta !== undefined ? { delta } : {}) });
    emit(report, flagBool(args, "json"), `${report.plan.status} ${report.plan.id}${report.plan.blockedReason === undefined ? "" : `: ${report.plan.blockedReason}`}`);
    return 0;
  }

  info(CONTROL_HELP);
  return 2;
}
