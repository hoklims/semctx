import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SemctxError } from "@semantic-context/core";
import {
  loadControlState,
  planControlMigration,
  queryControlArchitectureComparison,
  queryControlDeletionAuthorization,
  queryControlExplanation,
  queryControlGraph,
  queryControlImpact,
  queryControlRefinementCoverage,
  queryControlStepAuthorization,
  queryControlTransitionAuthorization,
  queryControlTraversal,
  traceControl,
  type DeletionAuthorizationQueryV1,
  type StepAuthorizationQueryV1,
  type TransitionAuthorizationQueryV1,
} from "@semantic-context/app-services";
import {
  AttestationRequestV1Schema,
  ArchitectureDeltaSchema,
  ArchitectureSnapshotSchema,
  DeletionAuthorizationInputSchema,
  QualifiedCoordinateIdSchema,
  Sha256HashSchema,
  StepAuthorizationInputSchema,
  TransitionAuthorizationInputSchema,
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
  semctx control graph [--json]
  semctx control traversal <coordinate> [--to 0..6] [--direction lift|lower] [--json]
  semctx control coverage <coordinate> [--source-seal <sha256>] [--index-seal <sha256>]
      [--to 0..6] [--direction lift|lower] [--json]
  semctx control impact <qualified-id> [<qualified-id> ...] [--json]
  semctx control explain-why <qualified-id> [--json]
  semctx control compare-architecture --target <snapshot.json> [--json]
  semctx control authorize-transition --input <query.json> [--json]
  semctx control authorize-step --input <query.json> [--json]
  semctx control authorize-deletion --input <query.json> [--json]
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

function coordinate(value: string): QualifiedCoordinateId | `sha256:${string}` {
  const parsed = QualifiedCoordinateIdSchema.safeParse(value);
  if (parsed.success) return parsed.data as QualifiedCoordinateId;
  const digest = Sha256HashSchema.safeParse(value);
  if (digest.success) return digest.data as `sha256:${string}`;
  throw new SemctxError("INVALID_TASK_INPUT", "coordinate must be qualified or a sha256 observed-hunk identity", { coordinate: value });
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
    emit(report, flagBool(args, "json"), `${direction} ${sourceId} -> L${targetLevel}: ${report.paths.length} path(s)${report.budget.truncated ? " (truncated)" : ""}`);
    return 0;
  }

  if (subcommand === "graph") {
    const report = queryControlGraph(root);
    emit(report, flagBool(args, "json"), `${report.payload?.nodes.length ?? 0} coordinate(s)`);
    return 0;
  }

  if (subcommand === "traversal") {
    const sourceId = coordinate(requiredPositional(args, 2, "semctx control traversal <coordinate>"));
    const direction = directionFlag(args);
    const targetLevel = integerFlag(args, "to", direction === "lift" ? 6 : 0, 0, 6) as SemanticLevel;
    const report = queryControlTraversal(root, {
      sourceId,
      direction,
      targetLevel,
      maxDepth: integerFlag(args, "max-depth", 8, 0, 100),
      maxResults: integerFlag(args, "max-results", 100, 1, 10_000),
    });
    emit(report, flagBool(args, "json"), `${report.terminalStatus}: ${report.payload?.paths.length ?? 0} path(s)`);
    return 0;
  }

  if (subcommand === "coverage") {
    const sourceId = coordinate(requiredPositional(args, 2, "semctx control coverage <coordinate>"));
    const sourceSealValue = flagString(args, "source-seal");
    const indexSealValue = flagString(args, "index-seal");
    const sourceSeal = sourceSealValue === undefined
      ? undefined
      : Sha256HashSchema.parse(sourceSealValue) as `sha256:${string}`;
    const indexSeal = indexSealValue === undefined
      ? undefined
      : Sha256HashSchema.parse(indexSealValue) as `sha256:${string}`;
    const direction = directionFlag(args);
    const targetLevel = integerFlag(args, "to", direction === "lift" ? 6 : 0, 0, 6) as SemanticLevel;
    const report = queryControlRefinementCoverage(root, {
      sourceId,
      ...(sourceSeal === undefined ? {} : { sourceSeal }),
      ...(indexSeal === undefined ? {} : { indexSeal }),
      direction,
      targetLevel,
      maxDepth: integerFlag(args, "max-depth", 8, 0, 100),
      maxResults: integerFlag(args, "max-results", 100, 1, 10_000),
    });
    emit(report, flagBool(args, "json"), `${report.terminalStatus}: ${report.payload?.coveredLevels.length ?? 0} level(s) covered`);
    return 0;
  }

  if (subcommand === "impact") {
    const sourceIds = args.positionals.slice(2).map((value) => {
      const parsed = QualifiedCoordinateIdSchema.safeParse(value);
      if (!parsed.success) throw new SemctxError("INVALID_TASK_INPUT", "impact ids must be qualified repo: or semantic: coordinates", { sourceId: value });
      return parsed.data as QualifiedCoordinateId;
    });
    if (sourceIds.length === 0) throw new SemctxError("INVALID_TASK_INPUT", "usage: semctx control impact <qualified-id> [<qualified-id> ...]");
    const report = queryControlImpact(root, {
      sourceIds,
      maxDepth: integerFlag(args, "max-depth", 8, 0, 100),
      maxResults: integerFlag(args, "max-results", 100, 1, 10_000),
    });
    emit(report, flagBool(args, "json"), `${report.terminalStatus}: ${report.payload?.affected.length ?? 0} affected coordinate(s)`);
    return 0;
  }

  if (subcommand === "explain-why") {
    const sourceInput = requiredPositional(args, 2, "semctx control explain-why <qualified-id>");
    const parsed = QualifiedCoordinateIdSchema.safeParse(sourceInput);
    if (!parsed.success) throw new SemctxError("INVALID_TASK_INPUT", "explain-why id must be qualified", { sourceId: sourceInput });
    const report = queryControlExplanation(root, {
      sourceId: parsed.data as QualifiedCoordinateId,
      maxDepth: integerFlag(args, "max-depth", 8, 0, 100),
      maxResults: integerFlag(args, "max-results", 100, 1, 10_000),
    });
    emit(report, flagBool(args, "json"), `${report.terminalStatus}: ${report.payload?.rationaleIds.length ?? 0} authored rationale(s)`);
    return 0;
  }

  if (subcommand === "compare-architecture") {
    const targetFile = flagString(args, "target");
    if (targetFile === undefined) throw new SemctxError("INVALID_TASK_INPUT", "--target is required");
    const target = readJsonFile(root, targetFile, "target architecture", (value) =>
      ArchitectureSnapshotSchema.parse(value) as ArchitectureSnapshot);
    const report = queryControlArchitectureComparison(root, target);
    emit(report, flagBool(args, "json"), `${report.terminalStatus}: architecture comparison`);
    return 0;
  }

  if (subcommand === "authorize-transition") {
    const query = readAuthorizationQuery(root, args, "transition");
    const report = queryControlTransitionAuthorization(root, query);
    emit(report, flagBool(args, "json"), `${report.terminalStatus}: ${report.payload?.decision ?? "REFUSED"}`);
    return 0;
  }

  if (subcommand === "authorize-step") {
    const query = readAuthorizationQuery(root, args, "step");
    const report = queryControlStepAuthorization(root, query);
    emit(report, flagBool(args, "json"), `${report.terminalStatus}: ${report.payload?.decision ?? "REFUSED"}`);
    return 0;
  }

  if (subcommand === "authorize-deletion") {
    const query = readAuthorizationQuery(root, args, "deletion");
    const report = queryControlDeletionAuthorization(root, query);
    emit(report, flagBool(args, "json"), `${report.terminalStatus}: ${report.payload?.decision ?? "REFUSED"}`);
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

function readAuthorizationQuery(root: string, args: ParsedArgs, kind: "transition"): TransitionAuthorizationQueryV1;
function readAuthorizationQuery(root: string, args: ParsedArgs, kind: "step"): StepAuthorizationQueryV1;
function readAuthorizationQuery(root: string, args: ParsedArgs, kind: "deletion"): DeletionAuthorizationQueryV1;
function readAuthorizationQuery(
  root: string,
  args: ParsedArgs,
  kind: "transition" | "step" | "deletion",
): TransitionAuthorizationQueryV1 | StepAuthorizationQueryV1 | DeletionAuthorizationQueryV1 {
  const inputFile = flagString(args, "input");
  if (inputFile === undefined) throw new SemctxError("INVALID_TASK_INPUT", "--input is required");
  return readJsonFile(root, inputFile, `${kind} authorization query`, (value) => {
    if (typeof value !== "object" || value === null) throw new Error("expected an object");
    const { attestationRequests: rawRequests, ...rawInput } = value as Record<string, unknown>;
    const attestationRequests = AttestationRequestV1Schema.array().parse(rawRequests ?? []);
    if (kind === "transition") {
      const parsed = TransitionAuthorizationInputSchema.parse({ ...rawInput, attestations: [] });
      const { attestations: _attestations, ...input } = parsed;
      return { ...input, attestationRequests } as TransitionAuthorizationQueryV1;
    }
    if (kind === "step") {
      const parsed = StepAuthorizationInputSchema.parse({ ...rawInput, attestations: [] });
      const { attestations: _attestations, ...input } = parsed;
      return { ...input, attestationRequests } as StepAuthorizationQueryV1;
    }
    const parsed = DeletionAuthorizationInputSchema.parse({ ...rawInput, attestations: [] });
    const { attestations: _attestations, ...input } = parsed;
    return { ...input, attestationRequests } as DeletionAuthorizationQueryV1;
  });
}
