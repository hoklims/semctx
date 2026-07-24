import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  SemctxError,
  type EvidenceRecord,
  type RepositoryGraph,
} from "@semantic-context/core";
import { parseObservedDiffHunks } from "@semantic-context/context-engine/observed-diff";
import {
  buildCoordinateGraph,
  buildObservationAnalysis,
  compareArchitectures,
  fingerprintCoordinateGraph,
  reconcileDiff,
  snapshotArchitecture,
  type CandidatePathAnalysisV1,
  type CandidateSourceChangeV1,
  type ReconciliationCaptureV1,
} from "@semantic-context/control-engine/reconciliation";
import {
  compileSemanticChangeSet,
  compileTaskEnvelope,
  type AuthoredLinkResolutionInputV1,
  type CompileSemanticChangeSetInput,
  type ExplicitDiscoveryInputV1,
  type TaskFrameAdvisoryV1,
  type TargetSelectionInputV1,
} from "@semantic-context/control-engine/planning";
import {
  CandidateAnchorV1Schema,
  CanonicalRepoRelativePathSchema,
  PlanningBundleV1Schema,
  RefinementProfileV1Schema,
  RepositoryEditExpectationV1Schema,
  ReconciliationAnalysisV1Schema,
  ReconcileWorkingTreeInputV1Schema,
  ResolvedBindingScopeV1Schema,
  SemanticExpectationV1Schema,
  TargetReferenceV1Schema,
  computePlanningBundleV1Hash,
  computeRefinementRelationDigest,
  computeReconciliationAnalysisV1Hash,
  computeReconciliationArchitectureDeltaV1Hash,
  computeSemanticChangeSetV1Hash,
  compareCodeUnits,
  normalizeReconciliationAnalysisV1,
  normalizePlanningBundleV1,
  normalizeSemanticChangeSetV1,
  sha256HashCanonicalJson,
  sha256HashUtf8,
  type CandidateAnchorV1,
  type CoordinateGraphReportV2,
  type EvidenceEvaluationV1,
  type ObservedDiffHunkV1,
  type PlanningBundleV1,
  type ReconciliationAnalysisV1,
  type ReconciliationEvidenceInputV1,
  type ReconciliationRoundTripCoverageV1,
  type ReconcileDiffReportV1,
  type ReconcileWorkingTreeInputV1,
  type RepositoryEditExpectationV1,
  type SemanticChangeSetV1,
  type SemanticExpectationV1,
  type RefinementProfileV1,
  type Sha256Hash,
  type TaskEnvelopeV1,
  type WorkspaceBaselineSnapshotV1,
} from "@semantic-context/control-model/reconciliation";
import {
  ReconciliationRepositoryLinkSchema,
} from "@semantic-context/semantic-model/reconciliation-read";
import {
  loadSemanticModel,
  loadTargetArtifact,
  type TargetArchitectureArtifactV1,
} from "@semantic-context/semantic-engine/reconciliation-read";
import {
  SCHEMA_VERSION,
  loadConfig,
} from "@semantic-context/repository-store";
import { analyzeRepository, discoverFiles } from "@semantic-context/ts-analyzer";
import {
  CONTROL_FRESHNESS_TOOL_VERSION,
  CONTROL_INDEX_SNAPSHOT_META_KEY,
  buildControlFreshnessSeal,
  canonicalRepositoryRoot,
  captureGitState,
  controlRepositoryIdentity,
  evaluateControlFreshness,
  fingerprintAnalysisInputs,
  fingerprintSemanticModel,
  parseIndexedControlSnapshot,
  type GitStateCapture,
  type IndexedControlSnapshot,
} from "./freshness";
import { openReadyRepository } from "./readiness";

const CONTROL_ATTESTATION_INDEX_META_KEY = "control_attestation_index_v1";

export interface PrepareTaskEnvelopeCommandV1 {
  schemaVersion: 1;
  taskFrameId: string;
  changeId: string;
  taskFrameAdvisory?: TaskFrameAdvisoryV1;
  candidateAnchors?: readonly CandidateAnchorV1[];
  authoredLinkResolutions?: readonly AuthoredLinkResolutionInputV1[];
  explicitDiscoveries?: readonly ExplicitDiscoveryInputV1[];
  targetSelection?: TargetSelectionInputV1;
}

export interface PreparedTaskEnvelopeV1 {
  schemaVersion: 1;
  kind: "prepared_task_envelope";
  certifying: false;
  envelope: TaskEnvelopeV1;
  baseline: WorkspaceBaselineSnapshotV1;
}

export interface BuildPlanningBundleCommandV1 extends PrepareTaskEnvelopeCommandV1 {
  semanticExpectations?: readonly SemanticExpectationV1[];
  repositoryEditExpectations?: readonly RepositoryEditExpectationV1[];
  rollbackDescription: string;
  testReferences?: readonly string[];
  acceptanceEvidenceIds?: readonly string[];
  proofObligationIds?: readonly string[];
}

const NonEmptyCommandIdSchema = z.string().min(1);
const RepositoryCoordinateIdSchema = z.string().regex(/^repo:.+$/);
const BindingEvidenceProvenanceSchema = z.enum([
  "plane_b_source",
  "static_analysis",
  "test",
  "manual_discovery",
]);
const TaskFrameAdvisoryV1Schema = z.object({
  profileCandidate: RefinementProfileV1Schema.optional(),
  altitudeCandidate: z.number().int().min(0).max(6).optional(),
}).strict();
const AuthoredLinkResolutionInputV1Schema = z.object({
  link: ReconciliationRepositoryLinkSchema,
  resolved: z.boolean(),
  coordinateId: RepositoryCoordinateIdSchema.optional(),
  repositoryPath: CanonicalRepoRelativePathSchema.optional(),
  evidenceId: NonEmptyCommandIdSchema.optional(),
  evidenceProvenance: BindingEvidenceProvenanceSchema.optional(),
  scope: ResolvedBindingScopeV1Schema.optional(),
}).strict();
const ExplicitDiscoveryInputV1Schema = z.object({
  coordinateId: RepositoryCoordinateIdSchema,
  repositoryPath: CanonicalRepoRelativePathSchema,
  evidenceId: NonEmptyCommandIdSchema,
  evidenceProvenance: BindingEvidenceProvenanceSchema.exclude(["plane_b_source"]),
  scope: ResolvedBindingScopeV1Schema,
}).strict();
const TargetSelectionInputV1Schema = z.object({
  reference: TargetReferenceV1Schema,
}).strict();

export const PrepareTaskEnvelopeCommandV1Schema = z.object({
  schemaVersion: z.literal(1),
  taskFrameId: NonEmptyCommandIdSchema,
  changeId: NonEmptyCommandIdSchema,
  taskFrameAdvisory: TaskFrameAdvisoryV1Schema.optional(),
  candidateAnchors: z.array(CandidateAnchorV1Schema).optional(),
  authoredLinkResolutions: z.array(AuthoredLinkResolutionInputV1Schema).optional(),
  explicitDiscoveries: z.array(ExplicitDiscoveryInputV1Schema).optional(),
  targetSelection: TargetSelectionInputV1Schema.optional(),
}).strict();

export const BuildPlanningBundleCommandV1Schema = PrepareTaskEnvelopeCommandV1Schema.extend({
  semanticExpectations: z.array(SemanticExpectationV1Schema).optional(),
  repositoryEditExpectations: z.array(RepositoryEditExpectationV1Schema).optional(),
  rollbackDescription: z.string().min(1),
  testReferences: z.array(NonEmptyCommandIdSchema).optional(),
  acceptanceEvidenceIds: z.array(NonEmptyCommandIdSchema).optional(),
  proofObligationIds: z.array(NonEmptyCommandIdSchema).optional(),
}).strict();

interface CapturedPlanningInputs {
  taskFrame: NonNullable<ReturnType<ReturnType<typeof openReadyRepository>["getTaskFrame"]>>;
  change: ReturnType<typeof loadSemanticModel>["model"]["changes"][number];
  graph: CoordinateGraphReportV2;
  graphSeal: Sha256Hash;
  indexSeal: Sha256Hash;
  semanticModelHash: Sha256Hash;
  analysisInputHash: Sha256Hash;
  analyzerConfigHash: Sha256Hash;
  indexedSnapshot: IndexedControlSnapshot;
  git: GitStateCapture & { headCommit: string; workingDiffHash: Sha256Hash };
  freshnessSealHash: Sha256Hash;
  cleanliness: WorkspaceBaselineSnapshotV1["cleanliness"];
}

/**
 * Compile a diagnostic-only envelope from persisted Plane A/B inputs.
 * No part of this operation writes, indexes, reviews a target, or authorizes execution.
 */
export function prepareTaskEnvelope(
  root: string,
  command: PrepareTaskEnvelopeCommandV1,
): PreparedTaskEnvelopeV1 {
  const parsed = PrepareTaskEnvelopeCommandV1Schema.parse(
    command,
  ) as PrepareTaskEnvelopeCommandV1;
  return prepareTaskEnvelopeFromValidatedCommand(root, parsed);
}

