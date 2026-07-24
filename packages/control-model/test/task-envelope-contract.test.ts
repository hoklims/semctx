import { describe, expect, it } from "bun:test";
import * as controlModel from "@semantic-context/control-model";
import {
  CandidateAnchorV1Schema,
  CanonicalRepoRelativePathSchema,
  DeclaredReconciliationScopeV1Schema,
  EvidenceEvaluationV1Schema,
  ObservationAnalysisV1Schema,
  PlanningBundleV1Schema,
  ReconciliationAnalysisV1Schema,
  ReconciliationAdvisoryCodeV1Schema,
  ReconcileDiffReportV1Schema,
  ReconcileWorkingTreeInputV1Schema,
  RepositoryEditExpectationV1Schema,
  ResolvedBindingV1Schema,
  SemanticChangeSetV1Schema,
  TargetReferenceV1Schema,
  TaskEnvelopeV1Schema,
  TaskFrameSnapshotV1Schema,
  computeObservationAnalysisV1Hash,
  computePlanningBundleV1Hash,
  computeReconciliationAnalysisV1Hash,
  computeReconciliationArchitectureDeltaV1Hash,
  computeReconciliationObservedDiffV1Hash,
  computeReconcileDiffReportV1Hash,
  computeSemanticChangeSetV1Hash,
  computeTaskEnvelopeV1Hash,
  computeTaskFrameSnapshotV1Hash,
  normalizeCanonicalRepoRelativePath,
  normalizeReconciliationAnalysisV1,
  normalizeSemanticChangeSetV1,
  normalizeTaskEnvelopeV1,
  sha256HashCanonicalJson,
  createObservedDiffHunkV1,
  RECONCILIATION_ADVISORY_CODES,
  type ObservationAnalysisV1,
  type PlanningBundleV1,
  type ReconciliationAnalysisV1,
  type ReconcileDiffReportV1,
  type ReconcileTerminalStatusV1,
  type ReconciliationReasonCodeV1,
  type RepositoryEditExpectationV1,
  type SemanticChangeSetV1,
  type TaskEnvelopeV1,
  type TaskFrameSnapshotV1,
} from "@semantic-context/control-model";

const hashA = `sha256:${"a".repeat(64)}` as const;
const hashB = `sha256:${"b".repeat(64)}` as const;
const hashC = `sha256:${"c".repeat(64)}` as const;

function taskFrame(): TaskFrameSnapshotV1 {
  return {
    schemaVersion: 1,
    taskFrameId: "task.27",
    rawTaskDigest: hashA,
    mode: "feature",
    createdAt: "2026-07-23T10:00:00.000Z",
    capabilitySignals: ["reconciliation", "task_envelope"],
    riskSignals: ["control_plane"],
    profileCandidate: "feature",
    altitudeCandidate: 5,
  };
}

function envelope(): TaskEnvelopeV1 {
  const snapshot = taskFrame();
  const input: Omit<TaskEnvelopeV1, "envelopeHash"> = {
    schemaVersion: 1,
    kind: "task_envelope",
    executionAuthority: "none",
    envelopeId: "envelope.27",
    planningCommit: "abc123",
    taskFrameSnapshot: snapshot,
    taskFrameHash: computeTaskFrameSnapshotV1Hash(snapshot),
    changeId: "change.task-envelope",
    changeContractHash: hashB,
    coordinateGraphSeal: hashA,
    indexSeal: hashB,
    baselineFreshnessSeal: hashC,
    profile: "feature",
    risk: "R1",
    requiredAltitude: 5,
    candidateAnchors: [{
      schemaVersion: 1,
      anchorId: "candidate.path",
      kind: "path",
      value: "src/x.ts",
      provenance: "task_text",
    }],
    resolvedBindings: [{
      schemaVersion: 1,
      bindingId: "binding.file",
      coordinateId: "repo:file.src-x",
      repositoryPath: "src/x.ts",
      provenance: "explicit_discovery",
      evidenceId: "evidence.discovery",
      planningCommit: "abc123",
      graphSeal: hashA,
      scope: { kind: "file", path: "src/x.ts" },
    }],
    parentIntentIds: ["goal.reconcile"],
    preservedInvariantIds: ["invariant.no-authority"],
    nonGoals: ["execute.patch"],
    expectedBehaviorDelta: ["diff.is.reconciled"],
    declaredReconciliationScope: {
      kind: "file",
      bindingId: "binding.file",
      path: "src/x.ts",
    },
    proofObligationIds: ["proof.round_trip"],
    authoredTargetBinding: {
      schemaVersion: 1,
      targetId: "target-architecture",
      revision: 1,
      artifactHash: hashA,
    },
    compatibilityNotes: [],
  };
  return { ...input, envelopeHash: computeTaskEnvelopeV1Hash(input) };
}

function changeSet(): SemanticChangeSetV1 {
  const taskEnvelope = envelope();
  const input: Omit<SemanticChangeSetV1, "changeSetHash"> = {
    schemaVersion: 1,
    kind: "semantic_change_set",
    executionAuthority: "none",
    changeSetId: "changeset.27",
    envelopeId: taskEnvelope.envelopeId,
    envelopeHash: taskEnvelope.envelopeHash,
    planningCommit: taskEnvelope.planningCommit,
    profile: "feature",
    targetBinding: taskEnvelope.authoredTargetBinding,
    declaredReconciliationScope: taskEnvelope.declaredReconciliationScope,
    refinementSteps: [{
      schemaVersion: 1,
      stepId: "step.0",
      order: 0,
      fromExpectationIds: ["semantic.behavior"],
      toExpectationIds: ["semantic.behavior"],
      repositoryEditIds: ["edit.modify"],
    }],
    semanticExpectations: [{
      schemaVersion: 1,
      expectationId: "semantic.behavior",
      kind: "behavior",
      level: 3,
      required: true,
      subjectId: "capability.reconciliation",
      statement: "The observed diff realizes the declared semantic intent.",
      acceptanceEvidenceIds: ["evidence.behavior"],
    }],
    repositoryEditExpectations: [{
      schemaVersion: 1,
      kind: "modify",
      editId: "edit.modify",
      required: true,
      path: "src/x.ts",
      coordinateIds: ["repo:file.src-x"],
      expectedLiftedExpectationIds: ["semantic.behavior"],
      acceptanceEvidenceIds: ["evidence.behavior"],
    }],
    rollbackDescription: "Revert the candidate commit.",
    testReferences: ["test.reconcile"],
    acceptanceEvidenceIds: ["evidence.behavior"],
    proofObligationIds: ["proof.round_trip"],
  };
  return { ...input, changeSetHash: computeSemanticChangeSetV1Hash(input) };
}

function bundle(): PlanningBundleV1 {
  const taskEnvelope = envelope();
  const semanticChangeSet = changeSet();
  const input: Omit<PlanningBundleV1, "bundleHash"> = {
    schemaVersion: 1,
    kind: "planning_bundle",
    executionAuthority: "none",
    bundleId: "bundle.27",
    planningCommit: "abc123",
    taskEnvelope,
    semanticChangeSet,
    baseline: {
      schemaVersion: 1,
      kind: "workspace_baseline",
      planningCommit: "abc123",
      cleanliness: "FRESH",
      freshnessSealHash: hashC,
      workingDiffHash: hashA,
      semanticModelHash: hashC,
      analyzerConfigHash: hashA,
      toolVersion: "semctx@0.1.0",
      storeSchemaVersion: 2,
      attestationSetHash: hashA,
    },
    acceptedTargetBinding: taskEnvelope.authoredTargetBinding,
  };
  return { ...input, bundleHash: computePlanningBundleV1Hash(input) };
}

