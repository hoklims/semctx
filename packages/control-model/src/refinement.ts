import type {
  ArchitectureComparisonReport,
  AuthoredSemanticLevel,
  AuthorizationDetail,
  AuthorizationReason,
  ControlFreshnessReason,
  ControlFreshnessSeal,
  ControlFreshnessVerdict,
  CoordinateCategory,
  CoordinateEdge,
  EpistemicStatus,
  ExplanationReport,
  ImpactReport,
  LevelCoverage,
  ProofEvaluation,
  ProofObligation,
  ProofReference,
  QualifiedCoordinateId,
  RiskLevel,
  SemanticLevel,
  Sha256Hash,
  SourceKindLevelMapping,
  StaleRepositoryLink,
  DanglingSemanticReference,
  UnsupportedCoordinateSource,
  UnmappedCoordinateSource,
  MigrationState,
} from "./types";

export type RelationProvenanceV1 = "author" | "agent" | "derived";
export type RefinementRelationKindV1 =
  | "decomposes_to"
  | "realizes"
  | "implements"
  | "constrained_by"
  | "proved_by";

export interface AuthoredSemanticNodeV1 {
  schemaVersion: 1;
  nodeId: string;
  kind: string;
  appliesAtLevel: AuthoredSemanticLevel;
  category: CoordinateCategory;
  label: string;
  epistemicStatus: EpistemicStatus;
}

export interface Sha256DigestV1 {
  algorithm: "sha256";
  value: string;
}

export type EvidenceKindV1 =
  | "semantic_node"
  | "observed_diff_hunk"
  | "document_span"
  | "test_result"
  | "commit";

export interface EvidenceRefV1 {
  schemaVersion: 1;
  kind: EvidenceKindV1;
  locator: string;
  digest: Sha256DigestV1;
}

export type RelationEndpointV1 =
  | { plane: "B"; kind: "semantic_node"; nodeId: string }
  | { plane: "A"; kind: "observed_diff_hunk"; coordinateDigest: Sha256Hash };

export interface RefinementRelationV1 {
  schemaVersion: 1;
  id: string;
  kind: RefinementRelationKindV1;
  source: RelationEndpointV1;
  target: RelationEndpointV1;
  epistemicStatus: EpistemicStatus;
  provenance: RelationProvenanceV1;
  evidenceRefs: readonly EvidenceRefV1[];
  relationDigest?: Sha256Hash;
}

export interface ObservedDiffRangeV1 {
  start: number;
  lines: number;
}

export interface ObservedDiffHunkV1 {
  schemaVersion: 1;
  repositoryIdentity: string;
  normalizedPath: string;
  oldRange: ObservedDiffRangeV1;
  newRange: ObservedDiffRangeV1;
  oldBlobId: string | null;
  newBlobId: string | null;
  rawHunkBytes: Uint8Array;
  identity: Sha256Hash;
}

export interface ObservedDiffHunkTransportV1 extends Omit<ObservedDiffHunkV1, "rawHunkBytes"> {
  rawHunkBytes: { encoding: "base64"; value: string };
}

export interface CoordinateNodeV2 {
  id: QualifiedCoordinateId | Sha256Hash;
  plane: "repo" | "semantic" | "observed";
  sourceId: string;
  sourceKind: string;
  appliesAtLevel: SemanticLevel | null;
  category: CoordinateCategory | null;
  label: string;
  epistemicStatus: EpistemicStatus;
  references: readonly string[];
  metadata?: Readonly<Record<string, string>>;
}

export interface LevelCoverageV2 {
  level: SemanticLevel;
  categories: readonly CoordinateCategory[];
  coordinateIds: readonly (QualifiedCoordinateId | Sha256Hash)[];
}

export interface CompatibilityNormalizationNoteV1 {
  schemaVersion: 1;
  sourceSchemaVersion: 1;
  targetSchemaVersion: 2;
  notes: readonly string[];
}

export interface CoordinateGraphReportV1 {
  schemaVersion: 1;
  nodes: readonly {
    id: QualifiedCoordinateId;
    plane: "repo" | "semantic";
    sourceId: string;
    sourceKind: string;
    level: SemanticLevel;
    category: CoordinateCategory;
    label: string;
    epistemicStatus: EpistemicStatus;
    references: readonly string[];
    metadata?: Readonly<Record<string, string>>;
  }[];
  edges: readonly CoordinateEdge[];
  mapping: readonly SourceKindLevelMapping[];
  coverage: readonly LevelCoverage[];
  unsupported: readonly UnsupportedCoordinateSource[];
  unmapped: readonly UnmappedCoordinateSource[];
  staleLinks?: readonly StaleRepositoryLink[];
  danglingReferences?: readonly DanglingSemanticReference[];
}

