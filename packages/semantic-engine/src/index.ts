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

export {
  resolveRepositoryLinks,
  findDanglingReferences,
  LEGACY_SYMBOL_ANCHOR_SHIPPED_IN,
  LEGACY_SYMBOL_ANCHOR_SUPPORT,
} from "./links";
export type {
  RepositoryFacts,
  LinkResolution,
  LinkResolutionOptions,
  LinkResolutionReasonCode,
  LegacySymbolAnchorSupport,
  DanglingReference,
  LinkReport,
} from "./links";

export {
  ANCHOR_MIGRATION_AUTHORITY_REASONS,
  NODE_ANCHOR_MIGRATION_FILE_SYSTEM,
  authorized,
  migrateAnchors,
  recoverAnchorMigration,
  refusedAuthority,
} from "./anchor-migration";
export type {
  AnchorMigrationAuthority,
  AnchorMigrationAuthorityReason,
  AnchorMigrationFileResult,
  AnchorMigrationFileSystem,
  AnchorMigrationGeneration,
  AnchorMigrationOptions,
  AnchorMigrationOutcome,
  AnchorMigrationReport,
} from "./anchor-migration";

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
  AnchorDoctrineFinding,
} from "./check";

export { inspectSemantic } from "./inspect";
export type { SemanticInspection, IncomingReference } from "./inspect";

export { captureHandoff, buildHandoffCapsule, readHandoff, renderHandoffMarkdown, HANDOFF_SCHEMA_VERSION } from "./handoff";
export type { HandoffCapsule, CaptureArgs } from "./handoff";