function prepareTaskEnvelopeFromValidatedCommand(
  root: string,
  command: PrepareTaskEnvelopeCommandV1,
): PreparedTaskEnvelopeV1 {
  const captured = capturePlanningInputs(root, command.taskFrameId, command.changeId);
  const envelope = compileTaskEnvelope({
    taskFrame: captured.taskFrame,
    ...(command.taskFrameAdvisory === undefined ? {} : { taskFrameAdvisory: command.taskFrameAdvisory }),
    change: captured.change,
    graph: captured.graph,
    planningCommit: captured.git.headCommit,
    graphSeal: captured.graphSeal,
    indexSeal: captured.indexSeal,
    baselineFreshnessSeal: captured.freshnessSealHash,
    candidateAnchors: command.candidateAnchors ?? [],
    authoredLinkResolutions: command.authoredLinkResolutions ?? [],
    explicitDiscoveries: command.explicitDiscoveries ?? [],
    ...(command.targetSelection === undefined ? {} : { targetSelection: command.targetSelection }),
  });
  assertCaptureStable(root, captured);
  return {
    schemaVersion: 1,
    kind: "prepared_task_envelope",
    certifying: false,
    envelope,
    baseline: baselineFrom(captured),
  };
}

/**
 * Sole public constructor for a certifying PlanningBundle.
 *
 * The returned object still has executionAuthority "none". A DIRTY_KNOWN
 * baseline remains structurally valid but can only reconcile to UNPROVEN.
 */
export function buildPlanningBundle(
  root: string,
  command: BuildPlanningBundleCommandV1,
): PlanningBundleV1 {
  const parsedCommand = BuildPlanningBundleCommandV1Schema.parse(
    command,
  ) as BuildPlanningBundleCommandV1;
  const prepared = prepareTaskEnvelopeFromValidatedCommand(root, parsedCommand);
  let changeSet = compileSemanticChangeSet({
    envelope: prepared.envelope,
    ...(parsedCommand.semanticExpectations === undefined
      ? {}
      : { semanticExpectations: parsedCommand.semanticExpectations }),
    ...(parsedCommand.repositoryEditExpectations === undefined
      ? {}
      : { repositoryEditExpectations: parsedCommand.repositoryEditExpectations }),
    rollbackDescription: parsedCommand.rollbackDescription,
    ...(parsedCommand.testReferences === undefined
      ? {}
      : { testReferences: parsedCommand.testReferences }),
    ...(parsedCommand.acceptanceEvidenceIds === undefined
      ? {}
      : { acceptanceEvidenceIds: parsedCommand.acceptanceEvidenceIds }),
    ...(parsedCommand.proofObligationIds === undefined
      ? {}
      : { proofObligationIds: parsedCommand.proofObligationIds }),
  } satisfies CompileSemanticChangeSetInput);
  const authoredChange = loadSemanticModel(root).model.changes.find(
    (change) => change.id === prepared.envelope.changeId,
  );
  if (authoredChange === undefined) refuse("Plane B change disappeared during planning");
  changeSet = bindChangeContractEvidence(changeSet, authoredChange.requiresEvidence);

  let acceptedTargetBinding: PlanningBundleV1["acceptedTargetBinding"];
  if (prepared.envelope.authoredTargetBinding !== undefined) {
    loadAcceptedTarget(root, prepared.envelope.authoredTargetBinding);
    acceptedTargetBinding = prepared.envelope.authoredTargetBinding;
    changeSet = bindAcceptedTarget(changeSet, acceptedTargetBinding);
  }

  const payload: Omit<PlanningBundleV1, "bundleHash"> = {
    schemaVersion: 1,
    kind: "planning_bundle",
    executionAuthority: "none",
    bundleId: `planning-bundle:${shortDigest({
      envelopeHash: prepared.envelope.envelopeHash,
      changeSetHash: changeSet.changeSetHash,
      baseline: prepared.baseline,
      acceptedTargetBinding,
    })}`,
    planningCommit: prepared.envelope.planningCommit,
    taskEnvelope: prepared.envelope,
    semanticChangeSet: changeSet,
    baseline: prepared.baseline,
    ...(acceptedTargetBinding === undefined ? {} : { acceptedTargetBinding }),
  };
  const normalized = normalizePlanningBundleV1({
    ...payload,
    bundleHash: sha256HashUtf8("pending"),
  });
  return PlanningBundleV1Schema.parse({
    ...normalized,
    bundleHash: computePlanningBundleV1Hash(normalized),
  }) as PlanningBundleV1;
}

/**
 * Observe and reconcile the current worktree against one sealed bundle.
 * Caller-selected base/head refs, evidence bodies, and execution commands are
 * impossible at this boundary because the input schema contains only the bundle.
 */
export function reconcileWorkingTree(
  root: string,
  input: ReconcileWorkingTreeInputV1,
): ReconcileDiffReportV1 {
  const parsed = ReconcileWorkingTreeInputV1Schema.parse(input) as ReconcileWorkingTreeInputV1;
  const before = captureReconciliationInputs(root, parsed.planningBundle);
  runReconciliationTestHook("after_initial_capture", root);
  const observedHunks = observeWorkingHunks(root);
  const candidate = analyzeCandidate(root, parsed.planningBundle, before, observedHunks);
  const sealedAnalysis = buildSealedReconciliationAnalysis(
    root,
    parsed.planningBundle,
    before,
    observedHunks,
    candidate,
  );
  runReconciliationTestHook("before_final_capture", root);
  const after = captureReconciliationInputs(root, parsed.planningBundle);
  const stable = captureToken(before) === captureToken(after);
  const capture: ReconciliationCaptureV1 = {
    observedCommit: before.git.headCommit ?? "unborn",
    observedWorkingDiffHash: sealedAnalysis.observedDiffHash,
    currentHead: before.git.headCommit ?? "unborn",
    indexCommit: before.indexedSnapshot?.headCommit ?? "unsealed",
    baselineSealHash: parsed.planningBundle.baseline.freshnessSealHash,
    coordinateGraphSeal: before.graphSeal,
    indexSeal: before.indexSeal,
    sourceSealMatched: before.graphSeal === parsed.planningBundle.taskEnvelope.coordinateGraphSeal,
    indexFresh: before.indexSeal === parsed.planningBundle.taskEnvelope.indexSeal,
    controlInputsSealed: before.indexedSnapshot !== null,
    gitStateBefore: sha256HashCanonicalJson(before.git),
    gitStateAfter: sha256HashCanonicalJson(after.git),
    candidateBytesStable: stable,
    semanticModelHash: before.semanticModelHash,
    analyzerConfigHash: before.analyzerConfigHash,
    toolVersion: CONTROL_FRESHNESS_TOOL_VERSION,
    storeSchemaVersion: SCHEMA_VERSION,
    attestationSetHash: before.indexedSnapshot?.schemaVersion === 2
      ? before.indexedSnapshot.attestationSetHash
      : null,
    reconciliationAnalysisHash: sealedAnalysis.analysisHash,
  };
  return reconcileDiff({
    planningBundle: parsed.planningBundle,
    capture,
    sealedAnalysis,
  });
}

function buildSealedReconciliationAnalysis(
  root: string,
  bundle: PlanningBundleV1,
  captured: ReconciliationInputs,
  observedHunks: readonly ObservedDiffHunkV1[],
  candidate: ReturnType<typeof buildObservationAnalysis>,
): ReconciliationAnalysisV1 {
  const architectureDelta = compareArchitectures(
    captured.baselineArchitecture,
    candidate.candidateArchitecture,
  ).delta;
  const hunkBindings = bindObservedHunks(
    observedHunks,
    captured.graph,
    candidate.candidateGraph,
    bundle.semanticChangeSet.repositoryEditExpectations,
    candidate.analysis,
  );
  const targetContext = loadTargetContext(root, bundle, captured);
  const proof = deriveProofPipeline(
    bundle,
    captured,
    candidate,
    observedHunks,
    hunkBindings,
    targetContext,
  );
  const target = targetAnalysis(
    targetContext,
    candidate.candidateArchitecture,
    proof.evaluations,
  );
  const draft = normalizeReconciliationAnalysisV1({
    schemaVersion: 1,
    kind: "reconciliation_analysis",
    executionAuthority: "none",
    planningBundleHash: bundle.bundleHash,
    planningCommit: bundle.planningCommit,
    observedDiffHash: candidate.analysis.candidateDiffHash,
    observationAnalysis: candidate.analysis,
    candidateGraphHash: candidate.analysis.candidateGraphHash,
    baselineArchitectureHash: sha256HashCanonicalJson(captured.baselineArchitecture),
    candidateArchitectureHash: candidate.analysis.candidateArchitectureHash,
    architectureDeltaHash: computeReconciliationArchitectureDeltaV1Hash(architectureDelta),
    observedHunks,
    hunkBindings,
    architectureDelta,
    liftedImpacts: proof.liftedImpacts,
    evidenceInputs: proof.inputs,
    evidenceEvaluations: proof.evaluations,
    roundTripCoverages: proof.roundTrips,
    ...(target === undefined ? {} : { targetAnalysis: target }),
    traversalBudgetExhausted: proof.traversalBudgetExhausted,
    advisoryDiagnostics: candidate.analysis.incompleteReasons
      .filter((reason) => reason === "ANALYZER_FAILURE")
      .map(() => ({
      code: "ANALYZER_FAILURE" as const,
      message: "Candidate observation is incomplete: ANALYZER_FAILURE.",
      subjectIds: observedHunks.map((hunk) => hunk.identity),
    })),
    analysisHash: sha256HashUtf8("pending"),
  });
  return ReconciliationAnalysisV1Schema.parse({
    ...draft,
    analysisHash: computeReconciliationAnalysisV1Hash(draft),
  }) as ReconciliationAnalysisV1;
}

