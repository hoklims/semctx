import { compareCodeUnits } from "./ordering";
import { sha256HashCanonicalJson } from "./hashing";
import type { Sha256Hash } from "./types";
import {
  RECONCILIATION_INSUFFICIENCY_REASONS,
  RECONCILIATION_REFUSAL_REASONS,
  RECONCILIATION_VIOLATION_REASONS,
  type ObservationAnalysisV1,
  type PlanningBundleV1,
  type ReconcileDiffReportV1,
  type ReconciliationAnalysisV1,
  type ReconciliationReasonCodeV1,
  type SemanticChangeSetV1,
  type TaskEnvelopeV1,
  type TaskFrameSnapshotV1,
} from "./task-envelope-types";

const ENVELOPE_DOMAIN = "SEMCTX_TASK_ENVELOPE_V1\0";
const CHANGE_SET_DOMAIN = "SEMCTX_SEMANTIC_CHANGE_SET_V1\0";
const PLANNING_BUNDLE_DOMAIN = "SEMCTX_PLANNING_BUNDLE_V1\0";
const OBSERVATION_ANALYSIS_DOMAIN = "SEMCTX_OBSERVATION_ANALYSIS_V1\0";
const RECONCILE_REPORT_DOMAIN = "SEMCTX_RECONCILE_DIFF_REPORT_V1\0";
const RECONCILIATION_ANALYSIS_DOMAIN = "SEMCTX_RECONCILIATION_ANALYSIS_V1\0";
const RECONCILIATION_ARCHITECTURE_DELTA_DOMAIN =
  "SEMCTX_RECONCILIATION_ARCHITECTURE_DELTA_V1\0";
const TASK_FRAME_DOMAIN = "SEMCTX_TASK_FRAME_SNAPSHOT_V1\0";

export const RECONCILIATION_REASON_ORDER = [
  ...RECONCILIATION_REFUSAL_REASONS,
  ...RECONCILIATION_VIOLATION_REASONS,
  ...RECONCILIATION_INSUFFICIENCY_REASONS,
] as const;

export const RECONCILE_STATUS_PRECEDENCE = [
  "REFUSED",
  "VIOLATED",
  "UNPROVEN",
  "REALIZED",
] as const;

export function normalizeCanonicalRepoRelativePath(input: string): string {
  if (input.includes("\0")) throw new Error("repository-relative path cannot contain NUL");
  const slashed = input.replaceAll("\\", "/");
  if (
    slashed.length === 0
    || slashed.startsWith("/")
    || slashed.startsWith("//")
    || /^[A-Za-z]:/.test(slashed)
  ) throw new Error("path must be repository-relative");
  const rawSegments = slashed.split("/");
  if (rawSegments.some((segment) => segment === "" || segment === "..")) {
    throw new Error("path cannot contain empty or parent segments");
  }
  const segments = rawSegments.filter((segment) => segment !== ".");
  if (segments.length === 0) throw new Error("path must identify a repository entry");
  return segments.join("/");
}

export function canonicalizeReconciliationReasons(
  reasons: readonly ReconciliationReasonCodeV1[],
): readonly ReconciliationReasonCodeV1[] {
  return [...new Set(reasons)].sort(
    (left, right) =>
      RECONCILIATION_REASON_ORDER.indexOf(left) - RECONCILIATION_REASON_ORDER.indexOf(right),
  );
}

export function computeTaskFrameSnapshotV1Hash(value: TaskFrameSnapshotV1): Sha256Hash {
  return domainHash(TASK_FRAME_DOMAIN, normalizeTaskFrameSnapshotV1(value));
}

export function computeTaskEnvelopeV1Hash(
  value: Omit<TaskEnvelopeV1, "envelopeHash"> & { envelopeHash?: Sha256Hash },
): Sha256Hash {
  const { envelopeHash: _hash, ...payload } = normalizeTaskEnvelopeV1(value as TaskEnvelopeV1);
  return domainHash(ENVELOPE_DOMAIN, payload);
}

