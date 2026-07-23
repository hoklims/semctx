import { SemctxError, type Claim, type SemctxConfig } from "@semantic-context/core";
import { buildClaims, GraphIndex } from "@semantic-context/context-engine";
import { loadConfig, openStore, SCHEMA_VERSION } from "@semantic-context/repository-store";
import type { ControlFreshnessSeal } from "@semantic-context/control-model";
import { loadSemanticModel } from "@semantic-context/semantic-engine";
import { analyzeRepository, discoverFiles, type AnalysisResult, type DiscoveredFile } from "@semantic-context/ts-analyzer";
import {
  CONTROL_INDEX_SNAPSHOT_META_KEY,
  CONTROL_FRESHNESS_TOOL_VERSION,
  buildControlFreshnessSeal,
  canonicalRepositoryRoot,
  captureGitState,
  fingerprintAnalysisInputs,
  fingerprintRepositoryFacts,
  fingerprintSemanticModel,
  type IndexedControlSnapshot,
} from "./freshness";

export interface RepositoryAnalysis {
  analysis: AnalysisResult;
  claims: Claim[];
}

export interface RepositoryIndex extends RepositoryAnalysis {
  freshnessSeal: ControlFreshnessSeal;
}

/** Application boundary for filesystem analysis followed by graph-derived claim construction. */
export function analyzeAndBuildClaims(config: SemctxConfig, files?: readonly DiscoveredFile[]): RepositoryAnalysis {
  const analysis = analyzeRepository(config, files);
  return { analysis, claims: buildClaims(new GraphIndex(analysis.graph)) };
}

/** Rebuild and persist Plane A. Store lifetime is owned by the application service. */
export function indexRepository(root: string, indexedAt: string): RepositoryIndex {
  if (!Number.isFinite(Date.parse(indexedAt)) || new Date(indexedAt).toISOString() !== indexedAt) {
    throw new SemctxError("INVALID_TASK_INPUT", "indexedAt must be a canonical ISO-8601 timestamp", { indexedAt });
  }
  const repositoryRoot = canonicalRepositoryRoot(root);
  const configBefore = loadConfig(root);
  const gitBefore = captureGitState(root);
  const filesBefore = discoverFiles(configBefore);
  const analysisInputHash = fingerprintAnalysisInputs(configBefore, filesBefore);
  const semanticBefore = loadSemanticModel(root);
  const semanticModelHash = fingerprintSemanticModel(semanticBefore.model);
  const errors = semanticBefore.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0 || semanticBefore.duplicateIds.length > 0) {
    throw new SemctxError("CONFIG_INVALID", "semantic model cannot be sealed during indexing", {
      diagnostics: errors,
      duplicateIds: semanticBefore.duplicateIds,
    });
  }
  const indexed = analyzeAndBuildClaims(configBefore, filesBefore);
  const configAfter = loadConfig(root);
  const filesAfter = discoverFiles(configAfter);
  const analysisInputHashAfter = fingerprintAnalysisInputs(configAfter, filesAfter);
  const semanticAfter = loadSemanticModel(root);
  const semanticModelHashAfter = fingerprintSemanticModel(semanticAfter.model);
  const gitAfter = captureGitState(root);
  if (
    gitBefore.headCommit !== gitAfter.headCommit
    || gitBefore.workingDiffHash !== gitAfter.workingDiffHash
    || analysisInputHash !== analysisInputHashAfter
    || semanticModelHash !== semanticModelHashAfter
  ) {
    throw new SemctxError("GIT_ERROR", "repository inputs changed while the index was being built", {
      before: gitBefore,
      after: gitAfter,
      analysisInputHash,
      analysisInputHashAfter,
      semanticModelHash,
      semanticModelHashAfter,
    });
  }
  const snapshot: IndexedControlSnapshot = {
    schemaVersion: 1,
    capturedAt: indexedAt,
    repositoryRoot,
    headCommit: gitAfter.headCommit,
    repositoryGraphHash: fingerprintRepositoryFacts({
      graph: indexed.analysis.graph,
      claims: indexed.claims,
      evidence: indexed.analysis.evidence,
    }),
    semanticModelHash: semanticModelHashAfter,
    analysisInputHash: analysisInputHashAfter,
    workingDiffHash: gitAfter.workingDiffHash,
    storeSchemaVersion: SCHEMA_VERSION,
    toolVersion: CONTROL_FRESHNESS_TOOL_VERSION,
  };
  const store = openStore(root);
  try {
    store.replaceIndex({
      graph: indexed.analysis.graph,
      evidence: indexed.analysis.evidence,
      claims: indexed.claims,
      metadata: {
        indexed_at: indexedAt,
        indexed_commit: snapshot.headCommit ?? "",
        indexed_repository_graph_hash: snapshot.repositoryGraphHash,
        [CONTROL_INDEX_SNAPSHOT_META_KEY]: JSON.stringify(snapshot),
      },
    });
  } finally {
    store.close();
  }
  return {
    ...indexed,
    freshnessSeal: buildControlFreshnessSeal({
      repositoryRoot,
      headAtCapture: gitAfter.headCommit,
      repositoryFacts: {
        graph: indexed.analysis.graph,
        claims: indexed.claims,
        evidence: indexed.analysis.evidence,
      },
      semanticModel: semanticAfter.model,
      analysisInputHash: analysisInputHashAfter,
      workingDiffHash: gitAfter.workingDiffHash,
      indexedSnapshot: snapshot,
      storeSchemaVersion: SCHEMA_VERSION,
    }),
  };
}