function analysis(): ObservationAnalysisV1 {
  const input: Omit<ObservationAnalysisV1, "analysisHash"> = {
    schemaVersion: 1,
    kind: "observation_analysis",
    baselineSealHash: hashC,
    candidateDiffHash: hashB,
    analyzerConfigHash: hashA,
    toolVersion: "semctx@0.1.0",
    changes: [{
      kind: "modify",
      path: "src/x.ts",
      oldSourceDigest: hashA,
      newSourceDigest: hashB,
    }],
    candidateGraphHash: hashB,
    candidateArchitectureHash: hashC,
    completeness: "complete",
    incompleteReasons: [],
  };
  return { ...input, analysisHash: computeObservationAnalysisV1Hash(input) };
}

function report(
  terminalStatus: ReconcileTerminalStatusV1 = "REALIZED",
  reasonCodes: ReconciliationReasonCodeV1[] = [],
  secondaryInsufficiencies: ReconcileDiffReportV1["secondaryInsufficiencies"] = [],
): ReconcileDiffReportV1 {
  const taskEnvelope = envelope();
  const semanticChangeSet = changeSet();
  const input: Omit<ReconcileDiffReportV1, "reportHash"> = {
    schemaVersion: 1,
    kind: "reconcile_diff",
    changeSetId: semanticChangeSet.changeSetId,
    changeSetHash: semanticChangeSet.changeSetHash,
    envelopeId: taskEnvelope.envelopeId,
    envelopeHash: taskEnvelope.envelopeHash,
    planningCommit: "abc123",
    observedCommit: "abc123",
    baselineSealHash: hashC,
    observedWorkingDiffHash: hashB,
    terminalStatus,
    primaryReason: reasonCodes[0] ?? null,
    reasonCodes,
    requiredPlannedEditIds: ["edit.modify"],
    matchedPlannedEdits: [{ editId: "edit.modify", observedHunkIds: [hashA] }],
    missingPlannedEditIds: [],
    observedHunkIds: [hashA],
    unplannedCoordinateIds: [],
    scopeEscapes: [],
    invariantDriftIds: [],
    undeclaredLiftedExpectationIds: [],
    requiredTargetElementIds: ["target.element"],
    targetRealizationFindings: [{
      targetElementId: "target.element",
      required: true,
      result: "realized",
      evidenceIds: ["evidence.behavior"],
    }],
    requiredEvidenceRequirementIds: ["evidence.behavior"],
    evidenceEvaluations: [{
      schemaVersion: 1,
      requirementId: "evidence.behavior",
      origin: "semantic_expectation",
      required: true,
      evidenceId: "evidence.behavior",
      semanticEvidenceDigest: hashA,
      acceptedAttestationDigests: [hashB],
      planningCommit: "abc123",
      observedDiffHash: hashB,
      semanticModelHash: hashC,
      attestationSetHash: hashA,
      observationAnalysisHash: analysis().analysisHash,
      provenance: ["canonical_attestation", "plane_a_observed", "plane_b_authored"],
      result: "satisfied",
    }],
    certifiedRoundTrips: [{
      expectationId: "semantic.behavior",
      coordinateIds: ["repo:file.src-x"],
      evidenceIds: ["evidence.behavior"],
    }],
    requiredRoundTripExpectationIds: ["semantic.behavior"],
    observationAnalysis: {
      analysisHash: analysis().analysisHash,
      completeness: "complete",
    },
    advisoryDiagnostics: [],
    secondaryInsufficiencies,
  };
  return { ...input, reportHash: computeReconcileDiffReportV1Hash(input) };
}

function rehashChangeSet(
  value: Omit<SemanticChangeSetV1, "changeSetHash"> & { changeSetHash?: SemanticChangeSetV1["changeSetHash"] },
): SemanticChangeSetV1 {
  const { changeSetHash: _hash, ...payload } = value;
  return { ...payload, changeSetHash: computeSemanticChangeSetV1Hash(payload) };
}

function rehashEnvelope(
  value: Omit<TaskEnvelopeV1, "envelopeHash"> & { envelopeHash?: TaskEnvelopeV1["envelopeHash"] },
): TaskEnvelopeV1 {
  const { envelopeHash: _hash, ...payload } = value;
  return { ...payload, envelopeHash: computeTaskEnvelopeV1Hash(payload) };
}

function rehashBundle(
  value: Omit<PlanningBundleV1, "bundleHash"> & { bundleHash?: PlanningBundleV1["bundleHash"] },
): PlanningBundleV1 {
  const { bundleHash: _hash, ...payload } = value;
  return { ...payload, bundleHash: computePlanningBundleV1Hash(payload) };
}

function rehashReport(
  value: Omit<ReconcileDiffReportV1, "reportHash"> & { reportHash?: ReconcileDiffReportV1["reportHash"] },
): ReconcileDiffReportV1 {
  const { reportHash: _hash, ...payload } = value;
  return { ...payload, reportHash: computeReconcileDiffReportV1Hash(payload) };
}

