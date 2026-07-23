/** Plane C contracts: derived coordinates, architecture transitions, and proof authorization. */

export type SemanticLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type CoordinatePlane = "repo" | "semantic";
export type RepositoryCoordinateId = `repo:${string}`;
export type SemanticCoordinateId = `semantic:${string}`;
export type QualifiedCoordinateId = RepositoryCoordinateId | SemanticCoordinateId;

export type EpistemicStatus =
  | "human_declared"
  | "statically_observed"
  | "dynamically_observed"
  | "test_observed"
  | "historically_observed"
  | "llm_inferred"
  | "hypothetical";

export type CoordinateCategory =
  | "syntax"
  | "code_entity"
  | "module"
  | "bounded_context"
  | "capability"
  | "invariant"
  | "policy"
  | "goal"
  | "decision"
  | "system"
  | "strategy";

export interface SourceKindLevelMapping {
  plane: CoordinatePlane;
  sourceKind: string;
  level: SemanticLevel | null;
  category: CoordinateCategory | null;
  supported: boolean;
  reason?: string;
}

export interface CoordinateNode {
  id: QualifiedCoordinateId;
  plane: CoordinatePlane;
  sourceId: string;
  sourceKind: string;
  level: SemanticLevel;
  category: CoordinateCategory;
  label: string;
  epistemicStatus: EpistemicStatus;
  references: string[];
  metadata?: Record<string, string>;
}

export interface CoordinateEdge {
  from: QualifiedCoordinateId;
  to: QualifiedCoordinateId;
  relation: string;
  sourceRelation?: string;
  evidenceRefs: string[];
}

export interface CoordinatePath {
  nodes: QualifiedCoordinateId[];
  edges: CoordinateEdge[];
}

export interface LevelCoverage {
  level: SemanticLevel;
  categories: CoordinateCategory[];
  coordinateIds: QualifiedCoordinateId[];
}

export interface UnsupportedCoordinateSource {
  plane: CoordinatePlane;
  sourceId: string;
  sourceKind: string;
  reason: string;
}

export interface UnmappedCoordinateSource {
  plane: CoordinatePlane;
  sourceId: string;
  sourceKind: string;
  reason: string;
}

export interface StaleRepositoryLink {
  ownerId: string;
  link: { kind: string; ref: string };
  resolved: false;
  reason: string;
}

export interface DanglingSemanticReference {
  ownerId: string;
  field: string;
  ref: string;
}

export interface CoordinateGraphReport {
  schemaVersion: 1;
  nodes: CoordinateNode[];
  edges: CoordinateEdge[];
  mapping: SourceKindLevelMapping[];
  coverage: LevelCoverage[];
  unsupported: UnsupportedCoordinateSource[];
  unmapped: UnmappedCoordinateSource[];
  /** Additive since schemaVersion 1; new builders always emit it. */
  staleLinks?: StaleRepositoryLink[];
  /** Additive since schemaVersion 1; new builders always emit it. */
  danglingReferences?: DanglingSemanticReference[];
}

export type Sha256Hash = `sha256:${string}`;

export interface ControlFreshnessSeal {
  sealSchemaVersion: 1;
  kind: "control_freshness_seal";
  algorithm: "sha256-v1";
  repositoryRoot: string;
  indexedRepositoryRoot: string | null;
  headAtCapture: string | null;
  indexedHeadCommit: string | null;
  /** Legacy field name; the hash covers the graph, claims and evidence consumed as Plane A facts. */
  repositoryGraphHash: Sha256Hash;
  /** Indexed counterpart of repositoryGraphHash. */
  indexedRepositoryGraphHash: Sha256Hash | null;
  semanticModelHash: Sha256Hash;
  indexedSemanticModelHash: Sha256Hash | null;
  analysisInputHash: Sha256Hash;
  indexedAnalysisInputHash: Sha256Hash | null;
  workingDiffHash: Sha256Hash | null;
  indexedWorkingDiffHash: Sha256Hash | null;
  indexedAt: string | null;
  storeSchemaVersion: number | null;
  indexedStoreSchemaVersion: number | null;
  toolVersion: string;
  indexedToolVersion: string | null;
  sealHash: Sha256Hash;
}

