import type {
  EdgeKind,
  EvidenceRef,
  MetadataValue,
  NodeKind,
} from "@semantic-context/core";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export interface ArtifactScope {
  repositoryIdentity: string;
  sourceStateDigest: string;
  selectedPathSetDigest: string;
  selectedPaths: readonly string[];
  workspaceUnitId?: string;
  language: string;
  dialectVersion?: string;
}

export interface ProducerIdentity {
  identity: string;
  version: string;
}

export interface NodeFact {
  factType: "node";
  ordinal: number;
  id: string;
  kind: NodeKind;
  name: string;
  filePath?: string;
  boundedContext?: string;
  exported?: boolean;
  evidence: readonly EvidenceRef[];
  tags: readonly string[];
  metadata: Readonly<Record<string, MetadataValue>>;
}

export interface EdgeFact {
  factType: "edge";
  ordinal: number;
  kind: EdgeKind;
  from: string;
  to: string;
  evidence: readonly EvidenceRef[];
  metadata: Readonly<Record<string, MetadataValue>>;
}

export type PlaneAFact = NodeFact | EdgeFact;

export interface FactBatchV1 {
  schemaVersion: 1;
  batchId: string;
  scope: ArtifactScope;
  producer: ProducerIdentity;
  producerConfigurationDigest: string;
  factSchemaDigest: string;
  sourceDigest: string;
  factKinds: readonly string[];
  capabilityProfileIds: readonly string[];
  evidenceContract: string;
  facts: readonly PlaneAFact[];
}

export interface CapabilityProfile {
  profileId: string;
  factKind: string;
  scope: ArtifactScope;
  producer: ProducerIdentity;
  producerConfigurationDigest: string;
  factSchemaDigest: string;
  evidenceContract: string;
  resolutionSemantics: string;
  soundnessClaim: string;
  completenessClaim: string;
  negativeEvidenceEligible: boolean;
  label?: string;
}

export type SelectionDecision = "selected" | "excluded";
export type AnalysisOutcome =
  | "not_applicable"
  | "disabled"
  | "unsupported"
  | "failed"
  | "analyzed";

export interface DiscoveryLedgerEntry {
  candidateIdentity: string;
  scope: ArtifactScope;
  selectionDecision: SelectionDecision;
  analysisOutcome: AnalysisOutcome;
  selectionReasons: readonly string[];
  analysisReasons: readonly string[];
  selectedProducer?: ProducerIdentity;
}

export interface ProducerResult {
  resultId: string;
  status: "completed" | "failed";
  producer: ProducerIdentity;
  scope: ArtifactScope;
  factBatchId: string;
}

export interface PlaneASidecarV1 {
  schemaVersion: 1;
  scope: ArtifactScope;
  producerConfigurationDigest: string;
  factSchemaDigest: string;
  sourceDigest: string;
  capabilityProfiles: readonly CapabilityProfile[];
  discoveryLedger: readonly DiscoveryLedgerEntry[];
  producerResults: readonly ProducerResult[];
  factBatches: readonly FactBatchV1[];
}

export const PLANE_A_REASON_CODES = [
  "AMBIGUOUS_LAYOUT",
  "AMBIGUOUS_SCOPE",
  "DISCOVERY_NOT_ESTABLISHED",
  "ANALYSIS_DISABLED",
  "LANGUAGE_UNSUPPORTED",
  "PRODUCER_FAILED",
  "BINDING_UNSEALED",
  "BINDING_INVALID",
  "CURRENT_STATE_UNSEALED",
  "CURRENT_STATE_STALE",
  "SCOPE_MISMATCH",
  "CAPABILITY_MISSING",
  "PRODUCER_VERSION_MISMATCH",
  "CONFIG_DIGEST_MISMATCH",
  "SCHEMA_DIGEST_MISMATCH",
  "EVIDENCE_CONTRACT_MISMATCH",
  "NEGATIVE_COMPLETENESS_MISSING",
  "POLICY_DENIED",
] as const;

export type PlaneAReasonCode = (typeof PLANE_A_REASON_CODES)[number];

export interface ReasonDetail {
  coordinate: string;
  expected: CanonicalValue;
  actual: CanonicalValue;
}

export interface PlaneAReason {
  code: PlaneAReasonCode;
  details: readonly ReasonDetail[];
}

export interface PlaneAEvaluationRequest {
  task: string;
  operation: string;
  factKind: string;
  requestedScopeDescriptor: CanonicalValue;
  candidateIdentity: string;
  negativeConclusion: boolean;
}

export type ScopeResolution =
  | {
      status: "unresolved";
      failures: readonly {
        code: "AMBIGUOUS_LAYOUT" | "AMBIGUOUS_SCOPE" | "DISCOVERY_NOT_ESTABLISHED";
        detail: ReasonDetail;
      }[];
    }
  | { status: "exact"; scope: ArtifactScope };

export interface PlaneAEvaluationInput {
  request: PlaneAEvaluationRequest;
  scopeResolution: ScopeResolution;
  ledgerEntry: DiscoveryLedgerEntry;
  completedResults: readonly ProducerResult[];
  factBatches: readonly FactBatchV1[];
  bindingAttestation: "absent" | "valid" | "invalid";
  currentFreshness: "FRESH" | "DIRTY_KNOWN" | "UNSEALED" | "STALE";
  capabilityProfiles: readonly CapabilityProfile[];
  requiredCapability: {
    resolutionSemantics: string;
    soundnessClaim: string;
    completenessClaim: string;
  };
  taskRelativeAuthority: { admissible: boolean };
}

export type GateState = "passed" | "failed" | "not_applicable";

export interface PlaneAGates {
  discoveryAndScope: GateState;
  bindingAndIntegrity: GateState;
  currentFreshness: GateState;
  capabilityMatch: GateState;
  negativeCompleteness: GateState;
  taskRelativeAuthority: GateState;
}

interface DecisionIdentity {
  task: string;
  operation: string;
  factKind: string;
  requestedScopeDescriptor: CanonicalValue;
  candidateIdentity: string;
}

export interface PreSubjectDecision extends DecisionIdentity {
  decisionKind: "pre_subject";
  outcome: "INSUFFICIENT_ANALYSIS";
  admissible: false;
  reasons: readonly PlaneAReason[];
  primaryReason: PlaneAReasonCode;
  gates: PlaneAGates;
}

export interface ExactSubjectDecision extends DecisionIdentity {
  decisionKind: "exact_subject";
  scope: ArtifactScope;
  outcome: "PASS" | "UNKNOWN" | "INSUFFICIENT_ANALYSIS" | "POLICY_DENIED";
  admissible: boolean;
  normalizedAnalysisOutcome: AnalysisOutcome;
  reasons: readonly PlaneAReason[];
  primaryReason?: PlaneAReasonCode;
  gates: PlaneAGates;
}

export type PlaneAEvaluationDecision = PreSubjectDecision | ExactSubjectDecision;

export interface PlaneAEvaluationReport {
  schemaVersion: 1;
  decisions: readonly PlaneAEvaluationDecision[];
  reasonSummary: readonly PlaneAReasonCode[];
  primaryReason?: PlaneAReasonCode;
}