function reconciliationAnalysis(): ReconciliationAnalysisV1 {
  const observedHunk = createObservedDiffHunkV1({
    repositoryIdentity: "repo.semctx",
    normalizedPath: "src/x.ts",
    oldRange: { start: 1, lines: 1 },
    newRange: { start: 1, lines: 1 },
    oldBlobId: "old",
    newBlobId: "new",
    rawHunkBytes: new TextEncoder().encode("@@ -1 +1 @@\n-old\n+new\n"),
  });
  const changes: ObservationAnalysisV1["changes"] = [{
    kind: "modify",
    path: "src/x.ts",
    oldSourceDigest: hashA,
    newSourceDigest: hashB,
  }];
  const observedDiffHash = computeReconciliationObservedDiffV1Hash(changes, [observedHunk]);
  const observationInput: Omit<ObservationAnalysisV1, "analysisHash"> = {
    schemaVersion: 1,
    kind: "observation_analysis",
    baselineSealHash: hashC,
    candidateDiffHash: observedDiffHash,
    analyzerConfigHash: hashA,
    toolVersion: "semctx@0.1.0",
    changes,
    candidateGraphHash: hashB,
    candidateArchitectureHash: hashC,
    completeness: "complete",
    incompleteReasons: [],
  };
  const observationAnalysis: ObservationAnalysisV1 = {
    ...observationInput,
    analysisHash: computeObservationAnalysisV1Hash(observationInput),
  };
  const architectureDelta: ReconciliationAnalysisV1["architectureDelta"] = {
    currentSnapshotId: "architecture.baseline",
    targetSnapshotId: "architecture.candidate",
    added: [],
    removed: [],
    changed: [],
    addedRelations: [],
    removedRelations: [],
    changedRelations: [],
    changedInvariantIds: [],
  };
  const evidenceInput: ReconciliationAnalysisV1["evidenceInputs"][number] = {
    requirementId: "evidence.behavior",
    evidenceId: "evidence.behavior",
    semanticEvidenceDigest: hashA,
    acceptedAttestationDigests: [hashB, hashC],
    planningCommit: "abc123",
    observedDiffHash,
    semanticModelHash: hashC,
    attestationSetHash: hashA,
    observationAnalysisHash: observationAnalysis.analysisHash,
    provenance: ["canonical_attestation", "plane_a_observed", "plane_b_authored"],
    result: "satisfied",
  };
  const input: Omit<ReconciliationAnalysisV1, "analysisHash"> = {
    schemaVersion: 1,
    kind: "reconciliation_analysis",
    executionAuthority: "none",
    planningBundleHash: bundle().bundleHash,
    planningCommit: "abc123",
    observedDiffHash,
    observationAnalysis,
    candidateGraphHash: observationAnalysis.candidateGraphHash,
    baselineArchitectureHash: hashA,
    candidateArchitectureHash: observationAnalysis.candidateArchitectureHash,
    architectureDeltaHash: computeReconciliationArchitectureDeltaV1Hash(architectureDelta),
    observedHunks: [observedHunk],
    hunkBindings: [{
      hunkId: observedHunk.identity,
      coordinateIds: ["repo:file.src-x"],
      editIds: ["edit.modify"],
    }],
    architectureDelta,
    liftedImpacts: [{
      hunkId: observedHunk.identity,
      expectationIds: ["semantic.behavior"],
      semanticSubjectIds: ["capability.reconciliation"],
    }],
    evidenceInputs: [evidenceInput],
    evidenceEvaluations: [{
      schemaVersion: 1,
      origin: "semantic_expectation",
      required: true,
      ...evidenceInput,
      acceptedAttestationDigests: evidenceInput.acceptedAttestationDigests ?? [],
    }],
    roundTripCoverages: [{
      schemaVersion: 1,
      expectationId: "semantic.behavior",
      editId: "edit.modify",
      semanticSubjectId: "capability.reconciliation",
      semanticLevel: 3,
      sourceSeal: observationAnalysis.baselineSealHash,
      indexSeal: hashB,
      observationAnalysisHash: observationAnalysis.analysisHash,
      steps: [{
        relationId: "relation.z.behavior-to-capability",
        relationDigest: hashA,
        fromId: "capability.reconciliation",
        toId: "semantic:component",
        fromLevel: 3,
        toLevel: 2,
        epistemicStatus: "statically_observed",
        evidenceDigests: [hashA],
      }, {
        relationId: "relation.a.capability-to-contract",
        relationDigest: hashB,
        fromId: "semantic:component",
        toId: "semantic:contract",
        fromLevel: 2,
        toLevel: 1,
        epistemicStatus: "human_declared",
        evidenceDigests: [hashB],
      }, {
        relationId: "relation.m.contract-to-edit",
        relationDigest: hashC,
        fromId: "semantic:contract",
        toId: "repo:file.src-x",
        fromLevel: 1,
        toLevel: 0,
        epistemicStatus: "statically_observed",
        evidenceDigests: [hashC],
      }],
      terminalCoordinateIds: ["repo:file.src-x"],
      observedHunkIds: [observedHunk.identity],
      evidenceIds: ["evidence.behavior"],
      terminalStatus: "success",
      truncated: false,
    }],
    targetAnalysis: {
      targetRef: {
        schemaVersion: 1,
        targetId: "target-architecture",
        revision: 1,
        artifactHash: hashA,
      },
      normativeStatus: "accepted",
      reviewAttestationDigests: [hashB],
      findings: [{
        targetElementId: "target.element",
        result: "realized",
        evidenceIds: ["evidence.behavior"],
      }],
    },
    traversalBudgetExhausted: false,
    advisoryDiagnostics: [
      { code: "ANALYZER_FAILURE", message: "Analyzer failed.", subjectIds: ["a"] },
      { code: "CANDIDATE_ANCHOR_UNUSED", message: "Anchor unused.", subjectIds: ["z"] },
    ],
  };
  return { ...input, analysisHash: computeReconciliationAnalysisV1Hash(input) };
}

function rehashReconciliationAnalysis(
  value: Omit<ReconciliationAnalysisV1, "analysisHash"> & {
    analysisHash?: ReconciliationAnalysisV1["analysisHash"];
  },
): ReconciliationAnalysisV1 {
  const { analysisHash: _hash, ...payload } = value;
  return { ...payload, analysisHash: computeReconciliationAnalysisV1Hash(payload) };
}

describe("issue #27 public exports and authority boundary", () => {
  it("exports every versioned public schema and hash primitive", () => {
    const publicApi = controlModel as Record<string, unknown>;
    for (const name of [
      "TaskFrameSnapshotV1Schema",
      "CandidateAnchorV1Schema",
      "ResolvedBindingV1Schema",
      "DeclaredReconciliationScopeV1Schema",
      "TaskEnvelopeV1Schema",
      "SemanticChangeSetV1Schema",
      "PlanningBundleV1Schema",
      "ObservationAnalysisV1Schema",
      "ReconciliationAnalysisV1Schema",
      "ReconciliationAdvisoryCodeV1Schema",
      "EvidenceEvaluationV1Schema",
      "ReconcileDiffReportV1Schema",
      "ReconcileWorkingTreeInputV1Schema",
      "computeTaskEnvelopeV1Hash",
      "computeSemanticChangeSetV1Hash",
      "computePlanningBundleV1Hash",
      "computeReconciliationAnalysisV1Hash",
      "computeReconciliationArchitectureDeltaV1Hash",
      "computeReconciliationObservedDiffV1Hash",
      "RECONCILIATION_ADVISORY_CODES",
    ]) expect(publicApi[name], name).toBeDefined();
  });

  it("closes public reconciliation advisory codes while admitting analyzer failure", () => {
    expect(ReconciliationAdvisoryCodeV1Schema.safeParse("ANALYZER_FAILURE").success).toBe(true);
    expect(RECONCILIATION_ADVISORY_CODES).toContain("ANALYZER_FAILURE");
    expect(ReconciliationAdvisoryCodeV1Schema.safeParse("ARBITRARY_DIAGNOSTIC").success).toBe(false);
    expect(ReconciliationAnalysisV1Schema.safeParse(rehashReconciliationAnalysis({
      ...reconciliationAnalysis(),
      advisoryDiagnostics: [{
        code: "ARBITRARY_DIAGNOSTIC" as never,
        message: "must be rejected",
        subjectIds: [],
      }],
    })).success).toBe(false);
    expect(ReconcileDiffReportV1Schema.safeParse(rehashReport({
      ...report(),
      advisoryDiagnostics: [{
        code: "ARBITRARY_DIAGNOSTIC" as never,
        message: "must be rejected",
        subjectIds: [],
      }],
    })).success).toBe(false);
  });

  it("keeps execution authority literal and rejects unknown execution fields", () => {
    const validEnvelope = envelope();
    expect(TaskEnvelopeV1Schema.safeParse(validEnvelope).success).toBe(true);
    expect(TaskEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      executionAuthority: "allow",
    }).success).toBe(false);
    expect(SemanticChangeSetV1Schema.safeParse({
      ...changeSet(),
      patch: "@@ executable bytes",
    }).success).toBe(false);
    expect(PlanningBundleV1Schema.safeParse({
      ...bundle(),
      delete: true,
    }).success).toBe(false);
  });

  it("whitelists TaskFrame fields and never admits raw task or normative hypotheses", () => {
    expect(TaskFrameSnapshotV1Schema.safeParse(taskFrame()).success).toBe(true);
    for (const extra of [
      { rawTask: "modify src/x.ts" },
      { hardInvariants: ["from task text"] },
      { expectedBehavior: ["from task text"] },
      { hypotheses: [] },
    ]) {
      expect(TaskFrameSnapshotV1Schema.safeParse({ ...taskFrame(), ...extra }).success).toBe(false);
    }
    expect(TaskFrameSnapshotV1Schema.safeParse({
      ...taskFrame(),
      schemaVersion: 2,
    }).success).toBe(false);
  });
});

