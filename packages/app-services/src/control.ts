import { compareIds, isSemctxError, SemctxError, type EvidenceRecord } from "@semantic-context/core";
import {
  type ArchitectureDelta,
  type ArchitectureSnapshot,
  type ChangePlanningContext,
  type ControlFreshnessSeal,
  type ControlFreshnessSealV2,
  type ControlFreshnessStatusReport,
  type MigrationPlanReport,
  type ObservedDiffHunkV1,
  type QualifiedCoordinateId,
  type SemanticLevel,
  type TraversalDirection,
  type TraversalReportV2,
  type ControlQueryEnvelopeV1,
  type SealedAttestationIndexV1,
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
  evaluateControlFreshness,
  fingerprintAnalysisInputs,
  fingerprintSemanticModel,
  parseIndexedControlSnapshot,
  unsealedControlStatus,
} from "./freshness";
import {
  CONTROL_OBSERVED_HUNK_INDEX_META_KEY,
  materializeReferencedObservedHunks,
  observedHunksFromIndex,
  parseObservedHunkIndex,
  resolveVerifiedRelationEvidence,
} from "./control-evidence";
import { openReadyRepository } from "./readiness";
import { inspectSemanticLifecycle } from "./semantic-check";
import {
  CONTROL_ATTESTATION_INDEX_META_KEY,
  architectureComparisonQuery,
  bindControlFreshnessSealV2,
  coordinateGraphQuery,
  deletionAuthorizationQuery,
  explanationQuery,
  impactQuery,
  parseSealedAttestationIndex,
  refinementCoverageQuery,
  stepAuthorizationQuery,
  transitionAuthorizationQuery,
  traversalQuery,
  type ControlQueryRuntime,
  type DeletionAuthorizationQueryV1,
  type ExplanationQueryV1,
  type ImpactQueryV1,
  type RefinementCoverageQueryV1,
  type StepAuthorizationQueryV1,
  type TransitionAuthorizationQueryV1,
  type TraversalQueryV1,
} from "./control-queries";

export interface CurrentControlState {
  graph: ReturnType<typeof buildCoordinateGraph>;
  snapshot: ArchitectureSnapshot;
  freshnessSeal: ControlFreshnessSeal;
  queryFreshnessSeal: ControlFreshnessSealV2;
  freshnessStatus: ControlFreshnessStatusReport;
  sealedAttestationIndex: SealedAttestationIndexV1 | null;
  sealedEvidence: EvidenceRecord[];
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
    const lifecycleBefore = inspectSemanticLifecycle(root, semanticBefore.model.changes);
    const errors = semanticBefore.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    const lifecycleErrors = lifecycleBefore.filter((finding) => finding.severity === "error");
    if (errors.length > 0 || semanticBefore.duplicateIds.length > 0 || lifecycleErrors.length > 0) {
      throw new SemctxError("CONFIG_INVALID", "semantic model cannot be projected into Plane C", {
        diagnostics: errors,
        duplicateIds: semanticBefore.duplicateIds,
        lifecycleFindings: lifecycleErrors,
      });
    }
    const indexedEvidence = reader.loadEvidence();
    const repositoryFacts = {
      graph: reader.loadGraph(),
      claims: reader.loadClaims(),
      evidence: indexedEvidence,
    };
    const indexedSnapshot = parseIndexedControlSnapshot(reader.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY));
    let observedHunks: ObservedDiffHunkV1[] = [];
    if (indexedSnapshot?.schemaVersion === 2) {
      const observedIndex = parseObservedHunkIndex(reader.getMeta(CONTROL_OBSERVED_HUNK_INDEX_META_KEY));
      if (
        observedIndex === null
        || observedIndex.indexHash !== indexedSnapshot.observedHunkIndexHash
        || observedIndex.workingDiffHash !== indexedSnapshot.workingDiffHash
      ) {
        throw new SemctxError("STORE_ERROR", "invalid persisted control observed hunk index");
      }
      observedHunks = materializeReferencedObservedHunks(
        root,
        observedIndex.repositoryIdentity,
        semanticBefore.model,
        observedHunksFromIndex(observedIndex),
      );
    }
    const verifiedEvidenceDigests = resolveVerifiedRelationEvidence(
      root,
      semanticBefore.model,
      observedHunks,
      gitBefore.headCommit,
    );
    const graph = buildCoordinateGraph({
      repositoryFacts,
      semanticModel: semanticBefore.model,
      observedHunks,
      verifiedEvidenceDigests,
    });
    const configAfter = loadConfig(root);
    const analysisInputHashAfter = fingerprintAnalysisInputs(configAfter, discoverFiles(configAfter));
    const semanticAfter = loadSemanticModel(root);
    const lifecycleAfter = inspectSemanticLifecycle(root, semanticAfter.model.changes);
    const semanticModelHash = fingerprintSemanticModel(semanticBefore.model);
    const semanticModelHashAfter = fingerprintSemanticModel(semanticAfter.model);
    const gitAfter = captureGitState(root);
    if (
      gitBefore.headCommit !== gitAfter.headCommit
      || gitBefore.workingDiffHash !== gitAfter.workingDiffHash
      || analysisInputHash !== analysisInputHashAfter
      || semanticModelHash !== semanticModelHashAfter
      || JSON.stringify(lifecycleBefore) !== JSON.stringify(lifecycleAfter)
    ) {
      throw new SemctxError("GIT_ERROR", "repository inputs changed while Plane C captured its state", {
        before: gitBefore,
        after: gitAfter,
        analysisInputHash,
        analysisInputHashAfter,
        semanticModelHash,
        semanticModelHashAfter,
        lifecycleBefore,
        lifecycleAfter,
      });
    }
    const fingerprint = fingerprintCoordinateGraph(graph);
    const capturedAt = indexedSnapshot?.capturedAt
      ?? reader.getMeta("indexed_at")
      ?? "1970-01-01T00:00:00.000Z";
    const schemaVersion = Number.parseInt(reader.getMeta("schema_version") ?? "", 10);
    const freshnessSeal = buildControlFreshnessSeal({
      repositoryRoot: canonicalRepositoryRoot(root),
      headAtCapture: gitAfter.headCommit,
      repositoryFacts,
      semanticModel: semanticAfter.model,
      analysisInputHash: analysisInputHashAfter,
      workingDiffHash: gitAfter.workingDiffHash,
      indexedSnapshot,
      storeSchemaVersion: Number.isSafeInteger(schemaVersion) && schemaVersion >= 0 ? schemaVersion : null,
    });
    const freshnessStatus = evaluateControlFreshness(freshnessSeal);
    const sealedAttestationIndex = parseSealedAttestationIndex(reader.getMeta(CONTROL_ATTESTATION_INDEX_META_KEY));
    const queryFreshnessSeal = bindControlFreshnessSealV2(
      freshnessSeal,
      indexedSnapshot?.schemaVersion === 2 ? indexedSnapshot.attestationSetHash : null,
    );
    const commit = indexedSnapshot?.headCommit === null || indexedSnapshot === null
      ? "unsealed"
      : `git:${indexedSnapshot.headCommit}`;
    return {
      graph,
      snapshot: snapshotArchitecture(graph, { id: `current:${fingerprint}`, commit, capturedAt }),
      freshnessSeal,
      queryFreshnessSeal,
      freshnessStatus,
      sealedAttestationIndex,
      sealedEvidence: [...indexedEvidence].sort((left, right) => compareIds(left.id, right.id)),
      changeIds: semanticAfter.model.changes.map((change) => change.id).sort(),
      planningContexts: semanticAfter.model.changes.map((change) => planningContext(semanticAfter.model, change)).sort((a, b) => compareIds(a.id, b.id)),
    };
  } finally {
    reader.close();
  }
}