export function computeSemanticChangeSetV1Hash(
  value: Omit<SemanticChangeSetV1, "changeSetHash"> & { changeSetHash?: Sha256Hash },
): Sha256Hash {
  const { changeSetHash: _hash, ...payload } = normalizeSemanticChangeSetV1(value as SemanticChangeSetV1);
  return domainHash(CHANGE_SET_DOMAIN, payload);
}

export function computePlanningBundleV1Hash(
  value: Omit<PlanningBundleV1, "bundleHash"> & { bundleHash?: Sha256Hash },
): Sha256Hash {
  const { bundleHash: _hash, ...payload } = normalizePlanningBundleV1(value as PlanningBundleV1);
  return domainHash(PLANNING_BUNDLE_DOMAIN, payload);
}

export function computeObservationAnalysisV1Hash(
  value: Omit<ObservationAnalysisV1, "analysisHash"> & { analysisHash?: Sha256Hash },
): Sha256Hash {
  const { analysisHash: _hash, ...payload } = normalizeObservationAnalysisV1(value as ObservationAnalysisV1);
  return domainHash(OBSERVATION_ANALYSIS_DOMAIN, payload);
}

export function computeReconciliationObservedDiffV1Hash(
  changes: ObservationAnalysisV1["changes"],
  observedHunks: readonly { identity: Sha256Hash }[],
): Sha256Hash {
  return sha256HashCanonicalJson({
    domain: "SEMCTX_CANDIDATE_DIFF_V1",
    changes: normalizeObservationChanges(changes),
    observedHunkIds: sortedUnique(observedHunks.map((hunk) => hunk.identity)),
  });
}

export function computeReconcileDiffReportV1Hash(
  value: Omit<ReconcileDiffReportV1, "reportHash"> & { reportHash?: Sha256Hash },
): Sha256Hash {
  const { reportHash: _hash, ...payload } = normalizeReconcileDiffReportV1(value as ReconcileDiffReportV1);
  return domainHash(RECONCILE_REPORT_DOMAIN, payload);
}

export function computeReconciliationAnalysisV1Hash(
  value: Omit<ReconciliationAnalysisV1, "analysisHash"> & { analysisHash?: Sha256Hash },
): Sha256Hash {
  const { analysisHash: _hash, ...payload } = normalizeReconciliationAnalysisV1(
    value as ReconciliationAnalysisV1,
  );
  return domainHash(RECONCILIATION_ANALYSIS_DOMAIN, payload);
}

export function computeReconciliationArchitectureDeltaV1Hash(
  value: ReconciliationAnalysisV1["architectureDelta"],
): Sha256Hash {
  return domainHash(RECONCILIATION_ARCHITECTURE_DELTA_DOMAIN, normalizeArchitectureDelta(value));
}

export function normalizeTaskFrameSnapshotV1(value: TaskFrameSnapshotV1): TaskFrameSnapshotV1 {
  return {
    ...value,
    capabilitySignals: sortedUnique(value.capabilitySignals),
    riskSignals: sortedUnique(value.riskSignals),
    ...(value.descriptiveNonGoals === undefined
      ? {}
      : { descriptiveNonGoals: sortedUnique(value.descriptiveNonGoals) }),
  };
}

