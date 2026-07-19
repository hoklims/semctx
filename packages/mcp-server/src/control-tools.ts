/** Read-only Plane C MCP handlers. They never open the writable repository store. */

import { compareIds, SemctxError } from "@semantic-context/core";
import {
  type ArchitectureDelta,
  type ArchitectureSnapshot,
  type ChangePlanningContext,
  type MigrationPlanReport,
  type QualifiedCoordinateId,
  type SemanticLevel,
  type TraversalDirection,
  type TraversalReport,
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

export interface ControlTraceInput {
  sourceId: QualifiedCoordinateId;
  targetLevel?: SemanticLevel;
  direction?: TraversalDirection;
  maxDepth?: number;
  maxResults?: number;
}

export interface ControlPlanInput {
  changeId: string;
  target?: ArchitectureSnapshot;
  delta?: ArchitectureDelta;
}

function loadCurrent(root: string): {
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

/** semctx_control_trace: bounded lift/lower traversal over derived Plane C coordinates. */
export function controlTraceTool(root: string, input: ControlTraceInput): TraversalReport {
  const direction = input.direction ?? "lift";
  const targetLevel = input.targetLevel ?? (direction === "lift" ? 6 : 0);
  const graph = loadCurrent(root).graph;
  const bounds = {
    ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
    ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}),
  };
  return direction === "lift"
    ? lift(graph, input.sourceId, targetLevel, bounds)
    : lower(graph, input.sourceId, targetLevel, bounds);
}

/** semctx_control_plan: compile a fail-closed migration plan from explicit current/target architecture. */
export function controlPlanTool(root: string, input: ControlPlanInput): MigrationPlanReport {
  if (input.delta !== undefined && input.target === undefined) {
    throw new SemctxError("INVALID_TASK_INPUT", "delta requires a target architecture");
  }
  const state = loadCurrent(root);
  const change = state.planningContexts.find((context) => context.id === input.changeId);
  if (change === undefined) {
    throw new SemctxError("INVALID_TASK_INPUT", `change contract not found: ${input.changeId}`, { changeId: input.changeId });
  }
  return compileMigrationPlan({
    change,
    current: state.snapshot,
    ...(input.target !== undefined ? { target: input.target } : {}),
    ...(input.delta !== undefined ? { delta: input.delta } : {}),
  });
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
