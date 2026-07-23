import { CLEAN_CONTROL_WORKING_DIFF_HASH } from "./constants";
import type {
  ControlFreshnessReason,
  ControlFreshnessSeal,
  ControlFreshnessVerdict,
} from "./types";

export interface ControlFreshnessClassification {
  verdict: ControlFreshnessVerdict;
  reasons: ControlFreshnessReason[];
}

/** Classify a complete or partial seal using the public status contract's canonical reason order. */
export function classifyControlFreshnessSeal(
  seal: ControlFreshnessSeal,
): ControlFreshnessClassification {
  if (
    seal.indexedRepositoryRoot === null
    || seal.indexedRepositoryGraphHash === null
    || seal.indexedSemanticModelHash === null
    || seal.indexedAnalysisInputHash === null
    || seal.indexedAt === null
    || seal.indexedToolVersion === null
  ) {
    return { verdict: "UNSEALED", reasons: ["INDEX_SNAPSHOT_MISSING"] };
  }

  const unavailable: ControlFreshnessReason[] = [];
  if (
    seal.headAtCapture === null
    || seal.indexedHeadCommit === null
    || seal.workingDiffHash === null
    || seal.indexedWorkingDiffHash === null
  ) unavailable.push("GIT_STATE_UNAVAILABLE");
  if (seal.storeSchemaVersion === null || seal.indexedStoreSchemaVersion === null) {
    unavailable.push("STORE_SCHEMA_UNAVAILABLE");
  }
  if (unavailable.length > 0) return { verdict: "UNSEALED", reasons: unavailable };

  const mismatches: ControlFreshnessReason[] = [];
  if (seal.repositoryRoot !== seal.indexedRepositoryRoot) mismatches.push("REPOSITORY_ROOT_MISMATCH");
  if (seal.headAtCapture !== seal.indexedHeadCommit) mismatches.push("HEAD_MISMATCH");
  if (seal.repositoryGraphHash !== seal.indexedRepositoryGraphHash) mismatches.push("REPOSITORY_GRAPH_MISMATCH");
  if (seal.semanticModelHash !== seal.indexedSemanticModelHash) mismatches.push("SEMANTIC_MODEL_MISMATCH");
  if (seal.analysisInputHash !== seal.indexedAnalysisInputHash) mismatches.push("ANALYSIS_INPUT_MISMATCH");
  if (seal.workingDiffHash !== seal.indexedWorkingDiffHash) mismatches.push("WORKING_DIFF_MISMATCH");
  if (seal.storeSchemaVersion !== seal.indexedStoreSchemaVersion) mismatches.push("STORE_SCHEMA_MISMATCH");
  if (seal.toolVersion !== seal.indexedToolVersion) mismatches.push("TOOL_VERSION_MISMATCH");
  if (mismatches.length > 0) return { verdict: "STALE", reasons: mismatches };

  return seal.workingDiffHash === CLEAN_CONTROL_WORKING_DIFF_HASH
    ? { verdict: "FRESH", reasons: [] }
    : { verdict: "DIRTY_KNOWN", reasons: ["WORKING_TREE_DIRTY"] };
}
