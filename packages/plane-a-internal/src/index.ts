/**
 * Provisional Plane A runtime seam.
 *
 * This package is private and intentionally not re-exported from any public package.
 */
export {
  addAggregatedImportEdges,
  DeterministicGraphAssembler,
  PlaneAAssemblyError,
  assembleFactBatches,
} from "./assembler";
export type {
  AssembledPlaneA,
  ImportEdgeOccurrence,
  PlaneAAssemblyErrorCode,
  UnresolvedReference,
} from "./assembler";
export { canonicalJson, canonicalSourceText, digestCanonical } from "./canonical";
export {
  InvalidDiscoveryLedgerEntryError,
  aggregatePlaneAEvaluations,
  evaluatePlaneA,
  normalizeDiscoveryLedgerEntry,
} from "./evaluation";
export { PLANE_A_REASON_CODES } from "./model";
export { admissibleFor } from "./policy";
export type {
  PlaneAAdmissibilityDecision,
  PlaneAAdmissibilityRequest,
} from "./policy";
export {
  PlaneACaptureChangedError,
  assertStableCapture,
  attachPlaneASidecar,
  getPlaneASidecar,
} from "./sidecar";
export type {
  AnalysisOutcome,
  ArtifactScope,
  CapabilityProfile,
  CanonicalValue,
  DiscoveryLedgerEntry,
  EdgeFact,
  ExactSubjectDecision,
  FactBatchV1,
  GateState,
  NodeFact,
  PlaneAEvaluationDecision,
  PlaneAEvaluationInput,
  PlaneAEvaluationReport,
  PlaneACapabilityRequirement,
  PlaneAEvaluationRequest,
  PlaneAFact,
  PlaneAGates,
  PlaneAReason,
  PlaneAReasonCode,
  PlaneASidecarV1,
  PreSubjectDecision,
  ProducerIdentity,
  ProducerResult,
  ReasonDetail,
  ScopeResolution,
  SelectionDecision,
} from "./model";