interface ReconciliationInputs {
  git: GitStateCapture;
  indexedSnapshot: IndexedControlSnapshot | null;
  graph: CoordinateGraphReportV2;
  graphSeal: Sha256Hash;
  indexSeal: Sha256Hash;
  semanticModelHash: Sha256Hash;
  analysisInputHash: Sha256Hash;
  analyzerConfigHash: Sha256Hash;
  baselineArchitecture: ReturnType<typeof snapshotArchitecture>;
  repositoryGraph: RepositoryGraph;
  repositoryEvidence: readonly EvidenceRecord[];
  semanticModel: ReturnType<typeof loadSemanticModel>["model"];
}

function capturePlanningInputs(
  root: string,
  taskFrameId: string,
  changeId: string,
): CapturedPlanningInputs {
  const reader = openReadyRepository(root);
  try {
    const taskFrame = reader.getTaskFrame(taskFrameId);
    if (taskFrame === undefined) refuse(`persisted TaskFrame not found: ${taskFrameId}`);
    const captured = captureReadInputs(root, reader);
    if (captured.git.headCommit === null || captured.git.workingDiffHash === null) {
      refuse("planning requires a committed Git repository");
    }
    if (captured.indexedSnapshot === null) refuse("planning requires a sealed control index");
    const change = captured.semanticModel.changes.find((candidate) => candidate.id === changeId);
    if (change === undefined) refuse(`Plane B change not found: ${changeId}`);
    const freshnessSeal = buildControlFreshnessSeal({
      repositoryRoot: canonicalRepositoryRoot(root),
      headAtCapture: captured.git.headCommit,
      repositoryFacts: {
        graph: captured.repositoryGraph,
        claims: reader.loadClaims(),
        evidence: reader.loadEvidence(),
      },
      semanticModel: captured.semanticModel,
      analysisInputHash: captured.analysisInputHash,
      workingDiffHash: captured.git.workingDiffHash,
      indexedSnapshot: captured.indexedSnapshot,
      storeSchemaVersion: SCHEMA_VERSION,
    });
    const verdict = evaluateControlFreshness(freshnessSeal).verdict;
    if (verdict !== "FRESH" && verdict !== "DIRTY_KNOWN") {
      refuse(`planning control inputs are ${verdict}`);
    }
    return {
      taskFrame,
      change,
      graph: captured.graph,
      graphSeal: captured.graphSeal,
      indexSeal: captured.indexSeal,
      semanticModelHash: captured.semanticModelHash,
      analysisInputHash: captured.analysisInputHash,
      analyzerConfigHash: captured.analyzerConfigHash,
      indexedSnapshot: captured.indexedSnapshot,
      git: {
        headCommit: captured.git.headCommit,
        workingDiffHash: captured.git.workingDiffHash,
      },
      freshnessSealHash: freshnessSeal.sealHash,
      cleanliness: verdict,
    };
  } finally {
    reader.close();
  }
}

function captureReconciliationInputs(root: string, bundle: PlanningBundleV1): ReconciliationInputs {
  const reader = openReadyRepository(root);
  try {
    return captureReadInputs(root, reader, bundle.baseline.planningCommit);
  } finally {
    reader.close();
  }
}

function captureReadInputs(
  root: string,
  reader: ReturnType<typeof openReadyRepository>,
  baselineCommit?: string,
): ReconciliationInputs {
  const git = captureGitState(root);
  const config = loadConfig(root);
  const files = discoverFiles(config);
  const analysisInputHash = fingerprintAnalysisInputs(config, files);
  const analyzerConfigHash = fingerprintAnalyzerConfig(config);
  const loaded = loadSemanticModel(root);
  const semanticErrors = loaded.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (semanticErrors.length > 0 || loaded.duplicateIds.length > 0) {
    refuse("semantic model cannot be used for reconciliation");
  }
  const repositoryGraph = reader.loadGraph();
  const repositoryEvidence = reader.loadEvidence();
  const repositoryFacts = {
    graph: repositoryGraph,
    claims: reader.loadClaims(),
    evidence: repositoryEvidence,
  };
  const graph = buildCoordinateGraph({
    repositoryFacts,
    semanticModel: loaded.model,
    verifiedEvidenceDigests: verifiedRefinementEvidenceDigests(
      loaded.model.refinementRelations ?? [],
      repositoryEvidence,
    ),
  });
  const graphSeal = `sha256:${fingerprintCoordinateGraph(graph)}` as Sha256Hash;
  const indexedSnapshot = parseIndexedControlSnapshot(reader.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY));
  const indexSeal = sha256HashCanonicalJson({
    domain: "SEMCTX_RECONCILIATION_INDEX_V1",
    indexedSnapshot,
  });
  const semanticModelHash = fingerprintSemanticModel(loaded.model);
  const identityCommit = baselineCommit ?? git.headCommit ?? "unsealed";
  return {
    git,
    indexedSnapshot,
    graph,
    graphSeal,
    indexSeal,
    semanticModelHash,
    analysisInputHash,
    analyzerConfigHash,
    baselineArchitecture: snapshotArchitecture(graph, {
      id: `baseline:${graphSeal}`,
      commit: `git:${identityCommit}`,
      capturedAt: indexedSnapshot?.capturedAt ?? "1970-01-01T00:00:00.000Z",
    }),
    repositoryGraph,
    repositoryEvidence,
    semanticModel: loaded.model,
  };
}

function verifiedRefinementEvidenceDigests(
  relations: NonNullable<ReconciliationInputs["semanticModel"]["refinementRelations"]>,
  repositoryEvidence: readonly EvidenceRecord[],
): Sha256Hash[] {
  const evidenceById = new Map(repositoryEvidence.map((evidence) => [
    evidence.id,
    sha256HashCanonicalJson(evidence),
  ]));
  return [...new Set(relations.flatMap((relation) =>
    relation.evidenceRefs.flatMap((reference) => {
      const observedDigest = evidenceById.get(reference.locator);
      const declaredDigest =
        `sha256:${reference.digest.value}` as Sha256Hash;
      return observedDigest === declaredDigest ? [declaredDigest] : [];
    })
  ))].sort();
}

function analyzeCandidate(
  root: string,
  bundle: PlanningBundleV1,
  captured: ReconciliationInputs,
  observedHunks: readonly ObservedDiffHunkV1[],
): ReturnType<typeof buildObservationAnalysis> {
  const sourceChanges = discoverSourceChanges(root);
  const changedNewPaths = sourceChanges.flatMap((change) => {
    if (change.kind === "add" || change.kind === "rename") return [change.newPath];
    if (change.kind === "modify") return [change.path];
    return [];
  });
  let candidateAnalyses: CandidatePathAnalysisV1[];
  try {
    runReconciliationTestHook("before_candidate_analysis", root);
    const config = loadConfig(root);
    const discovered = discoverFiles(config);
    const analysis = analyzeRepository(config, discovered);
    const candidateGraph = buildCoordinateGraph({
      repositoryFacts: {
        graph: analysis.graph,
        claims: [],
        evidence: analysis.evidence,
      },
      semanticModel: captured.semanticModel,
      observedHunks,
      verifiedEvidenceDigests: captured.graph.verifiedEvidenceDigests,
    });
    candidateAnalyses = changedNewPaths.map((path) => ({
      path,
      status: "analyzed",
      fragment: graphFragmentForPath(candidateGraph, path),
    }));
  } catch (error) {
    if (!isControlledAnalyzerFailure(error)) throw error;
    candidateAnalyses = changedNewPaths.map((path) => ({
      path,
      status: "failed",
    }));
  }
  return buildObservationAnalysis({
    baselineSealHash: bundle.baseline.freshnessSealHash,
    analyzerConfigHash: captured.analyzerConfigHash,
    toolVersion: CONTROL_FRESHNESS_TOOL_VERSION,
    planningCommit: bundle.planningCommit,
    baselineCapturedAt: captured.indexedSnapshot?.capturedAt ?? "1970-01-01T00:00:00.000Z",
    baselineGraph: captured.graph,
    observedHunks,
    sourceChanges,
    candidateAnalyses,
  });
}

function isControlledAnalyzerFailure(error: unknown): error is SemctxError {
  return error instanceof SemctxError
    && (error.code === "ANALYSIS_FAILED" || error.code === "UNSUPPORTED");
}

function graphFragmentForPath(
  graph: CoordinateGraphReportV2,
  path: string,
): Extract<CandidatePathAnalysisV1, { status: "analyzed" }>["fragment"] {
  const nodes = graph.nodes.filter((node) =>
    node.references.some((reference) => stripReferenceLocation(reference) === path)
  );
  const ids = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    structuralEdges: graph.structuralEdges.filter((edge) => ids.has(edge.from) || ids.has(edge.to)),
    refinementRelations: graph.refinementRelations.filter((relation) =>
      ids.has(relationEndpointId(relation.source)) || ids.has(relationEndpointId(relation.target))
    ),
    crossFileClosure: "complete",
  };
}

