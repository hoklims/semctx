import { SemctxError, attachSuppressedError, type Claim, type SemctxConfig } from "@semantic-context/core";
import { buildClaims, GraphIndex, parseObservedDiffHunks } from "@semantic-context/context-engine";
import { loadConfig, openStore, SCHEMA_VERSION } from "@semantic-context/repository-store";
import { SealedAttestationIndexV1Schema, type ControlFreshnessSeal } from "@semantic-context/control-model";
import { loadSemanticModel } from "@semantic-context/semantic-engine";
import {
  discoverRepository,
  sourceLanguage,
  type AnalysisResult,
  type DiscoveredFile,
  type DiscoveryResult,
} from "@semantic-context/ts-analyzer";
import { digestCanonical, type PlaneASidecarV1 } from "@semantic-context/plane-a-internal";
import {
  analyzeWorkspaceSync,
  type WorkspaceArtifact,
  type WorkspaceProjection,
} from "@semantic-context/workspace-analyzer-internal";
import {
  CONTROL_INDEX_SNAPSHOT_META_KEY,
  CONTROL_FRESHNESS_TOOL_VERSION,
  PLANE_A_INDEX_SNAPSHOT_META_KEY,
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
import { analyzePlaneARuntime } from "./plane-a-runtime";
import {
  createPlaneAIndexSnapshot,
} from "./index-health";
import {
  UNRESOLVED_REFERENCE_INDEX_META_KEY,
  createUnresolvedReferenceIndex,
} from "./unresolved-references";

export interface RepositoryAnalysis {
  analysis: AnalysisResult;
  claims: Claim[];
}

export interface RepositoryIndex extends RepositoryAnalysis {
  freshnessSeal: ControlFreshnessSeal;
}

interface InternalRepositoryAnalysis extends RepositoryAnalysis {
  sidecar: PlaneASidecarV1;
  workspaceProjection: WorkspaceProjection;
}

type IndexRepositoryCaptureBarrier = () => void;

let indexRepositoryCaptureBarrierForTesting: IndexRepositoryCaptureBarrier | undefined;

/**
 * Internal deterministic TOCTOU injection point. Intentionally absent from the package root
 * exports so production consumers cannot depend on test orchestration.
 */
export function __setIndexRepositoryCaptureBarrierForTesting(
  barrier: IndexRepositoryCaptureBarrier | undefined,
): void {
  indexRepositoryCaptureBarrierForTesting = barrier;
}

function crossIndexRepositoryCaptureBarrier(): void {
  const barrier = indexRepositoryCaptureBarrierForTesting;
  indexRepositoryCaptureBarrierForTesting = undefined;
  barrier?.();
}

function discoveryForFiles(files: readonly DiscoveredFile[]): DiscoveryResult {
  return {
    files: [...files],
    candidates: [...files]
      .map((file) => ({
        relPath: file.relPath,
        language: file.language ?? sourceLanguage(file.relPath),
        selectionDecision: "selected" as const,
        reason: "SELECTED" as const,
      }))
      .sort((left, right) =>
        left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0),
  };
}

function analyzeAndBuildClaimsInternal(
  config: SemctxConfig,
  discovery: DiscoveryResult,
): InternalRepositoryAnalysis {
  const runtime = analyzePlaneARuntime(config, discovery);
  return {
    analysis: runtime.analysis,
    claims: buildClaims(new GraphIndex(runtime.analysis.graph)),
    sidecar: runtime.sidecar,
    workspaceProjection: runtime.workspaceProjection,
  };
}

/** Application boundary for filesystem analysis followed by graph-derived claim construction. */
export function analyzeAndBuildClaims(config: SemctxConfig, files?: readonly DiscoveredFile[]): RepositoryAnalysis {
  const discovery = files === undefined ? discoverRepository(config) : discoveryForFiles(files);
  const { analysis, claims } = analyzeAndBuildClaimsInternal(config, discovery);
  return { analysis, claims };
}

function workspaceArtifacts(analysis: AnalysisResult): WorkspaceArtifact[] {
  return analysis.graph.nodes
    .filter((node): node is typeof node & {
      filePath: string;
      kind: WorkspaceArtifact["kind"];
    } =>
      node.filePath !== undefined
      && (
        node.kind === "module"
        || node.kind === "test"
        || node.kind === "document"
        || node.kind === "migration"
      ))
    .map((node) => ({ id: node.id, kind: node.kind, filePath: node.filePath }))
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
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
  let discoveryBefore: DiscoveryResult | undefined = discoverRepository(configBefore);
  const analysisInputHash = fingerprintAnalysisInputs(configBefore, discoveryBefore.files);
  const discoveryLedgerDigest = digestCanonical(discoveryBefore.candidates);
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
  const indexed = analyzeAndBuildClaimsInternal(configBefore, discoveryBefore);
  // Drop the full-source corpus before the second TOCTOU discovery on large repositories.
  // eslint-disable-next-line no-useless-assignment -- the assignment shortens the live heap interval
  discoveryBefore = undefined;
  crossIndexRepositoryCaptureBarrier();
  const configAfter = loadConfig(root);
  const discoveryAfter = discoverRepository(configAfter);
  const analysisInputHashAfter = fingerprintAnalysisInputs(configAfter, discoveryAfter.files);
  const discoveryLedgerDigestAfter = digestCanonical(discoveryAfter.candidates);
  const workspaceProjectionDigest = digestCanonical(indexed.workspaceProjection);
  const workspaceProjectionAfter = analyzeWorkspaceSync({
    repositoryRoot: configAfter.repositoryRoot,
    repositoryId: indexed.workspaceProjection.repositoryId,
    artifacts: workspaceArtifacts(indexed.analysis),
  });
  const workspaceProjectionDigestAfter = digestCanonical(workspaceProjectionAfter);
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
    || discoveryLedgerDigest !== discoveryLedgerDigestAfter
    || workspaceProjectionDigest !== workspaceProjectionDigestAfter
    || semanticModelHash !== semanticModelHashAfter
    || observedIndexBefore.indexHash !== observedIndex.indexHash
    || JSON.stringify(lifecycleBefore) !== JSON.stringify(lifecycleAfter)
  ) {
    throw new SemctxError("GIT_ERROR", "repository inputs changed while the index was being built", {
      before: gitBefore,
      after: gitAfter,
      analysisInputHash,
      analysisInputHashAfter,
      discoveryLedgerDigest,
      discoveryLedgerDigestAfter,
      workspaceProjectionDigest,
      workspaceProjectionDigestAfter,
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
    const repositoryGraphHash = fingerprintRepositoryFacts({
      graph: indexed.analysis.graph,
      claims: indexed.claims,
      evidence: indexed.analysis.evidence,
    });
    // The gap belongs to the indexed state, so it is written with it and hashed into the same
    // snapshot: a later reader sees the same diagnostic, and a tampered record fails its own hash.
    const unresolvedReferenceIndex = createUnresolvedReferenceIndex(
      indexed.analysis.unresolvedReferences,
    );
    const planeAIndexSnapshot = createPlaneAIndexSnapshot({
      capturedAt: indexedAt,
      repositoryGraphHash,
      unresolvedReferenceIndexHash: unresolvedReferenceIndex.indexHash,
      sidecar: indexed.sidecar,
      workspace: indexed.workspaceProjection,
    });
    const planeAIndexSnapshotHash = digestCanonical(planeAIndexSnapshot);
    const snapshot: IndexedControlSnapshot = {
      schemaVersion: 2,
      capturedAt: indexedAt,
      repositoryRoot,
      headCommit: gitAfter.headCommit,
      repositoryGraphHash,
      semanticModelHash: semanticModelHashAfter,
      analysisInputHash: analysisInputHashAfter,
      workingDiffHash: gitAfter.workingDiffHash,
      storeSchemaVersion: SCHEMA_VERSION,
      toolVersion: CONTROL_FRESHNESS_TOOL_VERSION,
      observedHunkIndexHash: observedIndex.indexHash,
      attestationSetHash,
      // Unconditional, at either config version: this is the only field that authorizes a given
      // Plane-A snapshot, and through it the unresolved-reference record hashed inside it. Binding
      // it for v2 alone left a v1 index unable to tell its own snapshot from a rewritten one.
      planeAIndexSnapshotHash: planeAIndexSnapshotHash as `sha256:${string}`,
    };
    store.replaceIndex({
      graph: indexed.analysis.graph,
      evidence: indexed.analysis.evidence,
      claims: indexed.claims,
      metadata: {
        indexed_at: indexedAt,
        indexed_commit: snapshot.headCommit ?? "",
        indexed_repository_graph_hash: snapshot.repositoryGraphHash,
        [PLANE_A_INDEX_SNAPSHOT_META_KEY]: JSON.stringify(planeAIndexSnapshot),
        [UNRESOLVED_REFERENCE_INDEX_META_KEY]: JSON.stringify(unresolvedReferenceIndex),
        [CONTROL_OBSERVED_HUNK_INDEX_META_KEY]: JSON.stringify(observedIndex),
        [CONTROL_INDEX_SNAPSHOT_META_KEY]: JSON.stringify(snapshot),
      },
    });
    const result = {
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
        planeAIndexSnapshotHash: planeAIndexSnapshotHash as `sha256:${string}`,
      }),
    };
    store.close();
    return result;
  } catch (error) {
    const operationError = error instanceof SyntaxError
      ? new SemctxError("STORE_ERROR", "invalid persisted control attestation index", {
        cause: error.message,
      })
      : error;
    let cleanupFailure: unknown;
    try {
      store.close();
    } catch (closeError) {
      cleanupFailure = closeError;
    }
    throw cleanupFailure === undefined
      ? operationError
      : attachSuppressedError(operationError, cleanupFailure);
  }
}