export type ControlFreshnessVerdict = "FRESH" | "DIRTY_KNOWN" | "STALE" | "UNSEALED";

export type ControlFreshnessReason =
  | "REPOSITORY_NOT_INITIALIZED"
  | "REPOSITORY_NOT_INDEXED"
  | "INDEX_SNAPSHOT_MISSING"
  | "INDEX_SNAPSHOT_INVALID"
  | "GIT_STATE_UNAVAILABLE"
  | "STORE_SCHEMA_UNAVAILABLE"
  | "REPOSITORY_ROOT_MISMATCH"
  | "HEAD_MISMATCH"
  | "REPOSITORY_GRAPH_MISMATCH"
  | "SEMANTIC_MODEL_MISMATCH"
  | "ANALYSIS_INPUT_MISMATCH"
  | "WORKING_DIFF_MISMATCH"
  | "STORE_SCHEMA_MISMATCH"
  | "TOOL_VERSION_MISMATCH"
  | "WORKING_TREE_DIRTY";

export interface ControlFreshnessStatusReport {
  schemaVersion: 1;
  kind: "control_freshness_status";
  basis: "control_index_snapshot_v1";
  verdict: ControlFreshnessVerdict;
  canRunHighRiskControl: boolean;
  reasons: ControlFreshnessReason[];
  freshnessSeal: ControlFreshnessSeal | null;
}

export type TraversalDirection = "lift" | "lower";

export interface TraversalReport {
  schemaVersion: 1;
  direction: TraversalDirection;
  sourceId: QualifiedCoordinateId;
  targetLevel: SemanticLevel;
  maxDepth: number;
  maxResults: number;
  maxExpansions: number;
  maxQueue: number;
  paths: CoordinatePath[];
  truncated: boolean;
  freshnessSeal?: ControlFreshnessSeal;
  freshnessStatus?: ControlFreshnessStatusReport;
}

export interface ImpactedCoordinate {
  id: QualifiedCoordinateId;
  paths: CoordinatePath[];
}

export interface ImpactReport {
  schemaVersion: 1;
  sourceIds: QualifiedCoordinateId[];
  maxDepth: number;
  maxResults: number;
  maxExpansions: number;
  maxQueue: number;
  affected: ImpactedCoordinate[];
  truncated: boolean;
}

export interface ExplanationReport {
  schemaVersion: 1;
  sourceId: QualifiedCoordinateId;
  maxDepth: number;
  maxResults: number;
  maxExpansions: number;
  maxQueue: number;
  known: boolean;
  rationaleIds: QualifiedCoordinateId[];
  paths: CoordinatePath[];
  unknownReason?: "coordinate_missing" | "rationale_not_authored" | "traversal_bound_reached";
}

export interface ArchitectureElement {
  id: QualifiedCoordinateId;
  level: SemanticLevel;
  category: CoordinateCategory;
  fingerprint: string;
}

export interface ArchitectureRelation {
  from: QualifiedCoordinateId;
  to: QualifiedCoordinateId;
  relation: string;
  fingerprint: string;
}

export interface ArchitectureSnapshot {
  id: string;
  commit: string;
  capturedAt: string;
  elements: ArchitectureElement[];
  relations: ArchitectureRelation[];
}

export interface ChangedArchitectureElement {
  id: QualifiedCoordinateId;
  before: ArchitectureElement;
  after: ArchitectureElement;
}

export interface ChangedArchitectureRelation {
  key: string;
  before: ArchitectureRelation;
  after: ArchitectureRelation;
}

export interface ArchitectureDelta {
  currentSnapshotId: string;
  targetSnapshotId: string;
  added: ArchitectureElement[];
  removed: ArchitectureElement[];
  changed: ChangedArchitectureElement[];
  addedRelations: ArchitectureRelation[];
  removedRelations: ArchitectureRelation[];
  changedRelations: ChangedArchitectureRelation[];
  changedInvariantIds: QualifiedCoordinateId[];
}

export interface ArchitectureComparisonReport {
  schemaVersion: 1;
  current: ArchitectureSnapshot;
  target: ArchitectureSnapshot;
  delta: ArchitectureDelta;
}

