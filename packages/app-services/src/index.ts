export { analyzeAndBuildClaims, indexRepository, indexRepositoryAsync } from "./indexing";
export { controlAgentLifecycleCheckpoint } from "./agent-lifecycle";
export { captureControlHandoffV2, resumeControlHandoffV2 } from "./control-handoff";
export { probeCliCompatibility } from "./cli-compatibility";
export { workspaceHealth, type WorkspaceHealthCheck } from "./doctor";
export type {
  CliCompatibilityProbeDependencies,
  CliCompatibilityReason,
  CliCompatibilityReport,
} from "./cli-compatibility";
export {
  SETUP_POLYGLOT_V1_REFUSE_NEXT_STEPS,
  SETUP_POLYGLOT_V1_REFUSE_REASON,
  SETUP_POLYGLOT_V1_REFUSE_REASON_CODE,
  buildPolyglotRequiresConfigV2Report,
  computeSetupReadiness,
  evaluatePolyglotSetupPolicy,
  planSetupRepository,
  setupRepository,
  setupRepositoryAsync,
} from "./setup";
export type {
  ComputeSetupReadinessInput,
  EvaluatePolyglotSetupPolicyInput,
  SetupPhaseEvent,
  SetupPlanReport,
  SetupPlanResult,
  SetupRefuseReasonCode,
  SetupRefusedReport,
  SetupRepositoryOptions,
  SetupRepositoryReport,
  SetupResult,
  SetupVerdict,
} from "./setup";
export {
  PLUGIN_DELIVERY_ATTESTATION_TIMEOUT_MS,
  PLUGIN_DELIVERY_HOSTS,
  PLUGIN_DELIVERY_MAX_ARTIFACT_BYTES,
  PLUGIN_DELIVERY_MAX_BUNDLE_BYTES,
  PLUGIN_DELIVERY_MAX_HOST_OUTPUT_BYTES,
  PLUGIN_DELIVERY_MAX_MANIFEST_BYTES,
  PLUGIN_DELIVERY_MAX_STORE_BYTES,
  PLUGIN_DELIVERY_QUERY_TIMEOUT_MS,
  PLUGIN_DELIVERY_RELEASE_REF,
  PLUGIN_DELIVERY_RELEASE_URL,
  PLUGIN_DELIVERY_SCHEMA_VERSION,
  PLUGIN_RUNTIME_BUNDLES,
  codexCacheEntryFromMarketplaceRoot,
  isHostInterfaceUnsupportedFailure,
  pluginDeliveryStatus,
} from "./plugin-delivery";
export type {
  HostInstalledStateV2,
  HostMarketplaceStateV2,
  HostPluginDeliveryV2,
  HostSessionStateV2,
  HostSnapshotStateV2,
  InstalledPayloadProbe,
  MarketplaceSnapshotProbe,
  PluginDeliveryCommand,
  PluginDeliveryDependencies,
  PluginDeliveryHost,
  PluginDeliveryQueryOutcome,
  PluginDeliveryQueryLimits,
  PluginDeliveryReason,
  PluginDeliveryReportV2,
  PluginDeliveryScope,
  PluginDeliveryVerdict,
  PublicReleaseAuthority,
  PublicReleaseBundleWitnesses,
  PublicReleaseProbe,
  PublicReleaseV2,
  RepositoryChannelProbe,
  RepositoryChannelV2,
  SessionVersionProbe,
} from "./plugin-delivery";
export { openReadyRepository, openReadyRepositoryWriter } from "./readiness";
export type { RepositoryAnalysis, RepositoryIndex } from "./indexing";
export { recoverIndexEvidence, recoverIndexEvidenceAsync } from "./index-recovery";
export type { IndexRecoveryOutcome } from "./index-recovery";
export { recordVerificationState, requireStableVerificationGitState } from "./verification-recording";
export { evaluatePreCommitHook, evaluatePrePushHook, parsePrePushRefs } from "./verification-hook";
export type {
  PushedRef,
  VerificationHookName,
  VerificationHookOutcome,
  VerificationHookRecordReason,
  VerificationHookRefusal,
} from "./verification-hook";
export { indexHealth, indexHealthStatus } from "./index-health";
export type {
  IndexHealthCandidateV1,
  IndexHealthReportV1,
  IndexHealthStatus,
} from "./index-health";
export { anchorMigrationAuthority } from "./anchor-migration-authority";
export { planVerify, runVerify } from "./verify";
export { runChangeImpact } from "./change-impact";
export type { ChangeImpactOptions, ChangeImpactRequest } from "./change-impact";
export type { VerifySource, VerifyComputation } from "./verify";
export {
  UNRESOLVED_REFERENCE_INDEX_META_KEY,
  createUnresolvedReferenceIndex,
  parseUnresolvedReferenceIndex,
} from "./unresolved-references";
export type { PersistedUnresolvedReferenceIndexV1 } from "./unresolved-references";
export { checkSemanticState, inspectSemanticLifecycle } from "./semantic-check";
export {
  captureCommitTreeHash,
  captureRecordableVerificationGitState,
  captureVerificationGitState,
  fingerprintVerificationSource,
  parseVerificationStateV3,
  resolveRevisionObjectId,
} from "./verification-state";
export type { VerificationGitState, VerificationStateV3 } from "./verification-state";
export { closeChange, normalizeChangeId, openChange, updateChange, verifyAuthoredChange } from "./changes";
export type { OpenChangeCommand, UpdateChangeCommand } from "./changes";
export {
  controlAltitudeAuthority,
  controlStatus,
  loadControlQueryRuntime,
  loadControlState,
  planControlMigration,
  queryControlArchitectureComparison,
  queryControlDeletionAuthorization,
  queryControlExplanation,
  queryControlGraph,
  queryControlImpact,
  queryControlRefinementCoverage,
  queryControlStepAuthorization,
  queryControlTransitionAuthorization,
  queryControlTraversal,
  traceControl,
  trustedControlSealHash,
} from "./control";
export type { ControlPlanCommand, ControlTraceCommand, CurrentControlState } from "./control";
export {
  applyConfigMigration,
  planConfigMigration,
  restoreConfigMigration,
} from "./config-migration";
export {
  exportFeedbackAggregate,
  listFeedback,
  recordFeedback,
  removeFeedback,
  showFeedback,
  updateFeedback,
} from "./feedback";
export type {
  FeedbackAnswer,
  FeedbackClock,
  FeedbackOutcome,
  FeedbackReasonCode,
  RecordFeedbackInput,
  RecordFeedbackResult,
} from "./feedback";
export { buildSupportReport } from "./support";
export type { SupportReportDependencies } from "./support";
export { reviewTargetProposal } from "./target-review";
export type { ReviewTargetArchitectureCommandV1 } from "./target-review";
export {
  ProposeTargetArchitectureCommandV1Schema,
  proposeTargetArchitecture,
} from "./target-proposal";
export type {
  ProposeTargetArchitectureCommandV1,
  TargetArchitectureProposalResultV1,
} from "./target-proposal";
export {
  buildControlFreshnessSeal,
  canonicalRepositoryRoot,
  captureGitState,
  captureTrackedWorkingDiff,
  controlRepositoryIdentity,
  evaluateControlFreshness,
  fingerprintAnalysisInputs,
  fingerprintRepositoryFacts,
  fingerprintRepositoryGraph,
  fingerprintSemanticModel,
  fingerprintSemanticNodeEvidence,
  unsealedControlStatus,
} from "./freshness";
export type {
  ControlFreshnessSealInput,
  GitStateCapture,
  IndexedControlSnapshot,
  IndexedControlSnapshotV1,
  IndexedControlSnapshotV2,
} from "./freshness";
export {
  CONTROL_OBSERVED_HUNK_INDEX_META_KEY,
  createObservedHunkIndex,
  materializeReferencedObservedHunks,
  observedHunksFromIndex,
  parseObservedHunkIndex,
  resolveVerifiedRelationEvidence,
} from "./control-evidence";
export type { PersistedObservedHunkIndexV1 } from "./control-evidence";
export {
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
} from "./control-queries";
export type {
  ControlQueryRuntime,
  DeletionAuthorizationQueryV1,
  ExplanationQueryV1,
  ImpactQueryV1,
  RefinementCoverageQueryV1,
  StepAuthorizationQueryV1,
  TransitionAuthorizationQueryV1,
  TraversalQueryV1,
} from "./control-queries";