describe("canonical paths, candidates, bindings, and declared scope", () => {
  it("normalizes caller syntax but public schemas accept stored canonical values only", () => {
    expect(normalizeCanonicalRepoRelativePath("src\\./x.ts")).toBe("src/x.ts");
    expect(CanonicalRepoRelativePathSchema.safeParse("src/x.ts").success).toBe(true);
    for (const path of [
      "src\\x.ts", "src/./x.ts", "", ".", "../x.ts", "src/../x.ts",
      "/src/x.ts", "\\\\server\\share", "C:\\src\\x.ts", "src//x.ts", "src/\0x.ts",
    ]) {
      expect(CanonicalRepoRelativePathSchema.safeParse(path).success, path).toBe(false);
    }
    expect(normalizeCanonicalRepoRelativePath("Src/X.ts")).not.toBe(
      normalizeCanonicalRepoRelativePath("src/x.ts"),
    );
  });

  it("keeps CandidateAnchor and ResolvedBinding non-substitutable", () => {
    const candidate = envelope().candidateAnchors[0]!;
    const binding = envelope().resolvedBindings[0]!;
    expect(CandidateAnchorV1Schema.safeParse(candidate).success).toBe(true);
    expect(ResolvedBindingV1Schema.safeParse(binding).success).toBe(true);
    expect(ResolvedBindingV1Schema.safeParse(candidate).success).toBe(false);
    expect(CandidateAnchorV1Schema.safeParse(binding).success).toBe(false);
    const { evidenceId: _evidence, ...unproven } = binding;
    expect(ResolvedBindingV1Schema.safeParse(unproven).success).toBe(false);
  });

  it("binds canonical repository paths without interpreting opaque coordinate ids", () => {
    const binding = envelope().resolvedBindings[0]!;
    expect(ResolvedBindingV1Schema.safeParse({
      ...binding,
      coordinateId: "repo:opaque-id-with-no-path-semantics",
      repositoryPath: "src/x.ts",
    }).success).toBe(true);
    expect(ResolvedBindingV1Schema.safeParse({
      ...binding,
      repositoryPath: "src/other.ts",
    }).success).toBe(false);
    expect(ResolvedBindingV1Schema.safeParse({
      ...binding,
      repositoryPath: "src\\x.ts",
      scope: { kind: "file", path: "src\\x.ts" },
    }).success).toBe(false);
  });

  it("content-binds repositoryPath in the envelope hash", () => {
    const first = envelope();
    const binding = first.resolvedBindings[0]!;
    const second = rehashEnvelope({
      ...first,
      resolvedBindings: [{
        ...binding,
        repositoryPath: "src/y.ts",
        scope: { kind: "file", path: "src/y.ts" },
      }],
      declaredReconciliationScope: {
        kind: "file",
        bindingId: binding.bindingId,
        path: "src/y.ts",
      },
    });
    expect(TaskEnvelopeV1Schema.safeParse(second).success).toBe(true);
    expect(second.envelopeHash).not.toBe(first.envelopeHash);
  });

  it("requires non-empty, sorted, unique coordinate sets", () => {
    const base = {
      kind: "coordinate_set",
      bindingIds: ["binding.a", "binding.b"],
      coordinateIds: ["repo:a", "repo:b"],
    };
    expect(DeclaredReconciliationScopeV1Schema.safeParse(base).success).toBe(true);
    for (const invalid of [
      { ...base, bindingIds: [] },
      { ...base, coordinateIds: [] },
      { ...base, bindingIds: ["binding.b", "binding.a"] },
      { ...base, coordinateIds: ["repo:b", "repo:a"] },
      { ...base, bindingIds: ["binding.a", "binding.a"] },
      { ...base, coordinateIds: ["repo:a", "repo:a"] },
    ]) expect(DeclaredReconciliationScopeV1Schema.safeParse(invalid).success).toBe(false);
    expect(DeclaredReconciliationScopeV1Schema.safeParse({
      kind: "coordinate_set",
      bindingIds: ["binding.a", "binding.b"],
      coordinateIds: [],
      filePaths: ["src/a.ts", "src/b.ts"],
    }).success).toBe(true);
    expect(DeclaredReconciliationScopeV1Schema.safeParse({
      kind: "coordinate_set",
      bindingIds: ["binding.a", "binding.b"],
      coordinateIds: ["repo:a"],
      filePaths: ["src/b.ts", "src/a.ts"],
    }).success).toBe(false);
  });

  it("uses the exact Plane-B target binding identity shape", () => {
    expect(TargetReferenceV1Schema.safeParse({
      schemaVersion: 1,
      targetId: "target-architecture.v1",
      revision: 1,
      artifactHash: hashA,
    }).success).toBe(true);
    for (const invalid of [
      { schemaVersion: 1, targetId: "Target", revision: 1, artifactHash: hashA },
      { schemaVersion: 1, targetId: "target", revision: 0, artifactHash: hashA },
      { schemaVersion: 1, targetId: "target", revision: 1.5, artifactHash: hashA },
      { schemaVersion: 1, targetId: "target", revision: 1, artifactHash: "a".repeat(64) },
      {
        schemaVersion: 1,
        targetId: "target",
        revision: Number.MAX_SAFE_INTEGER + 1,
        artifactHash: hashA,
      },
    ]) expect(TargetReferenceV1Schema.safeParse(invalid).success).toBe(false);
  });
});

describe("repository edit discriminated union", () => {
  const common = {
    schemaVersion: 1,
    editId: "edit.x",
    required: true,
    expectedLiftedExpectationIds: ["expectation.x"],
    acceptanceEvidenceIds: ["evidence.x"],
  };

  it("accepts exactly the four closed variants", () => {
    for (const edit of [
      { ...common, kind: "add", newPath: "src/new.ts" },
      { ...common, kind: "modify", path: "src/x.ts", coordinateIds: ["repo:x"] },
      { ...common, kind: "delete", oldPath: "src/x.ts", coordinateIds: ["repo:x"] },
      {
        ...common,
        kind: "rename",
        oldPath: "src/x.ts",
        newPath: "src/y.ts",
        coordinateIds: ["repo:x"],
      },
    ]) expect(RepositoryEditExpectationV1Schema.safeParse(edit).success).toBe(true);
  });

  it("rejects missing coordinates, same-path rename, variant leakage, and unknown fields", () => {
    for (const invalid of [
      { ...common, kind: "modify", path: "src/x.ts" },
      { ...common, kind: "delete", oldPath: "src/x.ts", coordinateIds: [] },
      {
        ...common,
        kind: "rename",
        oldPath: "src/x.ts",
        newPath: "src/x.ts",
        coordinateIds: ["repo:x"],
      },
      {
        ...common,
        kind: "add",
        newPath: "src/new.ts",
        coordinateIds: ["repo:x"],
      },
      {
        ...common,
        kind: "modify",
        path: "src/x.ts",
        coordinateIds: ["repo:x"],
        newPath: "src/y.ts",
      },
      {
        ...common,
        kind: "delete",
        oldPath: "src/x.ts",
        coordinateIds: ["repo:x"],
        oldRange: { start: 1, lines: 1 },
      },
    ]) expect(RepositoryEditExpectationV1Schema.safeParse(invalid).success).toBe(false);
  });
});