export function loadControlQueryRuntime(root: string): ControlQueryRuntime {
  try {
    const state = loadControlState(root);
    return {
      graph: state.graph,
      freshnessStatus: state.freshnessStatus,
      freshnessSeal: state.queryFreshnessSeal,
      currentArchitecture: state.snapshot,
      sealedAttestationIndex: state.sealedAttestationIndex,
      sealedEvidence: state.sealedEvidence,
    };
  } catch (error) {
    const status = unavailableStatus(error);
    if (status === null) throw error;
    return {
      graph: {
        schemaVersion: 2,
        nodes: [],
        structuralEdges: [],
        refinementRelations: [],
        mapping: [],
        coverage: [],
        unsupported: [],
        unmapped: [],
        staleLinks: [],
        danglingReferences: [],
        compatibilityNormalization: [],
        verifiedEvidenceDigests: [],
      },
      freshnessStatus: status,
      freshnessSeal: null,
      currentArchitecture: {
        id: "current:unsealed",
        commit: "unsealed",
        capturedAt: "1970-01-01T00:00:00.000Z",
        elements: [],
        relations: [],
      },
      sealedAttestationIndex: null,
      sealedEvidence: [],
    };
  }
}

export function controlStatus(root: string): ControlFreshnessStatusReport {
  try {
    return loadControlState(root).freshnessStatus;
  } catch (error) {
    const unavailable = unavailableStatus(error);
    if (unavailable !== null) return unavailable;
    throw error;
  }
}

/** Return an exact control seal only when the current repository state proves it safe.
 * Optional derived providers degrade to unsealed diagnostics when control capture is unavailable. */
export function trustedControlSealHash(root: string): string | undefined {
  try {
    const status = controlStatus(root);
    return status.canRunHighRiskControl ? status.freshnessSeal?.sealHash : undefined;
  } catch {
    return undefined;
  }
}

function unavailableStatus(error: unknown): ControlFreshnessStatusReport | null {
  if (!isSemctxError(error)) return null;
  if (error.code === "CONFIG_NOT_FOUND") return unsealedControlStatus("REPOSITORY_NOT_INITIALIZED");
  if (error.code === "REPO_NOT_INDEXED") return unsealedControlStatus("REPOSITORY_NOT_INDEXED");
  if (
    error.code === "STORE_ERROR"
    && (
      error.message === "invalid persisted control index snapshot"
      || error.message === "invalid persisted control observed hunk index"
    )
  ) {
    return unsealedControlStatus("INDEX_SNAPSHOT_INVALID");
  }
  return null;
}