function discoverSourceChanges(root: string): CandidateSourceChangeV1[] {
  const records = gitBytes(root, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    "HEAD",
    "--",
    ".",
  ]);
  const parts = new TextDecoder().decode(records).split("\0");
  const changes: CandidateSourceChangeV1[] = [];
  for (let index = 0; index < parts.length;) {
    const status = parts[index++];
    if (!status) continue;
    if (status.startsWith("R")) {
      const oldPath = normalizeGitPath(parts[index++]!);
      const newPath = normalizeGitPath(parts[index++]!);
      changes.push({
        kind: "rename",
        oldPath,
        newPath,
        oldSourceDigest: digestBytes(gitBytes(root, ["show", `HEAD:${oldPath}`])),
        newSourceDigest: digestBytes(readFileSync(resolve(root, newPath))),
      });
      continue;
    }
    const path = normalizeGitPath(parts[index++]!);
    if (status === "A") {
      changes.push({
        kind: "add",
        newPath: path,
        newSourceDigest: digestBytes(readFileSync(resolve(root, path))),
      });
    } else if (status === "D") {
      changes.push({
        kind: "delete",
        oldPath: path,
        oldSourceDigest: digestBytes(gitBytes(root, ["show", `HEAD:${path}`])),
      });
    } else {
      changes.push({
        kind: "modify",
        path,
        oldSourceDigest: digestBytes(gitBytes(root, ["show", `HEAD:${path}`])),
        newSourceDigest: digestBytes(readFileSync(resolve(root, path))),
      });
    }
  }
  const untracked = listUntrackedPaths(root);
  for (const path of untracked) {
    changes.push({
      kind: "add",
      newPath: path,
      newSourceDigest: digestBytes(readFileSync(resolve(root, path))),
    });
  }
  return inferUnstagedRenames(changes)
    .sort((left, right) => sourceChangeKey(left).localeCompare(sourceChangeKey(right)));
}

function inferUnstagedRenames(
  changes: readonly CandidateSourceChangeV1[],
): CandidateSourceChangeV1[] {
  const deletesByDigest = new Map<Sha256Hash, Extract<CandidateSourceChangeV1, { kind: "delete" }>[]>();
  const addsByDigest = new Map<Sha256Hash, Extract<CandidateSourceChangeV1, { kind: "add" }>[]>();
  for (const change of changes) {
    if (change.kind === "delete") {
      deletesByDigest.set(change.oldSourceDigest, [
        ...(deletesByDigest.get(change.oldSourceDigest) ?? []),
        change,
      ]);
    } else if (change.kind === "add") {
      addsByDigest.set(change.newSourceDigest, [
        ...(addsByDigest.get(change.newSourceDigest) ?? []),
        change,
      ]);
    }
  }
  const consumed = new Set<CandidateSourceChangeV1>();
  const renames: CandidateSourceChangeV1[] = [];
  for (const [digest, deletes] of deletesByDigest) {
    const adds = addsByDigest.get(digest) ?? [];
    if (deletes.length !== 1 || adds.length !== 1) continue;
    const deleted = deletes[0]!;
    const added = adds[0]!;
    consumed.add(deleted);
    consumed.add(added);
    renames.push({
      kind: "rename",
      oldPath: deleted.oldPath,
      newPath: added.newPath,
      oldSourceDigest: deleted.oldSourceDigest,
      newSourceDigest: added.newSourceDigest,
    });
  }
  return [
    ...changes.filter((change) => !consumed.has(change)),
    ...renames,
  ];
}

function observeWorkingHunks(root: string): ObservedDiffHunkV1[] {
  const repositoryIdentity = controlRepositoryIdentity(root);
  const tracked = gitBytes(root, [
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "HEAD",
    "--",
    ".",
  ]);
  const hunks = parseObservedDiffHunks({ repositoryIdentity, diffBytes: tracked });
  const untracked = listUntrackedPaths(root);
  for (const path of untracked) {
    const bytes = readFileSync(resolve(root, path));
    if (bytes.includes(0)) continue;
    hunks.push(...parseObservedDiffHunks({
      repositoryIdentity,
      diffBytes: syntheticAddPatch(path, bytes),
    }));
  }
  return hunks.sort((left, right) => left.identity.localeCompare(right.identity));
}

function syntheticAddPatch(path: string, bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const hadFinalNewline = text.endsWith("\n");
  const lines = text.length === 0
    ? []
    : text.replace(/\n$/, "").split("\n");
  const body = lines.map((line) => `+${line}\n`).join("")
    + (!hadFinalNewline && lines.length > 0 ? "\\ No newline at end of file\n" : "");
  return new TextEncoder().encode(
    `diff --git a/${path} b/${path}\n`
      + "new file mode 100644\n"
      + `index ${"0".repeat(40)}..${digestBytes(bytes).slice("sha256:".length)}\n`
      + "--- /dev/null\n"
      + `+++ b/${path}\n`
      + `@@ -0,0 +1,${lines.length} @@\n`
      + body,
  );
}

function bindObservedHunks(
  hunks: readonly ObservedDiffHunkV1[],
  baselineGraph: CoordinateGraphReportV2,
  candidateGraph: CoordinateGraphReportV2,
  edits: readonly RepositoryEditExpectationV1[],
  observation: ReturnType<typeof buildObservationAnalysis>["analysis"],
) {
  return hunks.map((hunk) => {
    const rename = observation.changes.find((change) =>
      change.kind === "rename"
      && (
        hunk.normalizedPath === change.oldPath
        || hunk.normalizedPath === change.newPath
      )
    );
    const graph = rename?.kind === "rename"
      ? hunk.normalizedPath === rename.oldPath ? baselineGraph : candidateGraph
      : hunk.oldBlobId === null ? candidateGraph : baselineGraph;
    return {
      hunkId: hunk.identity,
      coordinateIds: repositoryCoordinatesForPath(graph, hunk.normalizedPath),
      editIds: edits
        .filter((edit) => {
          if (edit.kind === "add") return edit.newPath === hunk.normalizedPath;
          if (edit.kind === "modify") return edit.path === hunk.normalizedPath;
          if (edit.kind === "delete") return edit.oldPath === hunk.normalizedPath;
          return observation.changes.some((change) =>
            change.kind === "rename"
            && change.oldPath === edit.oldPath
            && change.newPath === edit.newPath
            && (
              hunk.normalizedPath === change.oldPath
              || hunk.normalizedPath === change.newPath
            )
          );
        })
        .map((edit) => edit.editId)
        .sort(),
    };
  });
}

function repositoryCoordinatesForPath(
  graph: CoordinateGraphReportV2,
  path: string,
): `repo:${string}`[] {
  return graph.nodes
    .filter((node): node is typeof node & { id: `repo:${string}` } =>
      node.id.startsWith("repo:")
      && node.references.some((reference) =>
        stripReferenceLocation(reference) === path
      )
    )
    .map((node) => node.id)
    .sort();
}

type ProfileProofDerivation =
  | "scope_bound"
  | "test_reference_observed"
  | "target_reviewed"
  | "invariants_preserved"
  | "replacement_present"
  | "baseline_captured"
  | "unsupported";

const PROFILE_PROOF_DERIVATIONS = {
  local_patch: {
    "profile:local_patch:scope_bound": "unsupported",
    "profile:local_patch:test_required": "unsupported",
  },
  refactor: {
    "profile:refactor:behavior_preserved": "unsupported",
    "profile:refactor:rollback_ready": "unsupported",
    "profile:refactor:test_required": "unsupported",
  },
  feature: {
    "profile:feature:acceptance_evidence": "unsupported",
    "profile:feature:rollback_ready": "unsupported",
  },
  redesign: {
    "profile:redesign:target_review_required": "unsupported",
    "profile:redesign:invariants_preserved": "unsupported",
    "profile:redesign:rollback_ready": "unsupported",
  },
  migration: {
    "profile:migration:legacy_eight_step_specialization": "unsupported",
    "profile:migration:rollback_ready": "unsupported",
  },
} as const satisfies Record<
  RefinementProfileV1,
  Readonly<Record<string, ProfileProofDerivation>>
>;

interface DerivedProofPipeline {
  inputs: ReconciliationEvidenceInputV1[];
  evaluations: EvidenceEvaluationV1[];
  liftedImpacts: ReconciliationAnalysisV1["liftedImpacts"];
  roundTrips: ReconciliationRoundTripCoverageV1[];
  traversalBudgetExhausted: boolean;
}

