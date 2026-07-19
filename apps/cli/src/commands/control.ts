import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compareIds, SemctxError } from "@semantic-context/core";
import {
  ArchitectureDeltaSchema,
  ArchitectureSnapshotSchema,
  QualifiedCoordinateIdSchema,
  serializeControlReport,
  type ArchitectureDelta,
  type ArchitectureSnapshot,
  type ChangePlanningContext,
  type QualifiedCoordinateId,
  type SemanticLevel,
  type TraversalDirection,
} from "@semantic-context/control-model";
import {
  buildCoordinateGraph,
  compileMigrationPlan,
  fingerprintCoordinateGraph,
  lift,
  lower,
  snapshotArchitecture,
} from "@semantic-context/control-engine";
import { SqliteRepositoryReader, dbPath, isInitialized } from "@semantic-context/repository-store";
import { loadSemanticModel } from "@semantic-context/semantic-engine";
import { PROVEN_STATUSES, type ChangeContract, type SemanticModel } from "@semantic-context/semantic-model";
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

/** Load Plane A+B without opening a writable store or creating workspace files. */
export function loadCurrentControlState(root: string): {
  graph: ReturnType<typeof buildCoordinateGraph>;
  snapshot: ArchitectureSnapshot;
  changeIds: string[];
  planningContexts: ChangePlanningContext[];
} {
  if (!isInitialized(root)) {
    throw new SemctxError("CONFIG_NOT_FOUND", `repository is not initialized at ${root}; run 'semctx init' first`, { root });
  }

  const reader = SqliteRepositoryReader.openExisting(dbPath(root));
  try {
    if (!reader.isIndexed()) {
      throw new SemctxError("REPO_NOT_INDEXED", `repository index is absent at ${root}; run 'semctx index' first`, { root });
    }
    const semantic = loadSemanticModel(root);
    const semanticErrors = semantic.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (semanticErrors.length > 0 || semantic.duplicateIds.length > 0) {
      throw new SemctxError("CONFIG_INVALID", "semantic model cannot be projected into Plane C", {
        diagnostics: semanticErrors,
        duplicateIds: semantic.duplicateIds,
      });
    }
    const graph = buildCoordinateGraph({ repositoryGraph: reader.loadGraph(), semanticModel: semantic.model });
    const capturedAt = reader.getMeta("indexed_at") ?? "1970-01-01T00:00:00.000Z";
    const graphFingerprint = fingerprintCoordinateGraph(graph);
    const indexedCommit = reader.getMeta("indexed_commit");
    const commit = indexedCommit === undefined ? `graph:${graphFingerprint}` : `git:${indexedCommit}:graph:${graphFingerprint}`;
    return {
      graph,
      snapshot: snapshotArchitecture(graph, { id: `current:${graphFingerprint}`, commit, capturedAt }),
      changeIds: semantic.model.changes.map((change) => change.id).sort(),
      planningContexts: semantic.model.changes.map((change) => planningContext(semantic.model, change)).sort((a, b) => compareIds(a.id, b.id)),
    };
  } finally {
    reader.close();
  }
}

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
    const maxDepth = integerFlag(args, "max-depth", 8, 0, 100);
    const maxResults = integerFlag(args, "max-results", 100, 1, 10_000);
    const { graph } = loadCurrentControlState(root);
    const report = direction === "lift"
      ? lift(graph, sourceId, targetLevel, { maxDepth, maxResults })
      : lower(graph, sourceId, targetLevel, { maxDepth, maxResults });
    emit(
      report,
      flagBool(args, "json"),
      `${direction} ${sourceId} -> L${targetLevel}: ${report.paths.length} path(s)${report.truncated ? " (truncated)" : ""}`,
    );
    return 0;
  }

  if (subcommand === "plan") {
    const changeId = requiredPositional(args, 2, "semctx control plan <change-id>");
    const state = loadCurrentControlState(root);
    const change = state.planningContexts.find((context) => context.id === changeId);
    if (change === undefined) {
      throw new SemctxError("INVALID_TASK_INPUT", `change contract not found: ${changeId}`, { changeId });
    }
    const targetFile = flagString(args, "target");
    const deltaFile = flagString(args, "delta");
    if (deltaFile !== undefined && targetFile === undefined) {
      throw new SemctxError("INVALID_TASK_INPUT", "--delta requires --target");
    }
    const target = targetFile === undefined
      ? undefined
      : readJsonFile(root, targetFile, "target architecture", (value) => ArchitectureSnapshotSchema.parse(value) as ArchitectureSnapshot);
    const delta = deltaFile === undefined
      ? undefined
      : readJsonFile(root, deltaFile, "architecture delta", (value) => ArchitectureDeltaSchema.parse(value) as ArchitectureDelta);
    const report = compileMigrationPlan({
      change,
      current: state.snapshot,
      ...(target !== undefined ? { target } : {}),
      ...(delta !== undefined ? { delta } : {}),
    });
    emit(
      report,
      flagBool(args, "json"),
      `${report.plan.status} ${report.plan.id}${report.plan.blockedReason === undefined ? "" : `: ${report.plan.blockedReason}`}`,
    );
    return 0;
  }

  info(CONTROL_HELP);
  return 2;
}

function planningContext(model: SemanticModel, change: ChangeContract): ChangePlanningContext {
  const nodes = new Map(model.nodes.map((node) => [node.id, node]));
  return {
    id: change.id,
    serves: [...new Set(change.serves)].sort(),
    preserves: [...new Set(change.preserves)].sort(),
    requiredEvidence: [...new Set(change.requiresEvidence)].sort().map((id) => {
      const evidence = nodes.get(id);
      const satisfied = evidence?.kind === "evidence" && PROVEN_STATUSES.has(evidence.status);
      return { id, status: satisfied ? "satisfied" as const : "unsatisfied" as const, satisfied, attestationIds: satisfied ? [id] : [] };
    }),
    openUnknowns: [...new Set(change.openUnknowns)].sort(),
  };
}