function assertFreshControlInputs(status: ControlFreshnessStatusReport): void {
  if (status.canRunHighRiskControl) return;
  throw new SemctxError(
    "CONTROL_INPUTS_UNSAFE",
    `control inputs are ${status.verdict}; run 'semctx index' before traversal`,
    { verdict: status.verdict, reasons: status.reasons },
  );
}

export function traceControl(root: string, command: ControlTraceCommand): TraversalReportV2 {
  const direction = command.direction ?? "lift";
  const targetLevel = command.targetLevel ?? (direction === "lift" ? 6 : 0);
  const state = loadControlState(root);
  assertFreshControlInputs(state.freshnessStatus);
  const bounds = {
    ...(command.maxDepth !== undefined ? { maxDepth: command.maxDepth } : {}),
    ...(command.maxResults !== undefined ? { maxResults: command.maxResults } : {}),
  };
  const report = direction === "lift"
    ? lift(state.graph, command.sourceId, targetLevel, bounds)
    : lower(state.graph, command.sourceId, targetLevel, bounds);
  return { ...report, freshnessSeal: state.queryFreshnessSeal };
}

export function queryControlGraph(root: string): Extract<ControlQueryEnvelopeV1, { kind: "coordinate_graph" }> {
  return coordinateGraphQuery(loadControlQueryRuntime(root));
}

export function queryControlTraversal(
  root: string,
  command: TraversalQueryV1,
): Extract<ControlQueryEnvelopeV1, { kind: "traversal" }> {
  return traversalQuery(loadControlQueryRuntime(root), command);
}

export function queryControlRefinementCoverage(
  root: string,
  command: RefinementCoverageQueryV1,
): Extract<ControlQueryEnvelopeV1, { kind: "refinement_coverage" }> {
  return refinementCoverageQuery(loadControlQueryRuntime(root), command);
}

export function queryControlImpact(
  root: string,
  command: ImpactQueryV1,
): Extract<ControlQueryEnvelopeV1, { kind: "impact" }> {
  return impactQuery(loadControlQueryRuntime(root), command);
}

export function queryControlExplanation(
  root: string,
  command: ExplanationQueryV1,
): Extract<ControlQueryEnvelopeV1, { kind: "explanation" }> {
  return explanationQuery(loadControlQueryRuntime(root), command);
}

export function queryControlArchitectureComparison(
  root: string,
  target: ArchitectureSnapshot,
): Extract<ControlQueryEnvelopeV1, { kind: "architecture_comparison" }> {
  return architectureComparisonQuery(loadControlQueryRuntime(root), target);
}

export function queryControlTransitionAuthorization(
  root: string,
  command: TransitionAuthorizationQueryV1,
): Extract<ControlQueryEnvelopeV1, { kind: "authorize_transition" }> {
  return transitionAuthorizationQuery(loadControlQueryRuntime(root), command);
}

export function queryControlStepAuthorization(
  root: string,
  command: StepAuthorizationQueryV1,
): Extract<ControlQueryEnvelopeV1, { kind: "authorize_step" }> {
  return stepAuthorizationQuery(loadControlQueryRuntime(root), command);
}

export function queryControlDeletionAuthorization(
  root: string,
  command: DeletionAuthorizationQueryV1,
): Extract<ControlQueryEnvelopeV1, { kind: "authorize_deletion" }> {
  return deletionAuthorizationQuery(loadControlQueryRuntime(root), command);
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
  if (!state.freshnessStatus.canRunHighRiskControl) {
    const blockedReason = state.freshnessStatus.verdict === "STALE"
      ? "control_inputs_stale" as const
      : "control_inputs_unsealed" as const;
    return {
      schemaVersion: 1,
      plan: {
        id: `migration:${change.id}:${state.snapshot.id}->freshness-blocked`,
        changeId: change.id,
        planningCommit: state.snapshot.commit,
        status: "BLOCKED",
        blockedReason,
        blockedDetails: [{
          schemaVersion: 1,
          reason: blockedReason,
          subjectIds: [...state.freshnessStatus.reasons],
          message: `Control inputs are ${state.freshnessStatus.verdict}; rebuild the index before migration planning.`,
        }],
        planningContext: change,
        current: state.snapshot,
        steps: [],
        outstandingObligations: [],
      },
      freshnessSeal: state.freshnessSeal,
      freshnessStatus: state.freshnessStatus,
    };
  }
  const report = compileMigrationPlan({
    change,
    current: state.snapshot,
    ...(command.target !== undefined ? { target: command.target } : {}),
    ...(command.delta !== undefined ? { delta: command.delta } : {}),
  });
  return { ...report, freshnessSeal: state.freshnessSeal, freshnessStatus: state.freshnessStatus };
}
