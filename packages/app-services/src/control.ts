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
import { loadSemanticModel } from "@semantic-context/semantic-engine";
import { PROVEN_STATUSES, type ChangeContract, type SemanticModel } from "@semantic-context/semantic-model";
import { openReadyRepository } from "./readiness";

export interface CurrentControlState {
  graph: ReturnType<typeof buildCoordinateGraph>;
  snapshot: ArchitectureSnapshot;
  changeIds: string[];
  planningContexts: ChangePlanningContext[];
}

export interface ControlTraceCommand {
  sourceId: QualifiedCoordinateId;
  targetLevel?: SemanticLevel;
  direction?: TraversalDirection;
  maxDepth?: number;
  maxResults?: number;
}

export interface ControlPlanCommand {
  changeId: string;
  target?: ArchitectureSnapshot;
  delta?: ArchitectureDelta;
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
      return { id, status: satisfied ? "satisfied" : "unsatisfied", satisfied, attestationIds: satisfied ? [id] : [] };
    }),
    openUnknowns: [...new Set(change.openUnknowns)].sort(),
  };
}

/** Load Plane A+B through the read-only store without creating or mutating repository state. */
export function loadControlState(root: string): CurrentControlState {
  const reader = openReadyRepository(root);
  try {
    const semantic = loadSemanticModel(root);
    const errors = semantic.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0 || semantic.duplicateIds.length > 0) {
      throw new SemctxError("CONFIG_INVALID", "semantic model cannot be projected into Plane C", {
        diagnostics: errors,
        duplicateIds: semantic.duplicateIds,
      });
    }
    const graph = buildCoordinateGraph({ repositoryGraph: reader.loadGraph(), semanticModel: semantic.model });
    const capturedAt = reader.getMeta("indexed_at") ?? "1970-01-01T00:00:00.000Z";
    const fingerprint = fingerprintCoordinateGraph(graph);
    const indexedCommit = reader.getMeta("indexed_commit");
    const commit = indexedCommit === undefined ? `graph:${fingerprint}` : `git:${indexedCommit}:graph:${fingerprint}`;
    return {
      graph,
      snapshot: snapshotArchitecture(graph, { id: `current:${fingerprint}`, commit, capturedAt }),
      changeIds: semantic.model.changes.map((change) => change.id).sort(),
      planningContexts: semantic.model.changes.map((change) => planningContext(semantic.model, change)).sort((a, b) => compareIds(a.id, b.id)),
    };
  } finally {
    reader.close();
  }
}

export function traceControl(root: string, command: ControlTraceCommand): TraversalReport {
  const direction = command.direction ?? "lift";
  const targetLevel = command.targetLevel ?? (direction === "lift" ? 6 : 0);
  const graph = loadControlState(root).graph;
  const bounds = {
    ...(command.maxDepth !== undefined ? { maxDepth: command.maxDepth } : {}),
    ...(command.maxResults !== undefined ? { maxResults: command.maxResults } : {}),
  };
  return direction === "lift"
    ? lift(graph, command.sourceId, targetLevel, bounds)
    : lower(graph, command.sourceId, targetLevel, bounds);
}

export function planControlMigration(root: string, command: ControlPlanCommand): MigrationPlanReport {
  if (command.delta !== undefined && command.target === undefined) {
    throw new SemctxError("INVALID_TASK_INPUT", "delta requires an explicit target architecture");
  }
  const state = loadControlState(root);
  const change = state.planningContexts.find((candidate) => candidate.id === command.changeId);
  if (change === undefined) {
    throw new SemctxError("INVALID_TASK_INPUT", `change contract not found: ${command.changeId}`, { changeId: command.changeId });
  }
  return compileMigrationPlan({
    change,
    current: state.snapshot,
    ...(command.target !== undefined ? { target: command.target } : {}),
    ...(command.delta !== undefined ? { delta: command.delta } : {}),
  });
}