export type ProofObligation =
  | "baseline_captured"
  | "behavior_characterized"
  | "target_reviewed"
  | "replacement_present"
  | "shadow_equivalent"
  | "cutover_approved"
  | "observation_window_passed"
  | "static_dependencies_zero"
  | "runtime_dependencies_zero"
  | "invariants_preserved"
  | "data_migration_complete"
  | "rollback_ready"
  | "deletion_approved";

export type ProofReferenceKind =
  | "architecture"
  | "static_analysis"
  | "runtime_observation"
  | "test"
  | "history"
  | "human_approval"
  | "rollback"
  | "other";

export interface ProofReference {
  kind: ProofReferenceKind;
  uri: string;
  nonLlm: boolean;
}

export interface ProofAttestation {
  id: string;
  obligation: ProofObligation;
  subject: string;
  epistemicStatus: EpistemicStatus;
  references: ProofReference[];
  commit: string;
  observedAt: string;
  expiresAt: string;
}

/** Every clause must be satisfied; statuses within one clause are alternatives. */
export interface ProofRequirementClause {
  statuses: EpistemicStatus[];
  referenceKinds?: ProofReferenceKind[];
  requireNonLlmReference?: boolean;
}

export interface ProofObligationPolicy {
  obligation: ProofObligation;
  allOf: ProofRequirementClause[];
  prerequisiteObligations: ProofObligation[];
}

export type MigrationState =
  | "OBSERVED"
  | "MODELED"
  | "TARGET_PROPOSED"
  | "PROOFS_DEFINED"
  | "PARALLEL_IMPLEMENTATION"
  | "SHADOW_VALIDATED"
  | "CUTOVER"
  | "LEGACY_REMOVABLE"
  | "DELETED";

export type RiskLevel = "R0" | "R1" | "R2" | "R3";
export type MigrationStepKind =
  | "capture"
  | "characterize"
  | "introduce"
  | "shadow_compare"
  | "cutover"
  | "observe"
  | "deletion_check";

export type MigrationStepProfile =
  | "capture_baseline"
  | "characterize_behavior"
  | "define_target_proofs"
  | "introduce_parallel"
  | "shadow_validate"
  | "cutover_replacement"
  | "observe_cutover"
  | "authorize_deletion";

export interface MigrationStepProfileDefinition {
  profile: MigrationStepProfile;
  kind: MigrationStepKind;
  fromState: MigrationState;
  toState: MigrationState;
  risk: RiskLevel;
  minimumProofObligations: ProofObligation[];
}

export interface RollbackPlan {
  description: string;
  testReference: string;
}

export interface MigrationStep {
  id: string;
  kind: MigrationStepKind;
  profile: MigrationStepProfile;
  title: string;
  fromState: MigrationState;
  toState: MigrationState;
  risk: RiskLevel;
  dependsOn: string[];
  affectedCoordinateIds: QualifiedCoordinateId[];
  proofObligations: ProofObligation[];
  rollback?: RollbackPlan;
  changesL4Invariant: boolean;
}

export type MigrationPlanStatus = "READY" | "BLOCKED";
export type MigrationPlanBlockedReason =
  | "control_inputs_stale"
  | "control_inputs_unsealed"
  | "target_architecture_missing"
  | "architecture_delta_missing"
  | "architecture_delta_inconsistent"
  | "migration_cycle_detected"
  | "open_unknowns"
  | "required_evidence_unsatisfied";

export interface PlanningEvidenceRequirement {
  id: string;
  status: "satisfied" | "unsatisfied" | "waived";
  satisfied: boolean;
  attestationIds: string[];
}

/** Decoupled projection of the Plane B ChangeContract needed by Plane C. */
export interface ChangePlanningContext {
  id: string;
  serves: string[];
  preserves: string[];
  requiredEvidence: PlanningEvidenceRequirement[];
  openUnknowns: string[];
}

export interface MigrationPlanBlockedDetail {
  schemaVersion: 1;
  reason: MigrationPlanBlockedReason;
  subjectIds: string[];
  message: string;
}