describe("canonicalization, domain hashes, and artifact binding", () => {
  it("normalizes set-like order deterministically and rejects non-canonical stored arrays", () => {
    const valid = envelope();
    const permuted = {
      ...valid,
      envelopeHash: hashA,
      parentIntentIds: ["z", "a", "z"],
      candidateAnchors: [...valid.candidateAnchors].reverse(),
    };
    const normalized = normalizeTaskEnvelopeV1(permuted);
    expect(normalized.parentIntentIds).toEqual(["a", "z"]);
    expect(TaskEnvelopeV1Schema.safeParse(permuted).success).toBe(false);
    const snapshotWithNonGoals = {
      ...valid.taskFrameSnapshot,
      descriptiveNonGoals: ["z", "a", "z"],
    };
    expect(normalizeTaskEnvelopeV1(rehashEnvelope({
      ...valid,
      taskFrameSnapshot: snapshotWithNonGoals,
      taskFrameHash: computeTaskFrameSnapshotV1Hash(snapshotWithNonGoals),
      nonGoals: ["z", "a", "z"],
    })).taskFrameSnapshot.descriptiveNonGoals).toEqual(["a", "z"]);

    const validSet = changeSet();
    const permutedSet = {
      ...validSet,
      changeSetHash: hashA,
      proofObligationIds: ["z", "a", "z"],
    };
    expect(normalizeSemanticChangeSetV1(permutedSet).proofObligationIds).toEqual(["a", "z"]);
    expect(SemanticChangeSetV1Schema.safeParse(permutedSet).success).toBe(false);
  });

  it("checks every object hash and separates hash domains", () => {
    expect(TaskEnvelopeV1Schema.safeParse(envelope()).success).toBe(true);
    expect(SemanticChangeSetV1Schema.safeParse(changeSet()).success).toBe(true);
    expect(PlanningBundleV1Schema.safeParse(bundle()).success).toBe(true);
    expect(ObservationAnalysisV1Schema.safeParse(analysis()).success).toBe(true);
    expect(ReconcileDiffReportV1Schema.safeParse(report()).success).toBe(true);
    expect(TaskEnvelopeV1Schema.safeParse({ ...envelope(), envelopeHash: hashA }).success).toBe(false);
    expect(SemanticChangeSetV1Schema.safeParse({ ...changeSet(), changeSetHash: hashA }).success).toBe(false);
    expect(PlanningBundleV1Schema.safeParse({ ...bundle(), bundleHash: hashA }).success).toBe(false);
    expect(ObservationAnalysisV1Schema.safeParse({ ...analysis(), analysisHash: hashA }).success).toBe(false);
    expect(ReconcileDiffReportV1Schema.safeParse({ ...report(), reportHash: hashA }).success).toBe(false);

    const envelopeValue = envelope();
    const { envelopeHash: _hash, ...payload } = normalizeTaskEnvelopeV1(envelopeValue);
    expect(computeTaskEnvelopeV1Hash(envelopeValue)).toBe(
      sha256HashCanonicalJson({ domain: "SEMCTX_TASK_ENVELOPE_V1\0", value: payload }),
    );
    expect(computeTaskEnvelopeV1Hash(envelopeValue)).not.toBe(
      sha256HashCanonicalJson({ domain: "SEMCTX_SEMANTIC_CHANGE_SET_V1\0", value: payload }),
    );
  });

  it("refuses envelope/change-set/commit/target inconsistencies in a bundle", () => {
    const valid = bundle();
    expect(PlanningBundleV1Schema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      { ...valid, planningCommit: "other" },
      {
        ...valid,
        semanticChangeSet: { ...valid.semanticChangeSet, envelopeId: "other" },
      },
      {
        ...valid,
        acceptedTargetBinding: { ...valid.acceptedTargetBinding!, revision: 2 },
      },
    ]) expect(PlanningBundleV1Schema.safeParse(invalid).success).toBe(false);
  });

  it("binds bundle profile, scope, baseline seal, and target presence exactly", () => {
    const valid = bundle();
    const wrongProfileChangeSet = rehashChangeSet({
      ...valid.semanticChangeSet,
      profile: "redesign",
    });
    const wrongScopeChangeSet = rehashChangeSet({
      ...valid.semanticChangeSet,
      declaredReconciliationScope: {
        kind: "exact_coordinate",
        bindingId: "binding.file",
        coordinateId: "repo:file.src-x",
      },
    });
    for (const invalid of [
      rehashBundle({ ...valid, semanticChangeSet: wrongProfileChangeSet }),
      rehashBundle({ ...valid, semanticChangeSet: wrongScopeChangeSet }),
      rehashBundle({
        ...valid,
        baseline: { ...valid.baseline, freshnessSealHash: hashB },
      }),
      rehashBundle({ ...valid, acceptedTargetBinding: undefined }),
    ]) expect(PlanningBundleV1Schema.safeParse(invalid).success).toBe(false);
  });

  it("content-binds every versioned planning-baseline constituent", () => {
    const valid = bundle();
    for (const baseline of [
      { ...valid.baseline, semanticModelHash: hashA },
      { ...valid.baseline, analyzerConfigHash: hashB },
      { ...valid.baseline, toolVersion: "semctx@other" },
      { ...valid.baseline, storeSchemaVersion: 3 },
      { ...valid.baseline, attestationSetHash: hashB },
    ]) {
      expect(PlanningBundleV1Schema.safeParse({ ...valid, baseline }).success).toBe(false);
    }
    expect(PlanningBundleV1Schema.safeParse(rehashBundle({
      ...valid,
      baseline: { ...valid.baseline, attestationSetHash: null },
    })).success).toBe(false);
  });

  it("admits authored proposed targets diagnostically but gates certifying target bindings", () => {
    const valid = bundle();
    const {
      targetBinding: _changeSetTarget,
      ...diagnosticChangeSetPayload
    } = valid.semanticChangeSet;
    const diagnosticChangeSet = rehashChangeSet(diagnosticChangeSetPayload);
    const {
      acceptedTargetBinding: _acceptedTarget,
      ...diagnosticBundlePayload
    } = valid;
    const diagnosticBundle = rehashBundle({
      ...diagnosticBundlePayload,
      semanticChangeSet: diagnosticChangeSet,
    });
    expect(diagnosticBundle.taskEnvelope.authoredTargetBinding).toBeDefined();
    expect(diagnosticBundle.semanticChangeSet.targetBinding).toBeUndefined();
    expect(diagnosticBundle.acceptedTargetBinding).toBeUndefined();
    expect(PlanningBundleV1Schema.safeParse(diagnosticBundle).success).toBe(true);

    const changeSetWithoutAccepted = rehashBundle({
      ...diagnosticBundlePayload,
      semanticChangeSet: valid.semanticChangeSet,
    });
    expect(PlanningBundleV1Schema.safeParse(changeSetWithoutAccepted).success).toBe(false);

    const acceptedMismatch = rehashBundle({
      ...valid,
      acceptedTargetBinding: {
        ...valid.acceptedTargetBinding!,
        revision: 2,
      },
    });
    expect(PlanningBundleV1Schema.safeParse(acceptedMismatch).success).toBe(false);
  });

  it("seals exact future paths in the ChangeSet without inventing resolved repository facts", () => {
    const taskEnvelope = envelope();
    const baseChangeSet = changeSet();
    const semanticChangeSet = rehashChangeSet({
      ...baseChangeSet,
      envelopeHash: taskEnvelope.envelopeHash,
      refinementSteps: [{
        ...baseChangeSet.refinementSteps[0]!,
        repositoryEditIds: ["edit.add"],
      }],
      repositoryEditExpectations: [{
        schemaVersion: 1,
        kind: "add",
        editId: "edit.add",
        required: true,
        newPath: "src/new.ts",
        expectedLiftedExpectationIds: ["semantic.behavior"],
        acceptanceEvidenceIds: ["evidence.behavior"],
      }],
    });
    const valid = rehashBundle({
      ...bundle(),
      taskEnvelope,
      semanticChangeSet,
      baseline: {
        ...bundle().baseline,
        freshnessSealHash: taskEnvelope.baselineFreshnessSeal,
      },
    });
    expect(PlanningBundleV1Schema.safeParse(valid).success).toBe(true);
    expect(taskEnvelope.resolvedBindings.some((binding) =>
      binding.repositoryPath === "src/new.ts"
    )).toBe(false);

    const addEdit = semanticChangeSet.repositoryEditExpectations[0] as Extract<
      RepositoryEditExpectationV1,
      { kind: "add" }
    >;
    const changedPathChangeSet = rehashChangeSet({
      ...semanticChangeSet,
      repositoryEditExpectations: [{
        ...addEdit,
        newPath: "src/other.ts",
      }],
    });
    expect(PlanningBundleV1Schema.safeParse(rehashBundle({
      ...valid,
      semanticChangeSet: changedPathChangeSet,
    })).success).toBe(true);
    expect(changedPathChangeSet.changeSetHash).not.toBe(semanticChangeSet.changeSetHash);
  });

  it("requires partial observation analysis to declare canonical incomplete reasons", () => {
    const valid = analysis();
    expect(ObservationAnalysisV1Schema.safeParse(valid).success).toBe(true);
    expect(ObservationAnalysisV1Schema.safeParse({
      ...valid,
      completeness: "partial",
    }).success).toBe(false);
    expect(ObservationAnalysisV1Schema.safeParse({
      ...valid,
      completeness: "complete",
      incompleteReasons: ["unsupported_content"],
    }).success).toBe(false);
  });
});