function deriveProofPipeline(
  bundle: PlanningBundleV1,
  captured: ReconciliationInputs,
  candidate: ReturnType<typeof buildObservationAnalysis>,
  observedHunks: readonly ObservedDiffHunkV1[],
  hunkBindings: ReconciliationAnalysisV1["hunkBindings"],
  target: TargetContext | undefined,
): DerivedProofPipeline {
  const requirements = collectEvidenceRequirements(bundle);
  const inputs: ReconciliationEvidenceInputV1[] = [];
  const evaluations: EvidenceEvaluationV1[] = [];
  for (const [requirementId, requirement] of requirements) {
    const admitted = deriveEvidenceInput(
      requirementId,
      requirement.origin,
      bundle,
      captured,
      candidate,
      hunkBindings,
      target,
    );
    if (admitted !== undefined) inputs.push(admitted);
    evaluations.push(admitted === undefined
      ? {
          schemaVersion: 1,
          requirementId,
          origin: requirement.origin,
          required: requirement.required,
          evidenceId: null,
          acceptedAttestationDigests: [],
          planningCommit: bundle.planningCommit,
          observedDiffHash: candidate.analysis.candidateDiffHash,
          semanticModelHash: captured.semanticModelHash,
          provenance: [],
          result: "missing",
        }
      : {
          schemaVersion: 1,
          requirementId,
          origin: requirement.origin,
          required: requirement.required,
          evidenceId: admitted.evidenceId,
          ...(admitted.semanticEvidenceDigest === undefined
            ? {}
            : { semanticEvidenceDigest: admitted.semanticEvidenceDigest }),
          acceptedAttestationDigests: admitted.acceptedAttestationDigests ?? [],
          planningCommit: admitted.planningCommit,
          observedDiffHash: admitted.observedDiffHash,
          semanticModelHash: admitted.semanticModelHash,
          ...(admitted.attestationSetHash === undefined
            ? {}
            : { attestationSetHash: admitted.attestationSetHash }),
          ...(admitted.observationAnalysisHash === undefined
            ? {}
            : { observationAnalysisHash: admitted.observationAnalysisHash }),
          provenance: admitted.provenance,
          result: admitted.result,
        });
  }
  const satisfiedEvidenceIds = new Set(
    evaluations.flatMap((evaluation) =>
      evaluation.result === "satisfied" && evaluation.evidenceId !== null
        ? [evaluation.evidenceId]
        : []),
  );
  const semanticLift = deriveSemanticLift(
    bundle,
    candidate.candidateGraph,
    observedHunks,
    hunkBindings,
    satisfiedEvidenceIds,
    candidate.analysis.analysisHash,
  );
  for (const structuralEvidence of semanticLift.structuralEvidence) {
    inputs.push({
      requirementId: structuralEvidence.evidenceId,
      evidenceId: structuralEvidence.evidenceId,
      semanticEvidenceDigest: structuralEvidence.digest,
      planningCommit: bundle.planningCommit,
      observedDiffHash: candidate.analysis.candidateDiffHash,
      semanticModelHash: captured.semanticModelHash,
      observationAnalysisHash: candidate.analysis.analysisHash,
      provenance: ["plane_a_observed", "plane_b_authored"],
      result: "satisfied",
    });
    evaluations.push({
      schemaVersion: 1,
      requirementId: structuralEvidence.evidenceId,
      origin: "proof_obligation",
      required: false,
      evidenceId: structuralEvidence.evidenceId,
      semanticEvidenceDigest: structuralEvidence.digest,
      acceptedAttestationDigests: [],
      planningCommit: bundle.planningCommit,
      observedDiffHash: candidate.analysis.candidateDiffHash,
      semanticModelHash: captured.semanticModelHash,
      observationAnalysisHash: candidate.analysis.analysisHash,
      provenance: ["plane_a_observed", "plane_b_authored"],
      result: "satisfied",
    });
  }
  return {
    inputs: inputs.sort((left, right) =>
      left.requirementId.localeCompare(right.requirementId)),
    evaluations: evaluations.sort((left, right) =>
      left.requirementId.localeCompare(right.requirementId)),
    liftedImpacts: semanticLift.liftedImpacts,
    roundTrips: semanticLift.roundTrips,
    traversalBudgetExhausted: semanticLift.truncated,
  };
}

function collectEvidenceRequirements(
  bundle: PlanningBundleV1,
): ReadonlyMap<string, { origin: EvidenceEvaluationV1["origin"]; required: boolean }> {
  const result = new Map<string, {
    origin: EvidenceEvaluationV1["origin"];
    required: boolean;
  }>();
  const add = (
    id: string,
    origin: EvidenceEvaluationV1["origin"],
    required: boolean,
  ) => {
    const existing = result.get(id);
    result.set(id, existing === undefined
      ? { origin, required }
      : { origin: existing.origin, required: existing.required || required });
  };
  bundle.semanticChangeSet.acceptanceEvidenceIds.forEach((id) =>
    add(id, "change_contract", true));
  bundle.semanticChangeSet.semanticExpectations.forEach((expectation) =>
    expectation.acceptanceEvidenceIds.forEach((id) =>
      add(id, "semantic_expectation", expectation.required)));
  bundle.semanticChangeSet.repositoryEditExpectations.forEach((edit) =>
    edit.acceptanceEvidenceIds.forEach((id) =>
      add(id, "repository_edit_expectation", edit.required)));
  bundle.semanticChangeSet.proofObligationIds.forEach((id) =>
    add(id, "proof_obligation", true));
  if (bundle.acceptedTargetBinding !== undefined) {
    add("target_reviewed", "proof_obligation", true);
  }
  return new Map([...result].sort(([left], [right]) => left.localeCompare(right)));
}

function deriveEvidenceInput(
  requirementId: string,
  origin: EvidenceEvaluationV1["origin"],
  bundle: PlanningBundleV1,
  captured: ReconciliationInputs,
  candidate: ReturnType<typeof buildObservationAnalysis>,
  hunkBindings: ReconciliationAnalysisV1["hunkBindings"],
  target: TargetContext | undefined,
): ReconciliationEvidenceInputV1 | undefined {
  const base = {
    requirementId,
    planningCommit: bundle.planningCommit,
    observedDiffHash: candidate.analysis.candidateDiffHash,
    semanticModelHash: captured.semanticModelHash,
    observationAnalysisHash: candidate.analysis.analysisHash,
  } as const;
  if (origin !== "proof_obligation") {
    const evidence = captured.repositoryEvidence.find((item) => item.id === requirementId);
    if (
      evidence === undefined
      || !graphHasExactPath(candidate.candidateGraph, normalizeGitPath(evidence.filePath))
    ) return undefined;
    if (origin === "change_contract") {
      const change = captured.semanticModel.changes.find(
        (item) => item.id === bundle.taskEnvelope.changeId,
      );
      if (!change?.requiresEvidence.includes(requirementId)) return undefined;
    }
    return {
      ...base,
      evidenceId: evidence.id,
      semanticEvidenceDigest: sha256HashCanonicalJson(evidence),
      provenance: ["plane_a_observed", "plane_b_authored"],
      result: "satisfied",
    };
  }
  const profileDerivation = (
    PROFILE_PROOF_DERIVATIONS[bundle.semanticChangeSet.profile] as Readonly<
      Record<string, ProfileProofDerivation>
    >
  )[requirementId];
  const derivation = profileDerivation ?? commonProofDerivation(requirementId);
  if (derivation === "unsupported" || derivation === undefined) return undefined;
  if (derivation === "target_reviewed") {
    if (target?.effectiveStatus !== "accepted" || target.acceptedEvidence === undefined) {
      return undefined;
    }
    return {
      ...base,
      evidenceId: requirementId === "target_reviewed"
        ? target.acceptedEvidence.evidenceId
        : `${target.acceptedEvidence.evidenceId}:${requirementId}`,
      semanticEvidenceDigest: sha256HashCanonicalJson({
        target: target.target.artifactHash,
        candidateArchitecture: candidate.analysis.candidateArchitectureHash,
      }),
      acceptedAttestationDigests: [target.acceptedEvidence.attestationDigest],
      attestationSetHash: target.acceptedEvidence.attestationSetHash,
      provenance: ["canonical_attestation", "plane_a_observed", "plane_b_authored"],
      result: "satisfied",
    };
  }
  const semanticEvidence = proofSemanticEvidence(
    derivation,
    bundle,
    captured,
    candidate,
    hunkBindings,
  );
  if (semanticEvidence === undefined) return undefined;
  return {
    ...base,
    evidenceId: `derived:${requirementId}`,
    semanticEvidenceDigest: semanticEvidence,
    provenance: ["plane_a_observed", "plane_b_authored"],
    result: "satisfied",
  };
}

function commonProofDerivation(requirementId: string): ProfileProofDerivation | undefined {
  const exact: Readonly<Record<string, ProfileProofDerivation>> = {
    baseline_captured: "baseline_captured",
    target_reviewed: "target_reviewed",
    replacement_present: "replacement_present",
    invariants_preserved: "invariants_preserved",
  };
  return exact[requirementId];
}

function proofSemanticEvidence(
  derivation: Exclude<ProfileProofDerivation, "target_reviewed" | "unsupported">,
  bundle: PlanningBundleV1,
  captured: ReconciliationInputs,
  candidate: ReturnType<typeof buildObservationAnalysis>,
  hunkBindings: ReconciliationAnalysisV1["hunkBindings"],
): Sha256Hash | undefined {
  switch (derivation) {
    case "scope_bound": {
      const requiredEditIds = bundle.semanticChangeSet.repositoryEditExpectations
        .filter((edit) => edit.required)
        .map((edit) => edit.editId);
      const matched = new Set(hunkBindings.flatMap((binding) => binding.editIds));
      return requiredEditIds.length > 0 && requiredEditIds.every((id) => matched.has(id))
        ? sha256HashCanonicalJson({
            scope: bundle.taskEnvelope.declaredReconciliationScope,
            bindings: hunkBindings,
          })
        : undefined;
    }
    case "test_reference_observed":
      return bundle.semanticChangeSet.testReferences.length > 0
        && bundle.semanticChangeSet.testReferences.every((path) =>
          graphHasExactPath(candidate.candidateGraph, path))
        ? sha256HashCanonicalJson({
            testReferences: bundle.semanticChangeSet.testReferences,
            candidateGraphHash: candidate.analysis.candidateGraphHash,
          })
        : undefined;
    case "baseline_captured":
      return bundle.baseline.cleanliness === "FRESH"
        ? sha256HashCanonicalJson(bundle.baseline)
        : undefined;
    case "replacement_present":
      return bundle.semanticChangeSet.repositoryEditExpectations.some((edit) =>
        edit.kind === "add"
        && hunkBindings.some((binding) => binding.editIds.includes(edit.editId)))
        ? sha256HashCanonicalJson(hunkBindings)
        : undefined;
    case "invariants_preserved": {
      const delta = compareArchitectures(
        captured.baselineArchitecture,
        candidate.candidateArchitecture,
      ).delta;
      return bundle.taskEnvelope.preservedInvariantIds.every((id) =>
        !delta.changedInvariantIds.includes(id as `semantic:${string}`))
        ? sha256HashCanonicalJson({
            preservedInvariantIds: bundle.taskEnvelope.preservedInvariantIds,
            architectureDelta: delta,
          })
        : undefined;
    }
  }
}