export interface MigrationPlan {
  id: string;
  changeId: string;
  planningCommit: string;
  status: MigrationPlanStatus;
  blockedReason?: MigrationPlanBlockedReason;
  blockedDetails: MigrationPlanBlockedDetail[];
  planningContext: ChangePlanningContext;
  current: ArchitectureSnapshot;
  target?: ArchitectureSnapshot;
  delta?: ArchitectureDelta;
  steps: MigrationStep[];
  outstandingObligations: ProofObligation[];
}

export interface MigrationPlanReport {
  schemaVersion: 1;
  plan: MigrationPlan;
  freshnessSeal?: ControlFreshnessSeal;
  freshnessStatus?: ControlFreshnessStatusReport;
}

export type AuthorizationDecision = "ALLOW" | "DENY";
export type AuthorizationReason =
  | "transition_not_adjacent"
  | "terminal_state"
  | "dependency_incomplete"
  | "proof_missing"
  | "proof_subject_mismatch"
  | "proof_commit_mismatch"
  | "proof_stale"
  | "proof_epistemically_insufficient"
  | "rollback_missing"
  | "rollback_untested"
  | "human_approval_missing"
  | "invariant_approval_missing"
  | "plan_blocked"
  | "input_invalid"
  | "plan_invalid"
  | "step_invalid"
  | "execution_state_invalid"
  | "execution_plan_mismatch"
  | "execution_commit_mismatch"
  | "execution_state_stale"
  | "completion_invalid"
  | "profile_mismatch"
  | "deletion_denied";

export interface AuthorizationDetail {
  reason: AuthorizationReason;
  subjectId?: string;
  message: string;
}

export interface ProofEvaluation {
  obligation: ProofObligation;
  satisfied: boolean;
  acceptedAttestationIds: string[];
  reasons: AuthorizationReason[];
}

export interface TransitionAuthorizationReport {
  schemaVersion: 1;
  decision: AuthorizationDecision;
  fromState: MigrationState;
  toState: MigrationState;
  risk: RiskLevel;
  reasons: AuthorizationReason[];
  proofEvaluations: ProofEvaluation[];
  details: AuthorizationDetail[];
}

export interface StepAuthorizationReport {
  schemaVersion: 1;
  decision: AuthorizationDecision;
  stepId: string;
  reasons: AuthorizationReason[];
  missingDependencies: string[];
  proofEvaluations: ProofEvaluation[];
  details: AuthorizationDetail[];
}

export interface DeletionAuthorizationReport {
  schemaVersion: 1;
  decision: AuthorizationDecision;
  subject: string;
  reasons: AuthorizationReason[];
  proofEvaluations: ProofEvaluation[];
  details: AuthorizationDetail[];
}

export interface TransitionAuthorizationInput {
  fromState: MigrationState;
  toState: MigrationState;
  risk: RiskLevel;
  subject: string;
  planningCommit: string;
  evaluatedAt: string;
  proofObligations: ProofObligation[];
  attestations: ProofAttestation[];
  rollback?: RollbackPlan;
  changesL4Invariant: boolean;
}

export interface StepAuthorizationInput {
  plan: MigrationPlan;
  step: MigrationStep;
  executionState: ExecutionState;
  attestations: ProofAttestation[];
  evaluatedAt: string;
}

export interface StepCompletion {
  stepId: string;
  planId: string;
  commit: string;
  observedAt: string;
  expiresAt: string;
  attestationIds: string[];
}

export interface ExecutionState {
  schemaVersion: 1;
  planId: string;
  planningCommit: string;
  currentState: MigrationState;
  recordedAt: string;
  completedSteps: StepCompletion[];
}

export interface DeletionAuthorizationInput {
  subject: string;
  planningCommit: string;
  evaluatedAt: string;
  attestations: ProofAttestation[];
}

export interface MigrationPlanningInput {
  change: ChangePlanningContext;
  current: ArchitectureSnapshot;
  target?: ArchitectureSnapshot;
  delta?: ArchitectureDelta;
}

export type PublicControlReport =
  | CoordinateGraphReport
  | ControlFreshnessStatusReport
  | TraversalReport
  | ImpactReport
  | ExplanationReport
  | ArchitectureComparisonReport
  | MigrationPlanReport
  | TransitionAuthorizationReport
  | StepAuthorizationReport
  | DeletionAuthorizationReport;