export function normalizeTaskEnvelopeV1(value: TaskEnvelopeV1): TaskEnvelopeV1 {
  return {
    ...value,
    taskFrameSnapshot: normalizeTaskFrameSnapshotV1(value.taskFrameSnapshot),
    candidateAnchors: [...value.candidateAnchors].sort((a, b) => compareCodeUnits(a.anchorId, b.anchorId)),
    resolvedBindings: [...value.resolvedBindings].map((binding) => ({
      ...binding,
      scope: binding.scope.kind === "coordinate_set"
        ? { ...binding.scope, coordinateIds: sortedUnique(binding.scope.coordinateIds) }
        : binding.scope,
    })).sort((a, b) => compareCodeUnits(a.bindingId, b.bindingId)),
    parentIntentIds: sortedUnique(value.parentIntentIds),
    preservedInvariantIds: sortedUnique(value.preservedInvariantIds),
    nonGoals: sortedUnique(value.nonGoals),
    expectedBehaviorDelta: sortedUnique(value.expectedBehaviorDelta),
    declaredReconciliationScope: value.declaredReconciliationScope.kind === "coordinate_set"
      ? {
          ...value.declaredReconciliationScope,
          bindingIds: sortedUnique(value.declaredReconciliationScope.bindingIds),
          coordinateIds: sortedUnique(value.declaredReconciliationScope.coordinateIds),
          ...(value.declaredReconciliationScope.filePaths === undefined
            ? {}
            : { filePaths: sortedUnique(value.declaredReconciliationScope.filePaths) }),
        }
      : value.declaredReconciliationScope,
    proofObligationIds: sortedUnique(value.proofObligationIds),
    compatibilityNotes: sortedUnique(value.compatibilityNotes),
  };
}

export function normalizeSemanticChangeSetV1(value: SemanticChangeSetV1): SemanticChangeSetV1 {
  return {
    ...value,
    declaredReconciliationScope: value.declaredReconciliationScope.kind === "coordinate_set"
      ? {
          ...value.declaredReconciliationScope,
          bindingIds: sortedUnique(value.declaredReconciliationScope.bindingIds),
          coordinateIds: sortedUnique(value.declaredReconciliationScope.coordinateIds),
          ...(value.declaredReconciliationScope.filePaths === undefined
            ? {}
            : { filePaths: sortedUnique(value.declaredReconciliationScope.filePaths) }),
        }
      : value.declaredReconciliationScope,
    refinementSteps: [...value.refinementSteps].map((step) => ({
      ...step,
      fromExpectationIds: sortedUnique(step.fromExpectationIds),
      toExpectationIds: sortedUnique(step.toExpectationIds),
      repositoryEditIds: sortedUnique(step.repositoryEditIds),
    })).sort((a, b) => a.order - b.order || compareCodeUnits(a.stepId, b.stepId)),
    semanticExpectations: [...value.semanticExpectations].map((expectation) => ({
      ...expectation,
      acceptanceEvidenceIds: sortedUnique(expectation.acceptanceEvidenceIds),
    })).sort((a, b) => compareCodeUnits(a.expectationId, b.expectationId)),
    repositoryEditExpectations: [...value.repositoryEditExpectations].map((edit) => ({
      ...edit,
      ...("coordinateIds" in edit ? { coordinateIds: sortedUnique(edit.coordinateIds) } : {}),
      expectedLiftedExpectationIds: sortedUnique(edit.expectedLiftedExpectationIds),
      acceptanceEvidenceIds: sortedUnique(edit.acceptanceEvidenceIds),
    })).sort((a, b) => compareCodeUnits(a.editId, b.editId)),
    testReferences: sortedUnique(value.testReferences),
    acceptanceEvidenceIds: sortedUnique(value.acceptanceEvidenceIds),
    proofObligationIds: sortedUnique(value.proofObligationIds),
  };
}

export function normalizePlanningBundleV1(value: PlanningBundleV1): PlanningBundleV1 {
  return {
    ...value,
    taskEnvelope: normalizeTaskEnvelopeV1(value.taskEnvelope),
    semanticChangeSet: normalizeSemanticChangeSetV1(value.semanticChangeSet),
  };
}

export function normalizeObservationAnalysisV1(value: ObservationAnalysisV1): ObservationAnalysisV1 {
  return {
    ...value,
    changes: normalizeObservationChanges(value.changes),
    incompleteReasons: sortedUnique(value.incompleteReasons),
  };
}

function normalizeObservationChanges(
  changes: ObservationAnalysisV1["changes"],
): ObservationAnalysisV1["changes"] {
  return [...changes].sort((left, right) =>
    compareCodeUnits(observationPath(left), observationPath(right))
    || compareCodeUnits(left.kind, right.kind)
  );
}