function graphHasExactPath(graph: CoordinateGraphReportV2, path: string): boolean {
  return graph.nodes.some((node) =>
    node.references.some((reference) => stripReferenceLocation(reference) === path));
}

interface SemanticPath {
  terminalSemanticId: string;
  steps: ReconciliationRoundTripCoverageV1["steps"];
}

function deriveSemanticLift(
  bundle: PlanningBundleV1,
  candidateGraph: CoordinateGraphReportV2,
  observedHunks: readonly ObservedDiffHunkV1[],
  hunkBindings: ReconciliationAnalysisV1["hunkBindings"],
  satisfiedEvidenceIds: ReadonlySet<string>,
  observationAnalysisHash: Sha256Hash,
): {
  liftedImpacts: ReconciliationAnalysisV1["liftedImpacts"];
  roundTrips: ReconciliationRoundTripCoverageV1[];
  structuralEvidence: { evidenceId: string; digest: Sha256Hash }[];
  truncated: boolean;
} {
  const bindingByHunk = new Map(hunkBindings.map((binding) => [binding.hunkId, binding]));
  const pathByHunkAndExpectation = new Map<string, SemanticPath>();
  let truncated = false;
  const liftedImpacts = observedHunks.map((hunk) => {
    const binding = bindingByHunk.get(hunk.identity);
    if (binding === undefined || binding.coordinateIds.length === 0) {
      return { hunkId: hunk.identity, expectationIds: [], semanticSubjectIds: [] };
    }
    const expectationIds: string[] = [];
    const semanticSubjectIds: string[] = [];
    for (const expectation of bundle.semanticChangeSet.semanticExpectations) {
      const paths = findCertifyingPaths(
        candidateGraph,
        expectation.subjectId,
        expectation.level,
        binding.coordinateIds,
      );
      truncated ||= paths.truncated;
      if (paths.paths.length !== 1 || paths.truncated) continue;
      expectationIds.push(expectation.expectationId);
      semanticSubjectIds.push(expectation.subjectId);
      pathByHunkAndExpectation.set(
        `${hunk.identity}\0${expectation.expectationId}`,
        paths.paths[0]!,
      );
    }
    return {
      hunkId: hunk.identity,
      expectationIds: [...new Set(expectationIds)].sort(),
      semanticSubjectIds: [...new Set(semanticSubjectIds)].sort(),
    };
  });
  const roundTrips: ReconciliationRoundTripCoverageV1[] = [];
  const structuralEvidence: { evidenceId: string; digest: Sha256Hash }[] = [];
  for (const expectation of bundle.semanticChangeSet.semanticExpectations) {
    for (const edit of bundle.semanticChangeSet.repositoryEditExpectations) {
      if (!edit.expectedLiftedExpectationIds.includes(expectation.expectationId)) continue;
      const matched = hunkBindings.filter((binding) => binding.editIds.includes(edit.editId));
      if (matched.length === 0) continue;
      const paths = matched.map((binding) =>
        pathByHunkAndExpectation.get(`${binding.hunkId}\0${expectation.expectationId}`));
      if (!paths.every((path): path is SemanticPath => path !== undefined)) continue;
      const firstPath = paths[0];
      if (firstPath === undefined) continue;
      if (paths.some((path) =>
        path.terminalSemanticId !== firstPath.terminalSemanticId
        || path.steps.map((step) => step.relationId).join("\0")
          !== firstPath.steps.map((step) => step.relationId).join("\0")
      )) continue;
      const evidenceIds = [...new Set([
        ...expectation.acceptanceEvidenceIds,
        ...edit.acceptanceEvidenceIds,
      ].filter((id) => satisfiedEvidenceIds.has(id)))].sort();
      const observedHunkIds = matched.map((binding) => binding.hunkId).sort();
      const terminalCoordinateIds = [...new Set(
        matched.flatMap((binding) => binding.coordinateIds),
      )].sort();
      const staticDigest = sha256HashCanonicalJson({
        domain: "SEMCTX_STATIC_L1_OBSERVED_BINDING_V1",
        semanticL1: firstPath.terminalSemanticId,
        terminalCoordinateIds,
        observedHunkIds,
      });
      const structuralDigest = sha256HashCanonicalJson({
        domain: "SEMCTX_STRUCTURAL_ROUND_TRIP_EVIDENCE_V1",
        expectationId: expectation.expectationId,
        editId: edit.editId,
        semanticSubjectId: expectation.subjectId,
        semanticLevel: expectation.level,
        sourceSeal: bundle.baseline.freshnessSealHash,
        indexSeal: bundle.taskEnvelope.indexSeal,
        observationAnalysisHash,
        steps: firstPath.steps,
        staticDigest,
        terminalCoordinateIds,
        observedHunkIds,
      });
      const structuralEvidenceId =
        `structural-round-trip:${structuralDigest.slice("sha256:".length)}`;
      structuralEvidence.push({
        evidenceId: structuralEvidenceId,
        digest: structuralDigest,
      });
      roundTrips.push({
        schemaVersion: 1,
        expectationId: expectation.expectationId,
        editId: edit.editId,
        semanticSubjectId: expectation.subjectId,
        semanticLevel: expectation.level,
        sourceSeal: bundle.baseline.freshnessSealHash,
        indexSeal: bundle.taskEnvelope.indexSeal,
        observationAnalysisHash,
        steps: [
          ...firstPath.steps,
          {
            relationId: `static:l1-observed:${staticDigest}`,
            relationDigest: staticDigest,
            fromId: firstPath.terminalSemanticId,
            toId: observedHunkIds[0]!,
            fromLevel: 1,
            toLevel: 0,
            epistemicStatus: "statically_observed",
            evidenceDigests: observedHunkIds,
          },
        ],
        terminalCoordinateIds,
        observedHunkIds,
        evidenceIds: [...new Set([
          structuralEvidenceId,
          ...evidenceIds,
        ])].sort(),
        terminalStatus: "success",
        truncated: false,
      });
    }
  }
  return {
    liftedImpacts,
    roundTrips,
    structuralEvidence: structuralEvidence.sort((left, right) =>
      left.evidenceId.localeCompare(right.evidenceId)),
    truncated,
  };
}

function findCertifyingPaths(
  graph: CoordinateGraphReportV2,
  subjectId: string,
  subjectLevel: 2 | 3 | 4 | 5 | 6,
  boundCoordinates: readonly `repo:${string}`[],
): { paths: SemanticPath[]; truncated: boolean } {
  const verified = new Set(graph.verifiedEvidenceDigests);
  const levels = new Map(
    graph.nodes.flatMap((node) =>
      node.id.startsWith("semantic:") && node.appliesAtLevel !== null
        ? [[node.id.slice("semantic:".length), node.appliesAtLevel] as const]
        : []),
  );
  if (levels.get(subjectId) !== subjectLevel) return { paths: [], truncated: false };
  const l1Terminals = new Set(
    graph.structuralEdges.flatMap((edge) =>
      boundCoordinates.includes(edge.from as `repo:${string}`)
      && edge.to.startsWith("semantic:")
      && edge.sourceRelation?.startsWith("repository_link:")
      && edge.evidenceRefs.length > 0
      && levels.get(edge.to.slice("semantic:".length)) === 1
        ? [edge.to.slice("semantic:".length)]
        : []),
  );
  const adjacency = new Map<string, {
    to: string;
    relation: CoordinateGraphReportV2["refinementRelations"][number];
    fromLevel: number;
    toLevel: number;
  }[]>();
  for (const relation of graph.refinementRelations) {
    if (
      relation.kind === "constrained_by"
      || relation.kind === "proved_by"
      || relation.epistemicStatus === "llm_inferred"
      || relation.epistemicStatus === "hypothetical"
      || relation.evidenceRefs.length === 0
    ) continue;
    const evidenceDigests = relation.evidenceRefs.map((reference) =>
      `sha256:${reference.digest.value}` as Sha256Hash);
    if (!evidenceDigests.every((digest) => verified.has(digest))) continue;
    const from = relation.kind === "decomposes_to" ? relation.source : relation.target;
    const to = relation.kind === "decomposes_to" ? relation.target : relation.source;
    if (from.plane !== "B" || to.plane !== "B") continue;
    const fromLevel = levels.get(from.nodeId);
    const toLevel = levels.get(to.nodeId);
    if (fromLevel === undefined || toLevel !== fromLevel - 1) continue;
    adjacency.set(from.nodeId, [
      ...(adjacency.get(from.nodeId) ?? []),
      { to: to.nodeId, relation, fromLevel, toLevel },
    ]);
  }
  const paths: SemanticPath[] = [];
  const queue: { id: string; steps: SemanticPath["steps"]; seen: ReadonlySet<string> }[] = [{
    id: subjectId,
    steps: [],
    seen: new Set([subjectId]),
  }];
  let expansions = 0;
  const MAX_EXPANSIONS = 1_024;
  while (queue.length > 0 && expansions < MAX_EXPANSIONS) {
    const current = queue.shift()!;
    if (l1Terminals.has(current.id)) {
      paths.push({ terminalSemanticId: current.id, steps: current.steps });
      continue;
    }
    for (const next of (adjacency.get(current.id) ?? []).sort((left, right) =>
      left.relation.id.localeCompare(right.relation.id))) {
      expansions += 1;
      if (current.seen.has(next.to)) continue;
      const evidenceDigests = next.relation.evidenceRefs.map((reference) =>
        `sha256:${reference.digest.value}` as Sha256Hash).sort();
      queue.push({
        id: next.to,
        seen: new Set([...current.seen, next.to]),
        steps: [
          ...current.steps,
          {
            relationId: next.relation.id,
            relationDigest: next.relation.relationDigest
              ?? computeRefinementRelationDigest(next.relation),
            fromId: current.id,
            toId: next.to,
            fromLevel: next.fromLevel as 1 | 2 | 3 | 4 | 5 | 6,
            toLevel: next.toLevel as 0 | 1 | 2 | 3 | 4 | 5,
            epistemicStatus: next.relation.epistemicStatus,
            evidenceDigests,
          },
        ],
      });
    }
  }
  const unique = new Map(paths.map((path) => [
    `${path.terminalSemanticId}\0${path.steps.map((step) => step.relationId).join("\0")}`,
    path,
  ]));
  return {
    paths: [...unique.values()],
    truncated: queue.length > 0 || expansions >= MAX_EXPANSIONS,
  };
}