describe("change-set referential integrity and scope coverage", () => {
  it("rejects unknown lifted expectations and dangling step references", () => {
    const valid = changeSet();
    const unknownLift = rehashChangeSet({
      ...valid,
      repositoryEditExpectations: [{
        ...valid.repositoryEditExpectations[0]!,
        expectedLiftedExpectationIds: ["semantic.unknown"],
      }],
    });
    const danglingStep = rehashChangeSet({
      ...valid,
      refinementSteps: [{
        ...valid.refinementSteps[0]!,
        repositoryEditIds: ["edit.unknown"],
      }],
    });
    expect(SemanticChangeSetV1Schema.safeParse(unknownLift).success).toBe(false);
    expect(SemanticChangeSetV1Schema.safeParse(danglingStep).success).toBe(false);
  });

  it("enforces exact-file and exact-coordinate coverage", () => {
    const valid = changeSet();
    const modifyEdit = valid.repositoryEditExpectations[0] as Extract<
      RepositoryEditExpectationV1,
      { kind: "modify" }
    >;
    const escapedFile = rehashChangeSet({
      ...valid,
      repositoryEditExpectations: [{
        ...modifyEdit,
        path: "src/other.ts",
      }],
    });
    const exactCoordinate = rehashChangeSet({
      ...valid,
      declaredReconciliationScope: {
        kind: "exact_coordinate",
        bindingId: "binding.file",
        coordinateId: "repo:file.src-x",
      },
    });
    const escapedCoordinate = rehashChangeSet({
      ...exactCoordinate,
      repositoryEditExpectations: [{
        ...modifyEdit,
        coordinateIds: ["repo:other"],
      }],
    });
    expect(SemanticChangeSetV1Schema.safeParse(escapedFile).success).toBe(false);
    expect(SemanticChangeSetV1Schema.safeParse(exactCoordinate).success).toBe(true);
    expect(SemanticChangeSetV1Schema.safeParse(escapedCoordinate).success).toBe(false);
  });

  it("treats exact future paths as sealed intent while retaining old-side binding coverage", () => {
    const valid = changeSet();
    const coordinateScope: SemanticChangeSetV1["declaredReconciliationScope"] = {
      kind: "coordinate_set" as const,
      bindingIds: ["binding.file"],
      coordinateIds: ["repo:file.src-x"],
    };
    const add = rehashChangeSet({
      ...valid,
      declaredReconciliationScope: coordinateScope,
      refinementSteps: [{
        ...valid.refinementSteps[0]!,
        repositoryEditIds: ["edit.add"],
      }],
      repositoryEditExpectations: [{
        schemaVersion: 1,
        kind: "add",
        editId: "edit.add",
        required: true,
        newPath: "src/new.ts",
        expectedLiftedExpectationIds: ["semantic.behavior"],
        acceptanceEvidenceIds: ["evidence.behavior"],
      }],
    });
    const rename = rehashChangeSet({
      ...valid,
      declaredReconciliationScope: coordinateScope,
      refinementSteps: [{
        ...valid.refinementSteps[0]!,
        repositoryEditIds: ["edit.rename"],
      }],
      repositoryEditExpectations: [{
        schemaVersion: 1,
        kind: "rename",
        editId: "edit.rename",
        required: true,
        oldPath: "src/x.ts",
        newPath: "src/new.ts",
        coordinateIds: ["repo:file.src-x"],
        expectedLiftedExpectationIds: ["semantic.behavior"],
        acceptanceEvidenceIds: ["evidence.behavior"],
      }],
    });
    expect(SemanticChangeSetV1Schema.safeParse(add).success).toBe(true);
    expect(SemanticChangeSetV1Schema.safeParse(rename).success).toBe(true);
    const addEdit = add.repositoryEditExpectations[0] as Extract<
      RepositoryEditExpectationV1,
      { kind: "add" }
    >;
    const renameEdit = rename.repositoryEditExpectations[0] as Extract<
      RepositoryEditExpectationV1,
      { kind: "rename" }
    >;
    expect(SemanticChangeSetV1Schema.safeParse(rehashChangeSet({
      ...rename,
      repositoryEditExpectations: [{
        ...renameEdit,
        coordinateIds: ["repo:outside"],
      }],
    })).success).toBe(false);
    expect(RepositoryEditExpectationV1Schema.safeParse({
      ...addEdit,
      containingScopeBindingId: "binding.outside",
    }).success).toBe(false);
  });
});

