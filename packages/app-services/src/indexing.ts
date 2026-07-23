import { SemctxError, type Claim, type SemctxConfig } from "@semantic-context/core";
import { buildClaims, GraphIndex, parseObservedDiffHunks } from "@semantic-context/context-engine";
import { loadConfig, openStore, SCHEMA_VERSION } from "@semantic-context/repository-store";
import { SealedAttestationIndexV1Schema, type ControlFreshnessSeal } from "@semantic-context/control-model";
import { loadSemanticModel } from "@semantic-context/semantic-engine";
import { analyzeRepository, discoverFiles, type AnalysisResult, type DiscoveredFile } from "@semantic-context/ts-analyzer";
import {
  CONTROL_INDEX_SNAPSHOT_META_KEY,
  CONTROL_FRESHNESS_TOOL_VERSION,
  buildControlFreshnessSeal,
  canonicalRepositoryRoot,
  captureGitState,
  captureTrackedWorkingDiff,
  controlRepositoryIdentity,
  fingerprintAnalysisInputs,
  fingerprintRepositoryFacts,
  fingerprintSemanticModel,
  type IndexedControlSnapshot,
} from "./freshness";
import {
  CONTROL_OBSERVED_HUNK_INDEX_META_KEY,
  createObservedHunkIndex,
} from "./control-evidence";
import { CONTROL_ATTESTATION_INDEX_META_KEY } from "./control-queries";
import { inspectSemanticLifecycle } from "./semantic-check";

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
  const repositoryIdentity = controlRepositoryIdentity(root);
  const trackedDiffBefore = captureTrackedWorkingDiff(root);
  const observedHunksBefore = parseObservedDiffHunks({
    repositoryIdentity,
    diffBytes: trackedDiffBefore,
  });
  const filesBefore = discoverFiles(configBefore);
  const analysisInputHash = fingerprintAnalysisInputs(configBefore, filesBefore);
  const semanticBefore = loadSemanticModel(root);
  const lifecycleBefore = inspectSemanticLifecycle(root, semanticBefore.model.changes);
  const semanticModelHash = fingerprintSemanticModel(semanticBefore.model);
  const errors = semanticBefore.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const lifecycleErrors = lifecycleBefore.filter((finding) => finding.severity === "error");
  if (errors.length > 0 || semanticBefore.duplicateIds.length > 0 || lifecycleErrors.length > 0) {
    throw new SemctxError("CONFIG_INVALID", "semantic model cannot be sealed during indexing", {
      diagnostics: errors,
      duplicateIds: semanticBefore.duplicateIds,
      lifecycleFindings: lifecycleErrors,
    });
  }
  const indexed = analyzeAndBuildClaims(configBefore, filesBefore);
  const configAfter = loadConfig(root);
  const filesAfter = discoverFiles(configAfter);
  const analysisInputHashAfter = fingerprintAnalysisInputs(configAfter, filesAfter);
  const semanticAfter = loadSemanticModel(root);
  const lifecycleAfter = inspectSemanticLifecycle(root, semanticAfter.model.changes);
  const semanticModelHashAfter = fingerprintSemanticModel(semanticAfter.model);
  const gitAfter = captureGitState(root);
  const trackedDiffAfter = captureTrackedWorkingDiff(root);
  const observedHunksAfter = parseObservedDiffHunks({
    repositoryIdentity,
    diffBytes: trackedDiffAfter,
  });
  const observedIndex = createObservedHunkIndex(
    repositoryIdentity,
    gitAfter.workingDiffHash,
    observedHunksAfter,
  );
  const observedIndexBefore = createObservedHunkIndex(
    repositoryIdentity,
    gitBefore.workingDiffHash,
    observedHunksBefore,
  );
  if (
    gitBefore.headCommit !== gitAfter.headCommit
    || gitBefore.workingDiffHash !== gitAfter.workingDiffHash
    || analysisInputHash !== analysisInputHashAfter
    || semanticModelHash !== semanticModelHashAfter
    || observedIndexBefore.indexHash !== observedIndex.indexHash
    || JSON.stringify(lifecycleBefore) !== JSON.stringify(lifecycleAfter)
  ) {
    throw new SemctxError("GIT_ERROR", "repository inputs changed while the index was being built", {
      before: gitBefore,
      after: gitAfter,
      analysisInputHash,
      analysisInputHashAfter,
      semanticModelHash,
      semanticModelHashAfter,
      lifecycleBefore,
      lifecycleAfter,
    });
  }
  const store = openStore(root);
  try {
    const attestationValue = store.getMeta(CONTROL_ATTESTATION_INDEX_META_KEY);
    const parsedAttestations = attestationValue === undefined
      ? null
      : SealedAttestationIndexV1Schema.safeParse(JSON.parse(attestationValue));
    const attestationSetHash = parsedAttestations?.success === true
      ? parsedAttestations.data.attestationSetHash
      : null;
    const snapshot: IndexedControlSnapshot = {
      schemaVersion: 2,
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
      observedHunkIndexHash: observedIndex.indexHash,
      attestationSetHash,
    };
    store.replaceIndex({
      graph: indexed.analysis.graph,
      evidence: indexed.analysis.evidence,
      claims: indexed.claims,
      metadata: {
        indexed_at: indexedAt,
        indexed_commit: snapshot.headCommit ?? "",
        indexed_repository_graph_hash: snapshot.repositoryGraphHash,
        [CONTROL_OBSERVED_HUNK_INDEX_META_KEY]: JSON.stringify(observedIndex),
        [CONTROL_INDEX_SNAPSHOT_META_KEY]: JSON.stringify(snapshot),
      },
    });
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
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SemctxError("STORE_ERROR", "invalid persisted control attestation index", {
        cause: error.message,
      });
    }
    throw error;
  } finally {
    store.close();
  }
}