export interface CoordinateGraphReportV2 {
  schemaVersion: 2;
  nodes: readonly CoordinateNodeV2[];
  structuralEdges: readonly CoordinateEdge[];
  refinementRelations: readonly RefinementRelationV1[];
  verifiedEvidenceDigests: readonly Sha256Hash[];
  mapping: readonly SourceKindLevelMapping[];
  coverage: readonly LevelCoverageV2[];
  unsupported: readonly UnsupportedCoordinateSource[];
  unmapped: readonly UnmappedCoordinateSource[];
  staleLinks: readonly StaleRepositoryLink[];
  danglingReferences: readonly DanglingSemanticReference[];
  compatibilityNormalization: readonly CompatibilityNormalizationNoteV1[];
}

export type TraversalDirectionV1 = "lift" | "lower";
export type ControlTerminalStatusV1 = "success" | "empty" | "refused" | "budget_exhausted";
export type ControlReasonCodeV1 =
  | "COORDINATE_UNKNOWN"
  | "MAPPING_MISSING"
  | "REFINEMENT_DISCONNECTED"
  | "INDEX_STALE"
  | "BUDGET_EXHAUSTED"
  | "PLANNING_COMMIT_MISMATCH"
  | "ATTESTATION_UNBOUND";

export interface TraversalBudgetV1 {
  limit: number;
  consumed: number;
  remaining: number;
  truncated: boolean;
}

export interface RefinementTraversalStepV1 {
  relation: RefinementRelationV1;
  from: RelationEndpointV1;
  to: RelationEndpointV1;
  fromLevel: SemanticLevel;
  toLevel: SemanticLevel;
}

export interface RefinementPathV1 {
  coordinates: readonly (QualifiedCoordinateId | Sha256Hash)[];
  steps: readonly RefinementTraversalStepV1[];
}

export interface TraversalReportV1 {
  schemaVersion: 1;
  direction: TraversalDirectionV1;
  sourceId: QualifiedCoordinateId;
  targetLevel: SemanticLevel;
  maxDepth: number;
  maxResults: number;
  maxExpansions: number;
  maxQueue: number;
  paths: readonly {
    nodes: readonly QualifiedCoordinateId[];
    edges: readonly CoordinateEdge[];
  }[];
  truncated: boolean;
  freshnessSeal?: ControlFreshnessSeal;
}

export interface TraversalReportV2 {
  schemaVersion: 2;
  direction: TraversalDirectionV1;
  sourceId: QualifiedCoordinateId | Sha256Hash;
  targetLevel: SemanticLevel;
  visitedCoordinateIds: readonly (QualifiedCoordinateId | Sha256Hash)[];
  paths: readonly RefinementPathV1[];
  governingConstraints: readonly RefinementRelationV1[];
  proofs: readonly RefinementRelationV1[];
  advisoryRelations: readonly RefinementRelationV1[];
  terminalStatus: ControlTerminalStatusV1;
  reasonCode?: ControlReasonCodeV1;
  budget: TraversalBudgetV1;
  freshnessSeal?: ControlFreshnessSealV2;
  compatibilityNormalization: readonly CompatibilityNormalizationNoteV1[];
}

export interface RefinementCoverageReportV1 {
  schemaVersion: 1;
  rootCoordinate: QualifiedCoordinateId | Sha256Hash;
  sourceSeal: Sha256Hash;
  indexSeal: Sha256Hash;
  direction: TraversalDirectionV1;
  levelSpan: { from: SemanticLevel; to: SemanticLevel };
  visitedCoordinates: readonly (QualifiedCoordinateId | Sha256Hash)[];
  loadBearingSteps: readonly RefinementTraversalStepV1[];
  advisorySteps: readonly RefinementTraversalStepV1[];
  governingConstraints: readonly RefinementRelationV1[];
  proofs: readonly RefinementRelationV1[];
  coveredLevels: readonly SemanticLevel[];
  missingLevels: readonly SemanticLevel[];
  loadBearingEvidence: readonly EvidenceRefV1[];
  proofReferences: readonly EvidenceRefV1[];
  terminalStatus: ControlTerminalStatusV1;
  reasonCode?: ControlReasonCodeV1;
  budget: TraversalBudgetV1;
  compatibilityNormalization: readonly CompatibilityNormalizationNoteV1[];
}

export interface ControlFreshnessSealV2 extends Omit<ControlFreshnessSeal, "sealSchemaVersion" | "sealHash"> {
  sealSchemaVersion: 2;
  attestationSetHash: Sha256Hash | null;
  sealHash: Sha256Hash;
}