interface AcceptedTargetEvidence {
  evidenceId: string;
  attestationDigest: Sha256Hash;
  attestationSetHash: Sha256Hash;
}

type TargetContext =
  | {
      target: TargetArchitectureArtifactV1;
      effectiveStatus: "proposed";
    }
  | {
      target: TargetArchitectureArtifactV1;
      effectiveStatus: "accepted";
      acceptedEvidence: AcceptedTargetEvidence;
    };

function loadTargetContext(
  root: string,
  bundle: PlanningBundleV1,
  captured: ReconciliationInputs,
): TargetContext | undefined {
  if (bundle.acceptedTargetBinding !== undefined) {
    const accepted = loadAcceptedTargetWithEvidence(root, bundle.acceptedTargetBinding);
    if (
      captured.indexedSnapshot?.schemaVersion !== 2
      || captured.indexedSnapshot.attestationSetHash !== accepted.attestationSetHash
    ) refuse("accepted target evidence is outside the captured attestation set");
    return {
      target: accepted.target,
      effectiveStatus: "accepted",
      acceptedEvidence: {
        evidenceId: accepted.reviewAttestationId,
        attestationDigest: accepted.reviewAttestationDigest,
        attestationSetHash: accepted.attestationSetHash,
      },
    };
  }
  const advisory = bundle.taskEnvelope.advisoryTargetRef;
  if (advisory === undefined) return undefined;
  const target = loadTargetArtifact(root, advisory.targetId, advisory.revision);
  if (target.artifactHash !== advisory.artifactHash) {
    refuse("advisory target identity changed after planning");
  }
  return { target, effectiveStatus: "proposed" };
}

function targetAnalysis(
  context: TargetContext | undefined,
  candidateArchitecture: ReturnType<typeof snapshotArchitecture>,
  evaluations: readonly EvidenceEvaluationV1[],
): ReconciliationAnalysisV1["targetAnalysis"] {
  if (context === undefined) return undefined;
  const { target } = context;
  if (context.effectiveStatus === "proposed") {
    return {
      targetRef: {
        schemaVersion: 1,
        targetId: target.targetId,
        revision: target.revision,
        artifactHash: target.artifactHash,
      },
      normativeStatus: "proposed",
      reviewAttestationDigests: [],
      findings: target.elements.map((element) => ({
        targetElementId: element.id,
        result: "unproven" as const,
        evidenceIds: [],
      })),
    };
  }
  const acceptedEvidence = context.acceptedEvidence;
  const admitted = evaluations.find((evaluation) =>
    evaluation.requirementId === "target_reviewed"
    && evaluation.evidenceId === acceptedEvidence.evidenceId
    && evaluation.result === "satisfied"
    && evaluation.acceptedAttestationDigests.includes(acceptedEvidence.attestationDigest)
  );
  const candidateElements = new Map(candidateArchitecture.elements.map((element) => [element.id, element]));
  const candidateRelations = new Map(candidateArchitecture.relations.map((relation) => [
    architectureRelationKey(relation),
    relation,
  ]));
  const targetRelations = new Map(target.relations.map((relation) => [
    architectureRelationKey(relation),
    relation,
  ]));
  return {
    targetRef: {
      schemaVersion: 1,
      targetId: target.targetId,
      revision: target.revision,
      artifactHash: target.artifactHash,
    },
    normativeStatus: "accepted" as const,
    reviewAttestationDigests: [acceptedEvidence.attestationDigest],
    findings: target.elements.map((element) => {
      const realized = admitted !== undefined && targetElementRealized(
        element,
        candidateElements,
        targetRelations,
        candidateRelations,
      );
      return {
        targetElementId: element.id,
        result: realized ? "realized" as const : "not_realized" as const,
        evidenceIds: realized ? [acceptedEvidence.evidenceId] : [],
      };
    }),
  };
}

function targetElementRealized(
  element: TargetArchitectureArtifactV1["elements"][number],
  candidateElements: ReadonlyMap<string, ReturnType<typeof snapshotArchitecture>["elements"][number]>,
  targetRelations: ReadonlyMap<string, TargetArchitectureArtifactV1["relations"][number]>,
  candidateRelations: ReadonlyMap<string, ReturnType<typeof snapshotArchitecture>["relations"][number]>,
): boolean {
  const candidate = candidateElements.get(element.id);
  if (
    candidate === undefined
    || candidate.level !== element.level
    || candidate.category !== element.category
    || candidate.fingerprint !== element.fingerprint
  ) return false;
  const incidentTarget = [...targetRelations].filter(([, relation]) =>
    relation.from === element.id || relation.to === element.id);
  const incidentCandidate = [...candidateRelations].filter(([, relation]) =>
    relation.from === element.id || relation.to === element.id);
  return incidentTarget.length === incidentCandidate.length
    && incidentTarget.every(([key, relation]) =>
      candidateRelations.get(key)?.fingerprint === relation.fingerprint);
}

function architectureRelationKey(
  relation: TargetArchitectureArtifactV1["relations"][number],
): string {
  return `${relation.from}\0${relation.to}\0${relation.relation}`;
}

function loadAcceptedTarget(
  root: string,
  binding: NonNullable<TaskEnvelopeV1["authoredTargetBinding"]>,
): TargetArchitectureArtifactV1 {
  return loadAcceptedTargetWithEvidence(root, binding).target;
}

function loadAcceptedTargetWithEvidence(
  root: string,
  binding: NonNullable<TaskEnvelopeV1["authoredTargetBinding"]>,
): {
  target: TargetArchitectureArtifactV1;
  reviewAttestationId: string;
  reviewAttestationDigest: Sha256Hash;
  attestationSetHash: Sha256Hash;
} {
  const target = loadTargetArtifact(root, binding.targetId, binding.revision);
  const proposal = target.supersedesRef;
  if (
    target.normativeStatus !== "accepted"
    || target.artifactHash !== binding.artifactHash
    || target.reviewAttestationRef === undefined
    || proposal === undefined
  ) refuse("authored target binding is not an exact accepted revision");
  const reader = openReadyRepository(root);
  try {
    const indexedSnapshot = parseIndexedControlSnapshot(reader.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY));
    const rawIndex = reader.getMeta(CONTROL_ATTESTATION_INDEX_META_KEY);
    if (indexedSnapshot?.schemaVersion !== 2 || indexedSnapshot.attestationSetHash === null || rawIndex === undefined) {
      refuse("accepted target review is not bound to a sealed attestation index");
    }
    const parsed = JSON.parse(rawIndex) as {
      schemaVersion?: unknown;
      attestationSetHash?: unknown;
      entries?: unknown;
    };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    const review = entries.find((entry) =>
      typeof entry === "object"
      && entry !== null
      && (entry as { id?: unknown }).id === target.reviewAttestationRef
      && (entry as { obligation?: unknown }).obligation === "target_reviewed"
      && (entry as { subject?: unknown }).subject === proposal.artifactHash
      && isCanonicalTargetReviewAttestation(
        entry,
        proposal.artifactHash,
        indexedSnapshot.capturedAt,
      )
    ) as {
      id: string;
      commit: string;
      attestationDigest: Sha256Hash;
    } | undefined;
    if (
      parsed.schemaVersion !== 1
      || parsed.attestationSetHash !== indexedSnapshot.attestationSetHash
      || !isHash(parsed.attestationSetHash)
      || parsed.attestationSetHash !== computeAttestationSetHashLocally(entries)
      || review === undefined
    ) refuse("accepted target review attestation is absent from the exact sealed index");
    assertTargetProposalContained(root, proposal, review.commit);
    return {
      target,
      reviewAttestationId: review.id,
      reviewAttestationDigest: review.attestationDigest,
      attestationSetHash: parsed.attestationSetHash,
    };
  } catch (error) {
    if (error instanceof SyntaxError) refuse("accepted target attestation index is invalid");
    throw error;
  } finally {
    reader.close();
  }
}