export function normalizeReconciliationAnalysisV1(
  value: ReconciliationAnalysisV1,
): ReconciliationAnalysisV1 {
  return {
    ...value,
    observationAnalysis: normalizeObservationAnalysisV1(value.observationAnalysis),
    observedHunks: [...value.observedHunks].sort((a, b) =>
      compareCodeUnits(a.identity, b.identity)
    ),
    hunkBindings: [...value.hunkBindings].map((binding) => ({
      ...binding,
      coordinateIds: sortedUnique(binding.coordinateIds),
      editIds: sortedUnique(binding.editIds),
    })).sort((a, b) => compareCodeUnits(a.hunkId, b.hunkId)),
    architectureDelta: normalizeArchitectureDelta(value.architectureDelta),
    liftedImpacts: [...value.liftedImpacts].map((impact) => ({
      ...impact,
      expectationIds: sortedUnique(impact.expectationIds),
      semanticSubjectIds: sortedUnique(impact.semanticSubjectIds),
    })).sort((a, b) => compareCodeUnits(a.hunkId, b.hunkId)),
    evidenceInputs: [...value.evidenceInputs].map((evidence) => ({
      ...evidence,
      ...(evidence.acceptedAttestationDigests === undefined
        ? {}
        : { acceptedAttestationDigests: sortedUnique(evidence.acceptedAttestationDigests) }),
      provenance: sortedUnique(evidence.provenance),
    })).sort((a, b) => compareCodeUnits(a.requirementId, b.requirementId)),
    evidenceEvaluations: [...value.evidenceEvaluations].map((evaluation) => ({
      ...evaluation,
      acceptedAttestationDigests: sortedUnique(evaluation.acceptedAttestationDigests),
      provenance: sortedUnique(evaluation.provenance),
    })).sort((a, b) => compareCodeUnits(a.requirementId, b.requirementId)),
    roundTripCoverages: [...value.roundTripCoverages].map((coverage) => ({
      ...coverage,
      steps: coverage.steps.map((step) => ({
        ...step,
        evidenceDigests: sortedUnique(step.evidenceDigests),
      })),
      terminalCoordinateIds: sortedUnique(coverage.terminalCoordinateIds),
      observedHunkIds: sortedUnique(coverage.observedHunkIds),
      evidenceIds: sortedUnique(coverage.evidenceIds),
    })).sort((a, b) =>
      compareCodeUnits(a.expectationId, b.expectationId)
      || compareCodeUnits(a.editId, b.editId)
    ),
    ...(value.targetAnalysis === undefined ? {} : {
      targetAnalysis: {
        ...value.targetAnalysis,
        reviewAttestationDigests: sortedUnique(
          value.targetAnalysis.reviewAttestationDigests,
        ),
        findings: [...value.targetAnalysis.findings].map((finding) => ({
          ...finding,
          evidenceIds: sortedUnique(finding.evidenceIds),
        })).sort((a, b) => compareCodeUnits(a.targetElementId, b.targetElementId)),
      },
    }),
    advisoryDiagnostics: [...value.advisoryDiagnostics].map((diagnostic) => ({
      ...diagnostic,
      subjectIds: sortedUnique(diagnostic.subjectIds),
    })).sort((a, b) =>
      compareCodeUnits(a.code, b.code)
      || compareCodeUnits(a.message, b.message)
    ),
  };
}

function normalizeArchitectureDelta(
  value: ReconciliationAnalysisV1["architectureDelta"],
): ReconciliationAnalysisV1["architectureDelta"] {
  return {
    ...value,
    added: [...value.added].sort((a, b) => compareCodeUnits(a.id, b.id)),
    removed: [...value.removed].sort((a, b) => compareCodeUnits(a.id, b.id)),
    changed: [...value.changed].sort((a, b) => compareCodeUnits(a.id, b.id)),
    addedRelations: [...value.addedRelations].sort(compareArchitectureRelation),
    removedRelations: [...value.removedRelations].sort(compareArchitectureRelation),
    changedRelations: [...value.changedRelations]
      .sort((a, b) => compareCodeUnits(a.key, b.key)),
    changedInvariantIds: sortedUnique(value.changedInvariantIds),
  };
}