export interface AttestationRequestV1 {
  schemaVersion: 1;
  attestationRef: string;
}

export interface CanonicalProofAttestationV1 {
  schemaVersion: 1;
  id: string;
  obligation: ProofObligation;
  subject: string;
  epistemicStatus: EpistemicStatus;
  references: readonly ProofReference[];
  commit: string;
  observedAt: string;
  expiresAt: string;
  attestationDigest: Sha256Hash;
}

export interface AdvisoryRejectedAttestationV1 {
  schemaVersion: 1;
  attestationRef: string;
  reason: "ATTESTATION_UNBOUND";
}

export interface SealedAttestationIndexV1 {
  schemaVersion: 1;
  entries: readonly CanonicalProofAttestationV1[];
  attestationSetHash: Sha256Hash;
}

export interface TransitionAuthorizationReportV1 {
  schemaVersion: 1;
  decision: "ALLOW" | "DENY";
  fromState: MigrationState;
  toState: MigrationState;
  risk: RiskLevel;
  reasons: readonly AuthorizationReason[];
  proofEvaluations: readonly ProofEvaluation[];
  details: readonly AuthorizationDetail[];
}

export interface StepAuthorizationReportV1 {
  schemaVersion: 1;
  decision: "ALLOW" | "DENY";
  stepId: string;
  reasons: readonly AuthorizationReason[];
  missingDependencies: readonly string[];
  proofEvaluations: readonly ProofEvaluation[];
  details: readonly AuthorizationDetail[];
}

export interface DeletionAuthorizationReportV1 {
  schemaVersion: 1;
  decision: "ALLOW" | "DENY";
  subject: string;
  reasons: readonly AuthorizationReason[];
  proofEvaluations: readonly ProofEvaluation[];
  details: readonly AuthorizationDetail[];
}

export type TransitionAuthorizationReportV2 = Omit<TransitionAuthorizationReportV1, "schemaVersion"> & {
  schemaVersion: 2;
  acceptedAttestations: readonly CanonicalProofAttestationV1[];
  advisoryRejectedAttestations: readonly AdvisoryRejectedAttestationV1[];
};

export type StepAuthorizationReportV2 = Omit<StepAuthorizationReportV1, "schemaVersion"> & {
  schemaVersion: 2;
  acceptedAttestations: readonly CanonicalProofAttestationV1[];
  advisoryRejectedAttestations: readonly AdvisoryRejectedAttestationV1[];
};

export type DeletionAuthorizationReportV2 = Omit<DeletionAuthorizationReportV1, "schemaVersion"> & {
  schemaVersion: 2;
  acceptedAttestations: readonly CanonicalProofAttestationV1[];
  advisoryRejectedAttestations: readonly AdvisoryRejectedAttestationV1[];
};

export type ControlQueryKindV1 =
  | "coordinate_graph"
  | "traversal"
  | "refinement_coverage"
  | "impact"
  | "explanation"
  | "architecture_comparison"
  | "authorize_transition"
  | "authorize_step"
  | "authorize_deletion";

export interface ControlQueryEnvelopeBaseV1<K extends ControlQueryKindV1, P> {
  schemaVersion: 1;
  kind: K;
  freshness: {
    verdict: ControlFreshnessVerdict;
    reasons: readonly ControlFreshnessReason[];
    seal: ControlFreshnessSealV2 | null;
  };
  terminalStatus: ControlTerminalStatusV1;
  reasonCodes: readonly ControlReasonCodeV1[];
  payload: P | null;
}

export type ControlQueryEnvelopeV1 =
  | ControlQueryEnvelopeBaseV1<"coordinate_graph", CoordinateGraphReportV2>
  | ControlQueryEnvelopeBaseV1<"traversal", TraversalReportV2>
  | ControlQueryEnvelopeBaseV1<"refinement_coverage", RefinementCoverageReportV1>
  | ControlQueryEnvelopeBaseV1<"impact", ImpactReport>
  | ControlQueryEnvelopeBaseV1<"explanation", ExplanationReport>
  | ControlQueryEnvelopeBaseV1<"architecture_comparison", ArchitectureComparisonReport>
  | ControlQueryEnvelopeBaseV1<"authorize_transition", TransitionAuthorizationReportV2>
  | ControlQueryEnvelopeBaseV1<"authorize_step", StepAuthorizationReportV2>
  | ControlQueryEnvelopeBaseV1<"authorize_deletion", DeletionAuthorizationReportV2>;

export interface NormalizedV2<T> {
  value: T;
  compatibility: CompatibilityNormalizationNoteV1;
}