function isCanonicalTargetReviewAttestation(
  value: unknown,
  proposalHash: Sha256Hash,
  evaluatedAt: string,
): boolean {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  const references = Array.isArray(entry.references) ? entry.references : [];
  const payload = {
    schemaVersion: entry.schemaVersion,
    id: entry.id,
    obligation: entry.obligation,
    subject: entry.subject,
    epistemicStatus: entry.epistemicStatus,
    references,
    commit: entry.commit,
    observedAt: entry.observedAt,
    expiresAt: entry.expiresAt,
  };
  const canonicalReferences = references.filter((reference): reference is {
    kind: string;
    uri: string;
    nonLlm: boolean;
  } => typeof reference === "object" && reference !== null
    && typeof (reference as Record<string, unknown>).kind === "string"
    && typeof (reference as Record<string, unknown>).uri === "string"
    && typeof (reference as Record<string, unknown>).nonLlm === "boolean")
    .sort((left, right) =>
      compareCodeUnits(left.kind, right.kind)
      || compareCodeUnits(left.uri, right.uri)
      || Number(left.nonLlm) - Number(right.nonLlm));
  const observedAt = typeof entry.observedAt === "string" ? Date.parse(entry.observedAt) : NaN;
  const expiresAt = typeof entry.expiresAt === "string" ? Date.parse(entry.expiresAt) : NaN;
  const evaluated = Date.parse(evaluatedAt);
  return entry.schemaVersion === 1
    && typeof entry.id === "string"
    && entry.id.length > 0
    && entry.obligation === "target_reviewed"
    && entry.subject === proposalHash
    && entry.epistemicStatus === "human_declared"
    && typeof entry.commit === "string"
    && /^[0-9a-f]{40}$/.test(entry.commit)
    && canonicalReferences.length === references.length
    && canonicalReferences.some((reference) =>
      reference.kind === "architecture" && reference.nonLlm)
    && Number.isFinite(observedAt)
    && Number.isFinite(expiresAt)
    && Number.isFinite(evaluated)
    && observedAt <= evaluated
    && evaluated <= expiresAt
    && isHash(entry.attestationDigest)
    && entry.attestationDigest === sha256HashCanonicalJson({
      ...payload,
      references: canonicalReferences,
    });
}

function computeAttestationSetHashLocally(entries: readonly unknown[]): Sha256Hash | null {
  const digests = entries.flatMap((entry) =>
    typeof entry === "object"
      && entry !== null
      && isHash((entry as { attestationDigest?: unknown }).attestationDigest)
      ? [(entry as { attestationDigest: Sha256Hash }).attestationDigest]
      : []);
  if (digests.length !== entries.length) return null;
  return sha256HashCanonicalJson([...new Set(digests)].sort(compareCodeUnits));
}

function assertTargetProposalContained(
  root: string,
  proposal: NonNullable<TargetArchitectureArtifactV1["supersedesRef"]>,
  commit: string,
): void {
  const relativePath = `.semctx/semantic/targets/${proposal.targetId}/r${proposal.revision}.target.json`;
  let committed: TargetArchitectureArtifactV1;
  try {
    committed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      gitBytes(root, ["show", `${commit}:${relativePath}`]),
    )) as TargetArchitectureArtifactV1;
  } catch {
    refuse("accepted target proposal is absent from its attested commit");
  }
  if (
    committed.targetId !== proposal.targetId
    || committed.revision !== proposal.revision
    || committed.artifactHash !== proposal.artifactHash
  ) refuse("accepted target proposal identity does not match its attested commit");
}

function bindAcceptedTarget(
  changeSet: SemanticChangeSetV1,
  targetBinding: NonNullable<PlanningBundleV1["acceptedTargetBinding"]>,
): SemanticChangeSetV1 {
  const normalized = normalizeSemanticChangeSetV1({
    ...changeSet,
    targetBinding,
    changeSetHash: sha256HashUtf8("pending"),
  });
  return {
    ...normalized,
    changeSetHash: computeSemanticChangeSetV1Hash(normalized),
  };
}

function bindChangeContractEvidence(
  changeSet: SemanticChangeSetV1,
  requirementIds: readonly string[],
): SemanticChangeSetV1 {
  const normalized = normalizeSemanticChangeSetV1({
    ...changeSet,
    acceptanceEvidenceIds: [
      ...new Set([...changeSet.acceptanceEvidenceIds, ...requirementIds]),
    ].sort(),
    changeSetHash: sha256HashUtf8("pending"),
  });
  return {
    ...normalized,
    changeSetHash: computeSemanticChangeSetV1Hash(normalized),
  };
}

function baselineFrom(captured: CapturedPlanningInputs): WorkspaceBaselineSnapshotV1 {
  return {
    schemaVersion: 1,
    kind: "workspace_baseline",
    planningCommit: captured.git.headCommit,
    cleanliness: captured.cleanliness,
    freshnessSealHash: captured.freshnessSealHash,
    workingDiffHash: captured.git.workingDiffHash,
    semanticModelHash: captured.semanticModelHash,
    analyzerConfigHash: captured.analyzerConfigHash,
    toolVersion: CONTROL_FRESHNESS_TOOL_VERSION,
    storeSchemaVersion: SCHEMA_VERSION,
    attestationSetHash: captured.indexedSnapshot.schemaVersion === 2
      ? captured.indexedSnapshot.attestationSetHash
      : null,
  };
}

function assertCaptureStable(root: string, captured: CapturedPlanningInputs): void {
  const git = captureGitState(root);
  const config = loadConfig(root);
  const analysisInputHash = fingerprintAnalysisInputs(config, discoverFiles(config));
  const semanticModelHash = fingerprintSemanticModel(loadSemanticModel(root).model);
  if (
    git.headCommit !== captured.git.headCommit
    || git.workingDiffHash !== captured.git.workingDiffHash
    || analysisInputHash !== captured.analysisInputHash
    || semanticModelHash !== captured.semanticModelHash
  ) refuse("planning inputs changed during envelope construction");
}

function captureToken(value: ReconciliationInputs): string {
  return JSON.stringify({
    git: value.git,
    graphSeal: value.graphSeal,
    indexSeal: value.indexSeal,
    semanticModelHash: value.semanticModelHash,
    analysisInputHash: value.analysisInputHash,
    analyzerConfigHash: value.analyzerConfigHash,
    indexedSnapshot: value.indexedSnapshot,
  });
}

function fingerprintAnalyzerConfig(
  config: ReturnType<typeof loadConfig>,
): Sha256Hash {
  return sha256HashCanonicalJson({
    domain: "SEMCTX_ANALYZER_CONFIG_V1",
    config,
  });
}

function gitBytes(root: string, args: readonly string[]): Uint8Array {
  const process = Bun.spawnSync(["git", "--no-optional-locks", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (process.exitCode !== 0) {
    throw new SemctxError("GIT_ERROR", "read-only Git capture failed", {
      args,
      stderr: new TextDecoder().decode(process.stderr).trim(),
    });
  }
  return new Uint8Array(process.stdout);
}

function listUntrackedPaths(root: string): string[] {
  return new TextDecoder()
    .decode(gitBytes(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]))
    .split("\0")
    .filter(Boolean)
    .map(normalizeGitPath);
}

function digestBytes(bytes: Uint8Array): Sha256Hash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizeGitPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.length === 0
    || normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split("/").some((segment) => segment.length === 0 || segment === "..")
  ) refuse(`Git reported a non-canonical repository path: ${path}`);
  return normalized;
}

function stripReferenceLocation(reference: string): string {
  return reference.replace(/:\d+(?::\d+)?$/, "").replaceAll("\\", "/");
}

function relationEndpointId(
  endpoint: CoordinateGraphReportV2["refinementRelations"][number]["source"],
): CoordinateGraphReportV2["nodes"][number]["id"] {
  return endpoint.plane === "A"
    ? endpoint.coordinateDigest
    : `semantic:${endpoint.nodeId}` as CoordinateGraphReportV2["nodes"][number]["id"];
}

function sourceChangeKey(change: CandidateSourceChangeV1): string {
  if (change.kind === "add") return `add\0${change.newPath}`;
  if (change.kind === "modify") return `modify\0${change.path}`;
  if (change.kind === "delete") return `delete\0${change.oldPath}`;
  return `rename\0${change.oldPath}\0${change.newPath}`;
}

function shortDigest(value: unknown): string {
  return sha256HashCanonicalJson(value).slice("sha256:".length, "sha256:".length + 24);
}

function isHash(value: unknown): value is Sha256Hash {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function refuse(message: string): never {
  throw new SemctxError("CONTROL_INPUTS_UNSAFE", message);
}

type ReconciliationTestStage =
  | "after_initial_capture"
  | "before_candidate_analysis"
  | "before_final_capture";
const RECONCILIATION_TEST_HOOK = Symbol.for(
  "@semantic-context/app-services/reconciliation-test-hook",
);

function runReconciliationTestHook(stage: ReconciliationTestStage, root: string): void {
  const hook = (globalThis as {
    [RECONCILIATION_TEST_HOOK]?:
      (stage: ReconciliationTestStage, repositoryRoot: string) => void;
  })[RECONCILIATION_TEST_HOOK];
  hook?.(stage, root);
}
