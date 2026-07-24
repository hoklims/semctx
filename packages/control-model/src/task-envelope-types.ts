import type { ArchitectureDelta, ControlFreshnessVerdict, Sha256Hash } from "./types";
import type { ObservedDiffHunkV1 } from "./refinement";

export type TaskModeV1 =
  | "bugfix"
  | "feature"
  | "refactor"
  | "audit"
  | "performance"
  | "security"
  | "migration";

export type RefinementProfileV1 =
  | "local_patch"
  | "refactor"
  | "feature"
  | "redesign"
  | "migration";

export type TaskRiskV1 = "R0" | "R1" | "R2" | "R3";
export type CanonicalRepoRelativePath = string;

export interface TaskFrameSnapshotV1 {
  schemaVersion: 1;
  taskFrameId: string;
  rawTaskDigest: Sha256Hash;
  mode: TaskModeV1;
  createdAt: string;
  capabilitySignals: readonly string[];
  riskSignals: readonly string[];
  /**
   * Descriptive exclusions copied from the TaskFrame. They constrain intent
   * interpretation only and never create repository bindings or execution authority.
   */
  descriptiveNonGoals?: readonly string[];
  profileCandidate?: RefinementProfileV1;
  altitudeCandidate?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

export interface CandidateAnchorV1 {
  schemaVersion: 1;
  anchorId: string;
  kind: "path" | "symbol" | "coordinate" | "semantic_term";
  value: string;
  provenance: "task_text" | "authored_link" | "caller";
}

export type ResolvedBindingScopeV1 =
  | { kind: "exact_coordinate"; coordinateId: `repo:${string}` }
  | { kind: "file"; path: CanonicalRepoRelativePath }
  | { kind: "coordinate_set"; coordinateIds: readonly `repo:${string}`[] };

export interface ResolvedBindingV1 {
  schemaVersion: 1;
  bindingId: string;
  coordinateId: `repo:${string}`;
  repositoryPath: CanonicalRepoRelativePath;
  provenance: "authored_link" | "explicit_discovery";
  evidenceId: string;
  planningCommit: string;
  graphSeal: Sha256Hash;
  scope: ResolvedBindingScopeV1;
}

export type DeclaredReconciliationScopeV1 =
  | {
      kind: "exact_coordinate";
      bindingId: string;
      coordinateId: `repo:${string}`;
    }
  | {
      kind: "file";
      bindingId: string;
      path: CanonicalRepoRelativePath;
    }
  | {
      kind: "coordinate_set";
      bindingIds: readonly string[];
      coordinateIds: readonly `repo:${string}`[];
      /**
       * Exact file scopes proven by file bindings in bindingIds. Optional for
       * backward compatibility with pre-field schemaVersion 1 artifacts.
       */
      filePaths?: readonly CanonicalRepoRelativePath[];
    };

export interface TargetReferenceV1 {
  schemaVersion: 1;
  targetId: string;
  /** Positive safe integer. */
  revision: number;
  artifactHash: Sha256Hash;
}

export interface TaskEnvelopeV1 {
  schemaVersion: 1;
  kind: "task_envelope";
  executionAuthority: "none";
  envelopeId: string;
  envelopeHash: Sha256Hash;
  planningCommit: string;
  taskFrameSnapshot: TaskFrameSnapshotV1;
  taskFrameHash: Sha256Hash;
  changeId: string;
  changeContractHash: Sha256Hash;
  coordinateGraphSeal: Sha256Hash;
  indexSeal: Sha256Hash;
  baselineFreshnessSeal: Sha256Hash;
  profile: RefinementProfileV1;
  risk: TaskRiskV1;
  requiredAltitude: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  candidateAnchors: readonly CandidateAnchorV1[];
  resolvedBindings: readonly ResolvedBindingV1[];
  parentIntentIds: readonly string[];
  preservedInvariantIds: readonly string[];
  nonGoals: readonly string[];
  expectedBehaviorDelta: readonly string[];
  declaredReconciliationScope: DeclaredReconciliationScopeV1;
  proofObligationIds: readonly string[];
  authoredTargetBinding?: TargetReferenceV1;
  advisoryTargetRef?: TargetReferenceV1;
  compatibilityNotes: readonly string[];
}

export interface SemanticExpectationV1 {
  schemaVersion: 1;
  expectationId: string;
  kind: "behavior" | "capability" | "contract" | "invariant" | "goal" | "target_element";
  level: 2 | 3 | 4 | 5 | 6;
  required: boolean;
  subjectId: string;
  statement: string;
  acceptanceEvidenceIds: readonly string[];
}

interface RepositoryEditExpectationBaseV1 {
  schemaVersion: 1;
  editId: string;
  required: boolean;
  expectedLiftedExpectationIds: readonly string[];
  acceptanceEvidenceIds: readonly string[];
}

export type RepositoryEditExpectationV1 =
  | (RepositoryEditExpectationBaseV1 & {
      kind: "add";
      newPath: CanonicalRepoRelativePath;
    })
  | (RepositoryEditExpectationBaseV1 & {
      kind: "modify";
      path: CanonicalRepoRelativePath;
      coordinateIds: readonly `repo:${string}`[];
      oldRange?: { start: number; lines: number };
    })
  | (RepositoryEditExpectationBaseV1 & {
      kind: "delete";
      oldPath: CanonicalRepoRelativePath;
      coordinateIds: readonly `repo:${string}`[];
    })
  | (RepositoryEditExpectationBaseV1 & {
      kind: "rename";
      oldPath: CanonicalRepoRelativePath;
      newPath: CanonicalRepoRelativePath;
      coordinateIds: readonly `repo:${string}`[];
    });

export interface SemanticRefinementStepV1 {
  schemaVersion: 1;
  stepId: string;
  order: number;
  fromExpectationIds: readonly string[];
  toExpectationIds: readonly string[];
  repositoryEditIds: readonly string[];
}

export interface SemanticChangeSetV1 {
  schemaVersion: 1;
  kind: "semantic_change_set";
  executionAuthority: "none";
  changeSetId: string;
  changeSetHash: Sha256Hash;
  envelopeId: string;
  envelopeHash: Sha256Hash;
  planningCommit: string;
  profile: RefinementProfileV1;
  targetBinding?: TargetReferenceV1;
  declaredReconciliationScope: DeclaredReconciliationScopeV1;
  refinementSteps: readonly SemanticRefinementStepV1[];
  semanticExpectations: readonly SemanticExpectationV1[];
  repositoryEditExpectations: readonly RepositoryEditExpectationV1[];
  rollbackDescription: string;
  testReferences: readonly string[];
  acceptanceEvidenceIds: readonly string[];
  proofObligationIds: readonly string[];
}

export interface WorkspaceBaselineSnapshotV1 {
  schemaVersion: 1;
  kind: "workspace_baseline";
  planningCommit: string;
  cleanliness: Extract<ControlFreshnessVerdict, "FRESH" | "DIRTY_KNOWN">;
  freshnessSealHash: Sha256Hash;
  workingDiffHash: Sha256Hash;
  semanticModelHash: Sha256Hash;
  analyzerConfigHash: Sha256Hash;
  toolVersion: string;
  storeSchemaVersion: number;
  attestationSetHash: Sha256Hash | null;
}

export interface PlanningBundleV1 {
  schemaVersion: 1;
  kind: "planning_bundle";
  executionAuthority: "none";
  bundleId: string;
  bundleHash: Sha256Hash;
  planningCommit: string;
  taskEnvelope: TaskEnvelopeV1;
  semanticChangeSet: SemanticChangeSetV1;
  baseline: WorkspaceBaselineSnapshotV1;
  acceptedTargetBinding?: TargetReferenceV1;
}

export type ObservationChangeV1 =
  | {
      kind: "add";
      newPath: CanonicalRepoRelativePath;
      newSourceDigest: Sha256Hash;
    }
  | {
      kind: "modify";
      path: CanonicalRepoRelativePath;
      oldSourceDigest: Sha256Hash;
      newSourceDigest: Sha256Hash;
    }
  | {
      kind: "delete";
      oldPath: CanonicalRepoRelativePath;
      oldSourceDigest: Sha256Hash;
    }
  | {
      kind: "rename";
      oldPath: CanonicalRepoRelativePath;
      newPath: CanonicalRepoRelativePath;
      oldSourceDigest: Sha256Hash;
      newSourceDigest: Sha256Hash;
    };

export interface ObservationAnalysisV1 {
  schemaVersion: 1;
  kind: "observation_analysis";
  baselineSealHash: Sha256Hash;
  candidateDiffHash: Sha256Hash;
  analyzerConfigHash: Sha256Hash;
  toolVersion: string;
  changes: readonly ObservationChangeV1[];
  candidateGraphHash: Sha256Hash;
  candidateArchitectureHash: Sha256Hash;
  completeness: "complete" | "partial";
  incompleteReasons: readonly string[];
  analysisHash: Sha256Hash;
}

export type EvidenceRequirementOriginV1 =
  | "change_contract"
  | "semantic_expectation"
  | "repository_edit_expectation"
  | "proof_obligation";

export interface EvidenceEvaluationV1 {
  schemaVersion: 1;
  requirementId: string;
  origin: EvidenceRequirementOriginV1;
  required: boolean;
  evidenceId: string | null;
  semanticEvidenceDigest?: Sha256Hash;
  acceptedAttestationDigests: readonly Sha256Hash[];
  planningCommit: string;
  observedDiffHash: Sha256Hash;
  semanticModelHash: Sha256Hash;
  attestationSetHash?: Sha256Hash;
  observationAnalysisHash?: Sha256Hash;
  provenance: readonly ("plane_b_authored" | "plane_a_observed" | "canonical_attestation")[];
  result: "satisfied" | "missing" | "stale" | "unbound" | "failing";
}

export interface ReconciliationHunkBindingV1 {
  hunkId: Sha256Hash;
  coordinateIds: readonly `repo:${string}`[];
  editIds: readonly string[];
}

export interface ReconciliationEvidenceInputV1 {
  requirementId: string;
  evidenceId: string;
  semanticEvidenceDigest?: Sha256Hash;
  acceptedAttestationDigests?: readonly Sha256Hash[];
  planningCommit: string;
  observedDiffHash: Sha256Hash;
  semanticModelHash: Sha256Hash;
  attestationSetHash?: Sha256Hash;
  observationAnalysisHash?: Sha256Hash;
  provenance: readonly ("plane_b_authored" | "plane_a_observed" | "canonical_attestation")[];
  result: "satisfied" | "stale" | "unbound" | "failing";
}

export interface ReconciliationRoundTripStepV1 {
  relationId: string;
  relationDigest: Sha256Hash;
  fromId: string;
  toId: string;
  fromLevel: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  toLevel: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  epistemicStatus:
    | "human_declared"
    | "statically_observed"
    | "dynamically_observed"
    | "test_observed"
    | "historically_observed"
    | "llm_inferred"
    | "hypothetical";
  evidenceDigests: readonly Sha256Hash[];
}

export interface ReconciliationRoundTripCoverageV1 {
  schemaVersion: 1;
  expectationId: string;
  editId: string;
  semanticSubjectId: string;
  semanticLevel: 2 | 3 | 4 | 5 | 6;
  sourceSeal: Sha256Hash;
  indexSeal: Sha256Hash;
  observationAnalysisHash: Sha256Hash;
  steps: readonly ReconciliationRoundTripStepV1[];
  terminalCoordinateIds: readonly `repo:${string}`[];
  observedHunkIds: readonly Sha256Hash[];
  evidenceIds: readonly string[];
  terminalStatus: "success" | "empty" | "refused" | "budget_exhausted";
  truncated: boolean;
}

export interface ReconciliationTargetAnalysisV1 {
  targetRef: TargetReferenceV1;
  normativeStatus: "proposed" | "accepted";
  reviewAttestationDigests: readonly Sha256Hash[];
  findings: readonly {
    targetElementId: string;
    result: "realized" | "not_realized" | "unproven";
    evidenceIds: readonly string[];
  }[];
}

export const RECONCILIATION_ADVISORY_CODES = [
  "AMBIGUOUS_STEP_MATCH",
  "ANALYZER_FAILURE",
  "CANDIDATE_ANCHOR_UNUSED",
  "HYPOTHETICAL_TARGET",
  "IMPORT_ONLY_PATH_IGNORED",
  "LLM_ONLY_PATH_IGNORED",
  "MULTILEVEL_PATH_IGNORED",
  "OPTIONAL_EDIT_MISSING",
  "PROXIMITY_ONLY_PATH_IGNORED",
  "ROUND_TRIP_ADVISORY_ONLY",
] as const;

export type ReconciliationAdvisoryCodeV1 =
  typeof RECONCILIATION_ADVISORY_CODES[number];

export interface ReconciliationAnalysisV1 {
  schemaVersion: 1;
  kind: "reconciliation_analysis";
  executionAuthority: "none";
  planningBundleHash: Sha256Hash;
  planningCommit: string;
  observedDiffHash: Sha256Hash;
  observationAnalysis: ObservationAnalysisV1;
  candidateGraphHash: Sha256Hash;
  baselineArchitectureHash: Sha256Hash;
  candidateArchitectureHash: Sha256Hash;
  architectureDeltaHash: Sha256Hash;
  observedHunks: readonly ObservedDiffHunkV1[];
  hunkBindings: readonly ReconciliationHunkBindingV1[];
  architectureDelta: ArchitectureDelta;
  liftedImpacts: readonly {
    hunkId: Sha256Hash;
    expectationIds: readonly string[];
    semanticSubjectIds: readonly string[];
  }[];
  evidenceInputs: readonly ReconciliationEvidenceInputV1[];
  evidenceEvaluations: readonly EvidenceEvaluationV1[];
  roundTripCoverages: readonly ReconciliationRoundTripCoverageV1[];
  targetAnalysis?: ReconciliationTargetAnalysisV1;
  traversalBudgetExhausted: boolean;
  advisoryDiagnostics: readonly {
    code: ReconciliationAdvisoryCodeV1;
    message: string;
    subjectIds: readonly string[];
  }[];
  analysisHash: Sha256Hash;
}

export const RECONCILIATION_REFUSAL_REASONS = [
  "INPUT_SCHEMA_INVALID",
  "SCHEMA_VERSION_UNSUPPORTED",
  "ENVELOPE_HASH_MISMATCH",
  "CHANGE_SET_HASH_MISMATCH",
  "PLANNING_COMMIT_MISMATCH",
  "TARGET_REVISION_MISMATCH",
  "SEMANTIC_MODEL_DRIFT",
  "ANALYZER_CONFIG_DRIFT",
  "TOOL_VERSION_DRIFT",
  "STORE_SCHEMA_DRIFT",
  "ATTESTATION_SET_DRIFT",
  "SOURCE_SEAL_MISMATCH",
  "INDEX_STALE",
  "CONTROL_INPUTS_UNSEALED",
  "ATTESTATION_UNBOUND",
] as const;

export const RECONCILIATION_VIOLATION_REASONS = [
  "SCOPE_ESCAPE",
  "INVARIANT_DRIFT",
  "UNDECLARED_LIFTED_IMPACT",
  "MISSING_PLANNED_EDIT",
  "UNPLANNED_COORDINATE",
  "TARGET_NOT_REALIZED",
] as const;

export const RECONCILIATION_INSUFFICIENCY_REASONS = [
  "BASELINE_NOT_CLEAN",
  "OBSERVATION_ANALYSIS_UNAVAILABLE",
  "REFINEMENT_DISCONNECTED",
  "BUDGET_EXHAUSTED",
  "ROUND_TRIP_UNPROVEN",
  "CONCRETE_EDIT_EXPECTATION_MISSING",
  "OBSERVATION_ANALYSIS_INCOMPLETE",
  "REQUIRED_EVIDENCE_UNSATISFIED",
] as const;

export type ReconciliationRefusalReasonV1 = typeof RECONCILIATION_REFUSAL_REASONS[number];
export type ReconciliationViolationReasonV1 = typeof RECONCILIATION_VIOLATION_REASONS[number];
export type ReconciliationInsufficiencyReasonV1 = typeof RECONCILIATION_INSUFFICIENCY_REASONS[number];
export type ReconciliationReasonCodeV1 =
  | ReconciliationRefusalReasonV1
  | ReconciliationViolationReasonV1
  | ReconciliationInsufficiencyReasonV1;
export type ReconcileTerminalStatusV1 = "REALIZED" | "VIOLATED" | "UNPROVEN" | "REFUSED";

export interface ReconcileDiffReportV1 {
  schemaVersion: 1;
  kind: "reconcile_diff";
  changeSetId: string;
  changeSetHash: Sha256Hash;
  envelopeId: string;
  envelopeHash: Sha256Hash;
  planningCommit: string;
  observedCommit: string;
  baselineSealHash: Sha256Hash;
  observedWorkingDiffHash: Sha256Hash;
  terminalStatus: ReconcileTerminalStatusV1;
  primaryReason: ReconciliationReasonCodeV1 | null;
  reasonCodes: readonly ReconciliationReasonCodeV1[];
  requiredPlannedEditIds: readonly string[];
  matchedPlannedEdits: readonly { editId: string; observedHunkIds: readonly Sha256Hash[] }[];
  missingPlannedEditIds: readonly string[];
  observedHunkIds: readonly Sha256Hash[];
  unplannedCoordinateIds: readonly `repo:${string}`[];
  scopeEscapes: readonly {
    path: CanonicalRepoRelativePath;
    coordinateId?: `repo:${string}`;
  }[];
  invariantDriftIds: readonly string[];
  undeclaredLiftedExpectationIds: readonly string[];
  requiredTargetElementIds: readonly string[];
  targetRealizationFindings: readonly {
    targetElementId: string;
    required: boolean;
    result: "realized" | "not_realized" | "unproven";
    evidenceIds: readonly string[];
  }[];
  requiredEvidenceRequirementIds: readonly string[];
  evidenceEvaluations: readonly EvidenceEvaluationV1[];
  certifiedRoundTrips: readonly {
    expectationId: string;
    coordinateIds: readonly `repo:${string}`[];
    evidenceIds: readonly string[];
  }[];
  requiredRoundTripExpectationIds: readonly string[];
  observationAnalysis: {
    analysisHash: Sha256Hash;
    completeness: "complete" | "partial";
  } | null;
  advisoryDiagnostics: readonly {
    code: ReconciliationAdvisoryCodeV1;
    message: string;
    subjectIds: readonly string[];
  }[];
  secondaryInsufficiencies: readonly ReconciliationInsufficiencyReasonV1[];
  reportHash: Sha256Hash;
}

export interface ReconcileWorkingTreeInputV1 {
  schemaVersion: 1;
  planningBundle: PlanningBundleV1;
}
