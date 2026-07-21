import { compareIds, SemctxError } from "@semantic-context/core";
import {
  type ArchitectureDelta,
  type ArchitectureSnapshot,
  type ChangePlanningContext,
  type ControlFreshnessSeal,
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
import { loadConfig } from "@semantic-context/repository-store";
import { discoverFiles } from "@semantic-context/ts-analyzer";
import {
  CONTROL_INDEX_SNAPSHOT_META_KEY,
  buildControlFreshnessSeal,
  canonicalRepositoryRoot,
  captureGitState,
  fingerprintAnalysisInputs,
  fingerprintSemanticModel,
  parseIndexedControlSnapshot,
} from "./freshness";
import { openReadyRepository } from "./readiness";

export interface CurrentControlState {
  graph: ReturnType<typeof buildCoordinateGraph>;
  snapshot: ArchitectureSnapshot;
  freshnessSeal: ControlFreshnessSeal;
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
    const gitBefore = captureGitState(root);
    const configBefore = loadConfig(root);
    const analysisInputHash = fingerprintAnalysisInputs(configBefore, discoverFiles(configBefore));
    const semanticBefore = loadSemanticModel(root);
    const errors = semanticBefore.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0 || semanticBefore.duplicateIds.length > 0) {
      throw new SemctxError("CONFIG_INVALID", "semantic model cannot be projected into Plane C", {
        diagnostics: errors,
        duplicateIds: semanticBefore.duplicateIds,
      });
    }
    const repositoryGraph = reader.loadGraph();
    const graph = buildCoordinateGraph({ repositoryGraph, semanticModel: semanticBefore.model });
    const configAfter = loadConfig(root);
    const analysisInputHashAfter = fingerprintAnalysisInputs(configAfter, discoverFiles(configAfter));
    const semanticAfter = loadSemanticModel(root);
    const semanticModelHash = fingerprintSemanticModel(semanticBefore.model);
    const semanticModelHashAfter = fingerprintSemanticModel(semanticAfter.model);
    const gitAfter = captureGitState(root);
    if (
      gitBefore.headCommit !== gitAfter.headCommit
      || gitBefore.workingDiffHash !== gitAfter.workingDiffHash
      || analysisInputHash !== analysisInputHashAfter
      || semanticModelHash !== semanticModelHashAfter
    ) {
      throw new SemctxError("GIT_ERROR", "repository inputs changed while Plane C captured its state", {
        before: gitBefore,
        after: gitAfter,
        analysisInputHash,
        analysisInputHashAfter,
        semanticModelHash,
        semanticModelHashAfter,
      });
    }
    const fingerprint = fingerprintCoordinateGraph(graph);
    const indexedSnapshot = parseIndexedControlSnapshot(reader.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY));
    const capturedAt = indexedSnapshot?.capturedAt
      ?? reader.getMeta("indexed_at")
      ?? "1970-01-01T00:00:00.000Z";
    const schemaVersion = Number.parseInt(reader.getMeta("schema_version") ?? "", 10);
    const freshnessSeal = buildControlFreshnessSeal({
      repositoryRoot: canonicalRepositoryRoot(root),
      headAtCapture: gitAfter.headCommit,
      repositoryGraph,
      semanticModel: semanticAfter.model,
      analysisInputHash: analysisInputHashAfter,
      workingDiffHash: gitAfter.workingDiffHash,
      indexedSnapshot,
      storeSchemaVersion: Number.isSafeInteger(schemaVersion) && schemaVersion >= 0 ? schemaVersion : null,
    });
    const commit = indexedSnapshot?.headCommit === null || indexedSnapshot === null
      ? "unsealed"
      : `git:${indexedSnapshot.headCommit}`;
    return {
      graph,
      snapshot: snapshotArchitecture(graph, { id: `current:${fingerprint}`, commit, capturedAt }),
      freshnessSeal,
      changeIds: semanticAfter.model.changes.map((change) => change.id).sort(),
      planningContexts: semanticAfter.model.changes.map((change) => planningContext(semanticAfter.model, change)).sort((a, b) => compareIds(a.id, b.id)),
    };
  } finally {
    reader.close();
  }
}

export function traceControl(root: string, command: ControlTraceCommand): TraversalReport {
  const direction = command.direction ?? "lift";
  const targetLevel = command.targetLevel ?? (direction === "lift" ? 6 : 0);
  const state = loadControlState(root);
  const bounds = {
    ...(command.maxDepth !== undefined ? { maxDepth: command.maxDepth } : {}),
    ...(command.maxResults !== undefined ? { maxResults: command.maxResults } : {}),
  };
  const report = direction === "lift"
    ? lift(state.graph, command.sourceId, targetLevel, bounds)
    : lower(state.graph, command.sourceId, targetLevel, bounds);
  return { ...report, freshnessSeal: state.freshnessSeal };
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
  const report = compileMigrationPlan({
    change,
    current: state.snapshot,
    ...(command.target !== undefined ? { target: command.target } : {}),
    ...(command.delta !== undefined ? { delta: command.delta } : {}),
  });
  return { ...report, freshnessSeal: state.freshnessSeal };
}