export function normalizeReconcileDiffReportV1(value: ReconcileDiffReportV1): ReconcileDiffReportV1 {
  return {
    ...value,
    reasonCodes: canonicalizeReconciliationReasons(value.reasonCodes),
    requiredPlannedEditIds: sortedUnique(value.requiredPlannedEditIds),
    matchedPlannedEdits: [...value.matchedPlannedEdits].map((match) => ({
      ...match,
      observedHunkIds: sortedUnique(match.observedHunkIds),
    })).sort((a, b) => compareCodeUnits(a.editId, b.editId)),
    missingPlannedEditIds: sortedUnique(value.missingPlannedEditIds),
    observedHunkIds: sortedUnique(value.observedHunkIds),
    unplannedCoordinateIds: sortedUnique(value.unplannedCoordinateIds),
    scopeEscapes: [...value.scopeEscapes].sort((a, b) =>
      compareCodeUnits(a.path, b.path)
      || compareCodeUnits(a.coordinateId ?? "", b.coordinateId ?? "")
    ),
    invariantDriftIds: sortedUnique(value.invariantDriftIds),
    undeclaredLiftedExpectationIds: sortedUnique(value.undeclaredLiftedExpectationIds),
    requiredTargetElementIds: sortedUnique(value.requiredTargetElementIds),
    targetRealizationFindings: [...value.targetRealizationFindings].map((finding) => ({
      ...finding,
      evidenceIds: sortedUnique(finding.evidenceIds),
    })).sort((a, b) => compareCodeUnits(a.targetElementId, b.targetElementId)),
    evidenceEvaluations: [...value.evidenceEvaluations].map((evaluation) => ({
      ...evaluation,
      acceptedAttestationDigests: sortedUnique(evaluation.acceptedAttestationDigests),
      provenance: sortedUnique(evaluation.provenance),
    })).sort((a, b) =>
      compareCodeUnits(a.requirementId, b.requirementId)
      || compareCodeUnits(a.origin, b.origin)
    ),
    requiredEvidenceRequirementIds: sortedUnique(value.requiredEvidenceRequirementIds),
    certifiedRoundTrips: [...value.certifiedRoundTrips].map((roundTrip) => ({
      ...roundTrip,
      coordinateIds: sortedUnique(roundTrip.coordinateIds),
      evidenceIds: sortedUnique(roundTrip.evidenceIds),
    })).sort((a, b) => compareCodeUnits(a.expectationId, b.expectationId)),
    requiredRoundTripExpectationIds: sortedUnique(value.requiredRoundTripExpectationIds),
    advisoryDiagnostics: [...value.advisoryDiagnostics].map((diagnostic) => ({
      ...diagnostic,
      subjectIds: sortedUnique(diagnostic.subjectIds),
    })).sort((a, b) =>
      compareCodeUnits(a.code, b.code)
      || compareCodeUnits(a.message, b.message)
    ),
    secondaryInsufficiencies: canonicalizeReconciliationReasons(
      value.secondaryInsufficiencies,
    ) as typeof value.secondaryInsufficiencies,
  };
}

function observationPath(change: ObservationAnalysisV1["changes"][number]): string {
  return change.kind === "add" ? change.newPath : change.kind === "modify" ? change.path : change.oldPath;
}

function compareArchitectureRelation(
  left: { from: string; to: string; relation: string },
  right: { from: string; to: string; relation: string },
): number {
  return compareCodeUnits(left.from, right.from)
    || compareCodeUnits(left.to, right.to)
    || compareCodeUnits(left.relation, right.relation);
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function domainHash(domain: string, value: unknown): Sha256Hash {
  return sha256HashCanonicalJson({ domain, value });
}
