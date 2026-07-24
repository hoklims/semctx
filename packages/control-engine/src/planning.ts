/**
 * Read-only Plane-C planning surface.
 *
 * This module exports descriptive compilation only. It deliberately has no
 * dependency on policy.ts, migration execution, patch application, or writers.
 */
export {
  TaskEnvelopeCompilationError,
  bindExplicitAnchors,
  compileTaskEnvelope,
  computeChangeContractHash,
  createCandidateAnchor,
  createResolvedBinding,
  snapshotTaskFrame,
} from "./task-envelope";
export type {
  AuthoredLinkResolutionInputV1,
  BindingEvidenceProvenanceV1,
  BindExplicitAnchorsInput,
  BoundExplicitAnchorsV1,
  CompileTaskEnvelopeInput,
  ExplicitDiscoveryInputV1,
  TargetSelectionInputV1,
  TaskEnvelopeCompilationReason,
  TaskFrameAdvisoryV1,
} from "./task-envelope";
export {
  compileSemanticChangeSet,
  selectRefinementProfile,
} from "./refinement-planner";
export type {
  CompileSemanticChangeSetInput,
  RefinementProfileSelectionInput,
  RefinementProfileSelectionV1,
} from "./refinement-planner";
