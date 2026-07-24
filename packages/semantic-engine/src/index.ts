/** Public surface of @semantic-context/semantic-engine — files ↔ model, links, slice, change, verify, handoff. */

export * from "./paths";
export { ensureSemanticGitignore, computeGitignore } from "./gitignore";
export type { GitignoreResult } from "./gitignore";

export {
  TargetArchitectureArtifactV1Schema,
  computeTargetArtifactHash,
  computeTargetArchitecturePayloadHash,
  discoverTargetArtifacts,
  loadTargetArtifacts,
  loadTargetArtifact,
  createTargetProposal,
} from "./targets";
export type {
  TargetAuthorshipOriginV1,
  TargetNormativeStatusV1,
  TargetArchitectureRevisionRefV1,
  TargetArchitectureArtifactV1,
  TargetArchitectureProposalInputV1,
  TargetArtifactLocationV1,
} from "./targets";

export {
  loadSemanticModel,
  loadActiveChange,
  readActiveChangePointer,
  sameChangeContractContent,
  loadModelWithWorking,
  writeKindFile,
  writeChangeFile,
  removeChangeFile,
  writeActiveChange,
  clearActiveChange,
  initSemanticScaffold,
  formatSemanticFiles,
} from "./store";
export type { LoadResult, ScaffoldPlan, FormatOutcome, ActiveChangePointerResult, ActiveChangePointerState } from "./store";

export { DEFAULT_SEMANTIC_POLICY, resolveSemanticPolicy } from "./config";

export { resolveRepositoryLinks, findDanglingReferences } from "./links";
export type { RepositoryFacts, LinkResolution, DanglingReference, LinkReport } from "./links";

export { sliceSemanticModel } from "./slice";
export type { SemanticSlice, SliceScope } from "./slice";

export { renderSlice } from "./slice-render";
export type { SliceNotation } from "./slice-render";

export { newChangeContract, applyChangePatch, assertUnknownResolutionsProven, isTerminalLifecycle, TERMINAL_LIFECYCLES } from "./change";
export type { NewChangeInput, ChangePatch } from "./change";

export { verifyChangeContract, lifecycleForVerdict, CHANGE_VERIFY_SCHEMA_VERSION } from "./verify";
export type {
  ChangeVerifyReport,
  SemanticVerdict,
  PreservedInvariant,
  PreservedState,
  EvidenceState,
  UnknownState,
  SemanticFinding,
  SemanticFindingKind,
  SemanticFindingSeverity,
  VerifyChangeArgs,
} from "./verify";

export { checkSemanticModel, SEMANTIC_CHECK_REASON_ORDER } from "./check";
export type {
  CheckReport,
  CheckArgs,
  InvalidId,
  SemanticCheckReasonCode,
  SemanticLifecycleFinding,
} from "./check";

export { inspectSemantic } from "./inspect";
export type { SemanticInspection, IncomingReference } from "./inspect";

export { captureHandoff, buildHandoffCapsule, readHandoff, renderHandoffMarkdown, HANDOFF_SCHEMA_VERSION } from "./handoff";
export type { HandoffCapsule, CaptureArgs } from "./handoff";
