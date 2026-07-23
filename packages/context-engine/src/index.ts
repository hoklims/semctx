/** Public surface of @semantic-context/context-engine. */
export { GraphIndex } from "./graph-index";
export type { Direction } from "./graph-index";

export { buildClaims, subjectNodes } from "./claim-builder";

export {
  AUTHORITY_POLICIES,
  classifyQuestion,
  policyFor,
} from "./authority-policies";

export { evaluateClaim } from "./priority-engine";
export type { PriorityContext } from "./priority-engine";

export { detectContradictions } from "./contradiction";
export type { ContradictionReport } from "./contradiction";

export { buildContextPack } from "./context-pack-builder";
export type { BuildPackOptions } from "./context-pack-builder";

export { analyzeDiff, parseUnifiedDiff, buildVerifyReport, computeImpactedConsumers } from "./verify-diff";
export type { VerifyResult, VerifyFinding, DiffFile, DiffHunk, VerifyReportGitMeta, ImpactedConsumers } from "./verify-diff";

export { computeCoChanges, parseNameStatusLog } from "./co-change";
export type { CoChange, CoChangedFile, CoChangeOptions } from "./co-change";

export { inspectGraph } from "./inspect";
export type { InspectionResult, InspectKind, InspectRelation } from "./inspect";

export {
  HeuristicTaskFrameExtractor,
  parseTaskDocument,
} from "./task-frame-extractor";
export type { TaskFrameExtractor, TaskExtractionContext } from "./task-frame-extractor";

export {
  extractionContext,
  prepareContextPack,
  fetchProviderCandidates,
  fetchCandidatesFromProvider,
  defaultTaskExtractor,
} from "./engine";
export type { PrepareArgs } from "./engine";

export {
  sealProviderCandidates,
  stableProviderSourceSeal,
  validateProviderCandidate,
  PROVIDER_FACT_REASON_ORDER,
} from "./provider-seal";
export type {
  ProviderCaptureContext,
  ProviderFactReason,
  ProviderFactValidation,
  ProviderValidationContext,
} from "./provider-seal";

export {
  AUTHORITY_BY_STATUS,
  VERIFICATION_STRENGTH,
  FRESHNESS_BY_STATUS,
  computeConfidence,
  WEIGHTS,
} from "./scoring";