describe("evidence and terminal-status coherence", () => {
  it("binds satisfied evidence and preserves missing evidence semantics", () => {
    const satisfied = report().evidenceEvaluations[0]!;
    expect(EvidenceEvaluationV1Schema.safeParse(satisfied).success).toBe(true);
    expect(EvidenceEvaluationV1Schema.safeParse({
      ...satisfied,
      evidenceId: null,
    }).success).toBe(false);
    expect(EvidenceEvaluationV1Schema.safeParse({
      ...satisfied,
      result: "missing",
    }).success).toBe(false);
    const {
      semanticEvidenceDigest: _semanticDigest,
      attestationSetHash: _attestationSet,
      observationAnalysisHash: _analysisHash,
      ...withoutBindings
    } = satisfied;
    expect(EvidenceEvaluationV1Schema.safeParse({
      ...withoutBindings,
      result: "missing",
      evidenceId: null,
      acceptedAttestationDigests: [],
      provenance: [],
    }).success).toBe(true);
  });

  it("closes stale, unbound, failing, and attestation-binding combinations", () => {
    const satisfied = report().evidenceEvaluations[0]!;
    for (const invalid of [
      {
        ...satisfied,
        semanticEvidenceDigest: undefined,
        acceptedAttestationDigests: [],
        attestationSetHash: undefined,
        provenance: ["plane_a_observed", "plane_b_authored"],
      },
      { ...satisfied, provenance: ["canonical_attestation", "plane_b_authored"] },
      { ...satisfied, attestationSetHash: undefined },
      { ...satisfied, acceptedAttestationDigests: [] },
      { ...satisfied, result: "stale", evidenceId: null },
      {
        ...satisfied,
        result: "unbound",
        acceptedAttestationDigests: [hashB],
        provenance: ["canonical_attestation", "plane_b_authored"],
      },
      { ...satisfied, result: "failing", provenance: ["plane_b_authored"] },
    ]) expect(EvidenceEvaluationV1Schema.safeParse(invalid).success).toBe(false);

    expect(EvidenceEvaluationV1Schema.safeParse({
      ...satisfied,
      semanticEvidenceDigest: undefined,
      provenance: ["canonical_attestation", "plane_b_authored"],
    }).success).toBe(true);
    expect(EvidenceEvaluationV1Schema.safeParse({
      ...satisfied,
      result: "stale",
    }).success).toBe(true);
    const {
      acceptedAttestationDigests: _attestations,
      attestationSetHash: _set,
      observationAnalysisHash: _observation,
      ...unboundBase
    } = satisfied;
    expect(EvidenceEvaluationV1Schema.safeParse({
      ...unboundBase,
      result: "unbound",
      acceptedAttestationDigests: [],
      provenance: ["plane_b_authored"],
    }).success).toBe(true);
    expect(EvidenceEvaluationV1Schema.safeParse({
      ...satisfied,
      result: "failing",
    }).success).toBe(true);
  });

  it("accepts exactly the terminal reason classes and dominance representation", () => {
    for (const valid of [
      report("REALIZED"),
      report("REFUSED", ["INPUT_SCHEMA_INVALID", "INDEX_STALE"]),
      report("VIOLATED", ["SCOPE_ESCAPE", "MISSING_PLANNED_EDIT"]),
      report("UNPROVEN", ["BASELINE_NOT_CLEAN", "ROUND_TRIP_UNPROVEN"]),
      report("VIOLATED", ["SCOPE_ESCAPE"], ["OBSERVATION_ANALYSIS_UNAVAILABLE"]),
    ]) expect(ReconcileDiffReportV1Schema.safeParse(valid).success).toBe(true);

    for (const invalid of [
      report("REFUSED", ["SCOPE_ESCAPE"]),
      report("VIOLATED", ["BASELINE_NOT_CLEAN"]),
      report("UNPROVEN", ["INDEX_STALE"]),
      report("REALIZED", ["ROUND_TRIP_UNPROVEN"]),
      report("UNPROVEN", ["BASELINE_NOT_CLEAN"], ["ROUND_TRIP_UNPROVEN"]),
    ]) expect(ReconcileDiffReportV1Schema.safeParse(invalid).success).toBe(false);
  });

  it("rejects duplicate, reversed, or primary-mismatched reasons", () => {
    const canonical = report("REFUSED", ["INPUT_SCHEMA_INVALID", "INDEX_STALE"]);
    expect(ReconcileDiffReportV1Schema.safeParse({
      ...canonical,
      reasonCodes: [...canonical.reasonCodes].reverse(),
    }).success).toBe(false);
    expect(ReconcileDiffReportV1Schema.safeParse({
      ...canonical,
      reasonCodes: ["INPUT_SCHEMA_INVALID", "INPUT_SCHEMA_INVALID"],
    }).success).toBe(false);
    expect(ReconcileDiffReportV1Schema.safeParse({
      ...canonical,
      primaryReason: "INDEX_STALE",
    }).success).toBe(false);
  });

  it("falsifies every conjunct of the REALIZED positive predicate", () => {
    const valid = report();
    const failingEvidence = {
      ...valid.evidenceEvaluations[0]!,
      result: "failing" as const,
    };
    const mutations: ReconcileDiffReportV1[] = [
      rehashReport({ ...valid, missingPlannedEditIds: ["edit.modify"] }),
      rehashReport({ ...valid, requiredPlannedEditIds: ["edit.modify", "edit.other"] }),
      rehashReport({ ...valid, observedHunkIds: [hashA, hashB] }),
      rehashReport({ ...valid, matchedPlannedEdits: [] }),
      rehashReport({ ...valid, unplannedCoordinateIds: ["repo:other"] }),
      rehashReport({ ...valid, scopeEscapes: [{ path: "src/other.ts" }] }),
      rehashReport({ ...valid, invariantDriftIds: ["invariant.changed"] }),
      rehashReport({ ...valid, undeclaredLiftedExpectationIds: ["goal.undeclared"] }),
      rehashReport({
        ...valid,
        targetRealizationFindings: [{
          ...valid.targetRealizationFindings[0]!,
          result: "not_realized",
        }],
      }),
      rehashReport({ ...valid, targetRealizationFindings: [] }),
      rehashReport({
        ...valid,
        targetRealizationFindings: [{
          ...valid.targetRealizationFindings[0]!,
          evidenceIds: [],
        }],
      }),
      rehashReport({ ...valid, evidenceEvaluations: [failingEvidence] }),
      rehashReport({ ...valid, evidenceEvaluations: [] }),
      rehashReport({ ...valid, requiredRoundTripExpectationIds: ["semantic.other"] }),
      rehashReport({ ...valid, certifiedRoundTrips: [] }),
      rehashReport({
        ...valid,
        observationAnalysis: {
          ...valid.observationAnalysis!,
          completeness: "partial",
        },
      }),
      rehashReport({ ...valid, observationAnalysis: null }),
    ];
    expect(ReconcileDiffReportV1Schema.safeParse(valid).success).toBe(true);
    for (const invalid of mutations) {
      expect(ReconcileDiffReportV1Schema.safeParse(invalid).success).toBe(false);
    }
  });

  it("rejects non-canonical nested report arrays even with their normalized hash", () => {
    const valid = report();
    const nonCanonical = [
      rehashReport({
        ...valid,
        requiredPlannedEditIds: ["z", "a"],
      }),
      rehashReport({
        ...valid,
        scopeEscapes: [{ path: "z.ts" }, { path: "a.ts" }],
      }),
      rehashReport({
        ...valid,
        targetRealizationFindings: [{
          ...valid.targetRealizationFindings[0]!,
          evidenceIds: ["z", "a"],
        }],
      }),
      rehashReport({
        ...valid,
        certifiedRoundTrips: [{
          ...valid.certifiedRoundTrips[0]!,
          coordinateIds: ["repo:z", "repo:a"],
          evidenceIds: ["z", "a"],
        }],
      }),
      rehashReport({
        ...valid,
        advisoryDiagnostics: [
          { code: "OPTIONAL_EDIT_MISSING", message: "z", subjectIds: ["z"] },
          { code: "ANALYZER_FAILURE", message: "a", subjectIds: ["a"] },
        ],
      }),
    ];
    for (const invalid of nonCanonical) {
      expect(ReconcileDiffReportV1Schema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("ReconciliationAnalysisV1 public proof artifact", () => {
  it("accepts the closed, authority-free, fully content-bound shape", () => {
    const valid = reconciliationAnalysis();
    expect(ReconciliationAnalysisV1Schema.safeParse(valid).success).toBe(true);
    expect(ReconciliationAnalysisV1Schema.safeParse({
      ...valid,
      executionAuthority: "allow",
    }).success).toBe(false);
    expect(ReconciliationAnalysisV1Schema.safeParse({
      ...valid,
      executor: { command: "apply" },
    }).success).toBe(false);
  });

  it("binds every internal artifact hash and the exact observed hunk bytes", () => {
    const valid = reconciliationAnalysis();
    const mutatedBytes = new Uint8Array(valid.observedHunks[0]!.rawHunkBytes);
    mutatedBytes[mutatedBytes.length - 1] = (mutatedBytes.at(-1) ?? 0) ^ 1;
    for (const invalid of [
      { ...valid, analysisHash: hashA },
      { ...valid, planningBundleHash: hashA },
      rehashReconciliationAnalysis({ ...valid, candidateGraphHash: hashA }),
      rehashReconciliationAnalysis({ ...valid, candidateArchitectureHash: hashA }),
      rehashReconciliationAnalysis({ ...valid, observedDiffHash: hashA }),
      rehashReconciliationAnalysis({ ...valid, architectureDeltaHash: hashA }),
      rehashReconciliationAnalysis({
        ...valid,
        observedHunks: [{ ...valid.observedHunks[0]!, rawHunkBytes: mutatedBytes }],
      }),
      rehashReconciliationAnalysis({
        ...valid,
        observationAnalysis: { ...valid.observationAnalysis, analysisHash: hashA },
      }),
    ]) {
      expect(ReconciliationAnalysisV1Schema.safeParse(invalid).success).toBe(false);
    }
  });

  it("preserves semantic round-trip order without requiring lexical relation ids", () => {
    const valid = reconciliationAnalysis();
    expect(valid.roundTripCoverages[0]!.steps.map((step) => step.relationId)).toEqual([
      "relation.z.behavior-to-capability",
      "relation.a.capability-to-contract",
      "relation.m.contract-to-edit",
    ]);
    expect(ReconciliationAnalysisV1Schema.safeParse(valid).success).toBe(true);
    expect(ReconciliationAnalysisV1Schema.safeParse(rehashReconciliationAnalysis({
      ...valid,
      roundTripCoverages: [{
        ...valid.roundTripCoverages[0]!,
        steps: [...valid.roundTripCoverages[0]!.steps].reverse(),
      }],
    })).success).toBe(false);
  });

  it("hashes set permutations identically but stores only canonical order", () => {
    const valid = reconciliationAnalysis();
    const permuted = {
      ...valid,
      advisoryDiagnostics: [...valid.advisoryDiagnostics].reverse(),
      targetAnalysis: {
        ...valid.targetAnalysis!,
        reviewAttestationDigests: [...valid.targetAnalysis!.reviewAttestationDigests].reverse(),
      },
      evidenceInputs: [{
        ...valid.evidenceInputs[0]!,
        acceptedAttestationDigests: [
          ...valid.evidenceInputs[0]!.acceptedAttestationDigests!,
        ].reverse(),
        provenance: [...valid.evidenceInputs[0]!.provenance].reverse(),
      }],
      evidenceEvaluations: [{
        ...valid.evidenceEvaluations[0]!,
        acceptedAttestationDigests: [
          ...valid.evidenceEvaluations[0]!.acceptedAttestationDigests,
        ].reverse(),
        provenance: [...valid.evidenceEvaluations[0]!.provenance].reverse(),
      }],
    };
    expect(computeReconciliationAnalysisV1Hash(permuted)).toBe(valid.analysisHash);
    const nonCanonical = {
      ...permuted,
      analysisHash: computeReconciliationAnalysisV1Hash(permuted),
    };
    expect(ReconciliationAnalysisV1Schema.safeParse(nonCanonical).success).toBe(false);
    expect(normalizeReconciliationAnalysisV1(nonCanonical)).toEqual(valid);
  });

  it("keeps proposed targets diagnostic and accepted targets attested", () => {
    const valid = reconciliationAnalysis();
    const proposed = rehashReconciliationAnalysis({
      ...valid,
      targetAnalysis: {
        ...valid.targetAnalysis!,
        normativeStatus: "proposed",
        reviewAttestationDigests: [],
        findings: valid.targetAnalysis!.findings.map((finding) => ({
          ...finding,
          result: "unproven",
          evidenceIds: [],
        })),
      },
    });
    expect(ReconciliationAnalysisV1Schema.safeParse(proposed).success).toBe(true);
    expect(ReconciliationAnalysisV1Schema.safeParse(rehashReconciliationAnalysis({
      ...proposed,
      targetAnalysis: {
        ...proposed.targetAnalysis!,
        findings: [{
          ...proposed.targetAnalysis!.findings[0]!,
          result: "realized",
          evidenceIds: ["evidence.behavior"],
        }],
      },
    })).success).toBe(false);
    expect(ReconciliationAnalysisV1Schema.safeParse(rehashReconciliationAnalysis({
      ...valid,
      targetAnalysis: {
        ...valid.targetAnalysis!,
        reviewAttestationDigests: [],
      },
    })).success).toBe(false);
    expect(ReconciliationAnalysisV1Schema.safeParse(rehashReconciliationAnalysis({
      ...valid,
      targetAnalysis: {
        ...valid.targetAnalysis!,
        findings: valid.targetAnalysis!.findings.map((finding) => ({
          ...finding,
          evidenceIds: ["evidence.arbitrary"],
        })),
      },
    })).success).toBe(false);
  });

  it("rejects dangling hunk, requirement, expectation, subject, edit, coordinate, and evidence refs", () => {
    const valid = reconciliationAnalysis();
    const coverage = valid.roundTripCoverages[0]!;
    const mutations: ReconciliationAnalysisV1[] = [
      rehashReconciliationAnalysis({
        ...valid,
        hunkBindings: [{ ...valid.hunkBindings[0]!, hunkId: hashA }],
      }),
      rehashReconciliationAnalysis({
        ...valid,
        evidenceInputs: [{
          ...valid.evidenceInputs[0]!,
          requirementId: "requirement.dangling",
        }],
      }),
      rehashReconciliationAnalysis({
        ...valid,
        roundTripCoverages: [{ ...coverage, expectationId: "expectation.dangling" }],
      }),
      rehashReconciliationAnalysis({
        ...valid,
        roundTripCoverages: [{ ...coverage, semanticSubjectId: "subject.dangling" }],
      }),
      rehashReconciliationAnalysis({
        ...valid,
        roundTripCoverages: [{ ...coverage, editId: "edit.dangling" }],
      }),
      rehashReconciliationAnalysis({
        ...valid,
        roundTripCoverages: [{
          ...coverage,
          terminalCoordinateIds: ["repo:dangling"],
        }],
      }),
      rehashReconciliationAnalysis({
        ...valid,
        roundTripCoverages: [{ ...coverage, evidenceIds: ["evidence.dangling"] }],
      }),
    ];
    for (const invalid of mutations) {
      expect(ReconciliationAnalysisV1Schema.safeParse(invalid).success).toBe(false);
    }
  });

  it("rejects positive evidence, round trips, and target findings without seals or digests", () => {
    const valid = reconciliationAnalysis();
    const input = valid.evidenceInputs[0]!;
    const evaluation = valid.evidenceEvaluations[0]!;
    const coverage = valid.roundTripCoverages[0]!;
    for (const invalid of [
      rehashReconciliationAnalysis({
        ...valid,
        evidenceInputs: [{ ...input, observationAnalysisHash: undefined }],
        evidenceEvaluations: [{ ...evaluation, observationAnalysisHash: undefined }],
      }),
      rehashReconciliationAnalysis({
        ...valid,
        roundTripCoverages: [{ ...coverage, steps: [] }],
      }),
      rehashReconciliationAnalysis({
        ...valid,
        roundTripCoverages: [{
          ...coverage,
          steps: coverage.steps.map((step) => ({
            ...step,
            epistemicStatus: "hypothetical",
          })),
        }],
      }),
      rehashReconciliationAnalysis({
        ...valid,
        targetAnalysis: {
          ...valid.targetAnalysis!,
          findings: valid.targetAnalysis!.findings.map((finding) => ({
            ...finding,
            evidenceIds: [],
          })),
        },
      }),
    ]) {
      expect(ReconciliationAnalysisV1Schema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("strict reconciliation input", () => {
  it("accepts only schemaVersion and PlanningBundle", () => {
    const input = { schemaVersion: 1, planningBundle: bundle() };
    expect(ReconcileWorkingTreeInputV1Schema.safeParse(input).success).toBe(true);
    for (const extra of [
      { base: "main" },
      { head: "HEAD" },
      { baseRef: "main" },
      { headRef: "HEAD" },
    ]) {
      expect(ReconcileWorkingTreeInputV1Schema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
    expect(ReconcileWorkingTreeInputV1Schema.safeParse({
      ...input,
      schemaVersion: 2,
    }).success).toBe(false);
  });
});
