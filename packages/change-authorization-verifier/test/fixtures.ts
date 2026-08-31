/**
 * Golden-capsule fixtures built with the real engine (`@semantic-context/control-engine`,
 * devDependency, test-only). This lets the independent verifier be checked against capsules an
 * actual host would produce, without the verifier's own `src` ever depending on the engine.
 */
import * as controlModel from "@semantic-context/control-model";
import type {
  ChangeAuthorizationPolicyDescriptorV1,
  ChangeAuthorizationProviderV1,
  ChangeAuthorizationTrustPolicyDescriptorV1,
  ControlHandoffRecordV2,
  PlanningBundleV1,
  SemanticChangeSetV1,
  TaskEnvelopeV1,
  TaskFrameSnapshotV1,
} from "@semantic-context/control-model";
import type {
  ChangeAuthorizationAssertionInputV1,
  ChangeAuthorizationClaimInputV1,
  ChangeAuthorizationEvaluationInputV1,
  ChangeAuthorizationPolicyRuleInputV1,
} from "@semantic-context/control-engine";

export const hashA = `sha256:${"a".repeat(64)}` as const;
export const hashB = `sha256:${"b".repeat(64)}` as const;
export const hashC = `sha256:${"c".repeat(64)}` as const;

function taskFrame(): TaskFrameSnapshotV1 {
  return {
    schemaVersion: 1,
    taskFrameId: "task.verifier",
    rawTaskDigest: hashA,
    mode: "feature",
    createdAt: "2026-08-01T10:00:00.000Z",
    capabilitySignals: ["authorization"],
    riskSignals: ["control_plane"],
    profileCandidate: "feature",
    altitudeCandidate: 3,
  };
}

function envelope(changeId = "change.verifier"): TaskEnvelopeV1 {
  const snapshot = taskFrame();
  const input: Omit<TaskEnvelopeV1, "envelopeHash"> = {
    schemaVersion: 1,
    kind: "task_envelope",
    executionAuthority: "none",
    envelopeId: "envelope.verifier",
    planningCommit: "abc123",
    taskFrameSnapshot: snapshot,
    taskFrameHash: controlModel.computeTaskFrameSnapshotV1Hash(snapshot),
    changeId,
    changeContractHash: hashB,
    coordinateGraphSeal: hashA,
    indexSeal: hashB,
    baselineFreshnessSeal: hashC,
    profile: "feature",
    risk: "R1",
    requiredAltitude: 3,
    candidateAnchors: [],
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
    parentIntentIds: ["goal.verifier"],
    preservedInvariantIds: ["invariant.no-authority"],
    nonGoals: ["execute.patch"],
    expectedBehaviorDelta: ["authorization.is.reproducible"],
    declaredReconciliationScope: { kind: "file", bindingId: "binding.file", path: "src/x.ts" },
    proofObligationIds: ["proof.verifier"],
    compatibilityNotes: [],
  };
  return { ...input, envelopeHash: controlModel.computeTaskEnvelopeV1Hash(input) };
}

function changeSet(changeId = "change.verifier"): SemanticChangeSetV1 {
  const taskEnvelope = envelope(changeId);
  const input: Omit<SemanticChangeSetV1, "changeSetHash"> = {
    schemaVersion: 1,
    kind: "semantic_change_set",
    executionAuthority: "none",
    changeSetId: "changeset.verifier",
    envelopeId: taskEnvelope.envelopeId,
    envelopeHash: taskEnvelope.envelopeHash,
    planningCommit: taskEnvelope.planningCommit,
    profile: "feature",
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
      subjectId: "semantic:capability.verifier",
      statement: "The verification is bound to the observed repository state.",
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
    testReferences: ["test.verifier"],
    acceptanceEvidenceIds: ["evidence.behavior"],
    proofObligationIds: ["proof.verifier"],
  };
  return { ...input, changeSetHash: controlModel.computeSemanticChangeSetV1Hash(input) };
}

function planningBundle(changeId = "change.verifier"): PlanningBundleV1 {
  const taskEnvelope = envelope(changeId);
  const semanticChangeSet = changeSet(changeId);
  const input: Omit<PlanningBundleV1, "bundleHash"> = {
    schemaVersion: 1,
    kind: "planning_bundle",
    executionAuthority: "none",
    bundleId: "bundle.verifier",
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
      toolVersion: "semctx@0.1.18",
      storeSchemaVersion: 2,
      attestationSetHash: hashA,
    },
  };
  return { ...input, bundleHash: controlModel.computePlanningBundleV1Hash(input) };
}

function progress() {
  const input = {
    state: "step_completed" as const,
    currentCoordinateId: "repo:file.src-x" as const,
    currentAbstractionLevel: 0 as const,
    completedRefinementStep: { stepId: "step.0", order: 0 },
    matchedRepositoryEditIds: ["edit.modify"],
    certifiedExpectationIds: ["semantic.behavior"],
    satisfiedEvidenceRequirementIds: ["evidence.behavior"],
  };
  return { ...input, progressHash: controlModel.computeControlHandoffProgressV2Hash(input) };
}

function capsuleV2(bundleValue: PlanningBundleV1, terminalStatus: "REALIZED" | "VIOLATED" | "UNPROVEN" = "REALIZED") {
  const reasonCodes = terminalStatus === "REALIZED"
    ? []
    : terminalStatus === "VIOLATED"
      ? ["SCOPE_ESCAPE" as const]
      : ["ROUND_TRIP_UNPROVEN" as const];
  const input = {
    schemaVersion: 2 as const,
    kind: "control_handoff_capsule" as const,
    executionAuthority: "none" as const,
    enforcementMode: "shadow" as const,
    blockingEnabled: false as const,
    sourceContentCollected: false as const,
    planningBundleId: bundleValue.bundleId,
    planningBundleHash: bundleValue.bundleHash,
    envelopeId: bundleValue.taskEnvelope.envelopeId,
    envelopeHash: bundleValue.taskEnvelope.envelopeHash,
    changeSetId: bundleValue.semanticChangeSet.changeSetId,
    changeSetHash: bundleValue.semanticChangeSet.changeSetHash,
    planningCommit: bundleValue.planningCommit,
    progress: progress(),
    seals: {
      coordinateGraphSeal: bundleValue.taskEnvelope.coordinateGraphSeal,
      indexSeal: bundleValue.taskEnvelope.indexSeal,
      baselineFreshnessSeal: bundleValue.taskEnvelope.baselineFreshnessSeal,
      reconciliationReportHash: hashA,
      reconciliationAnalysisHash: hashB,
      observationAnalysisHash: hashC,
    },
    repositoryIdentity: "repo:semctx",
    observedCommit: "def456",
    observedWorkingDiffHash: hashB,
    reconciliationTerminalStatus: terminalStatus,
    reconciliationReasonCodes: reasonCodes,
    touchedCoordinateIds: ["repo:file.src-x" as const],
    unmappedObservedHunkIds: [],
    proofsObtained: [{
      schemaVersion: 1 as const,
      requirementId: "evidence.behavior",
      origin: "semantic_expectation" as const,
      required: true,
      evidenceId: "evidence.behavior",
      semanticEvidenceDigest: hashA,
      acceptedAttestationDigests: [hashB],
      planningCommit: bundleValue.planningCommit,
      observedDiffHash: hashB,
      semanticModelHash: hashC,
      attestationSetHash: hashA,
      observationAnalysisHash: hashC,
      provenance: ["canonical_attestation" as const, "plane_a_observed" as const, "plane_b_authored" as const],
      result: "satisfied" as const,
    }],
    descriptiveRefinementStepIds: controlModel.computeControlHandoffDescriptiveRefinementStepIdsV2(
      bundleValue.semanticChangeSet,
    ),
    nextValidTransition: terminalStatus === "REALIZED"
      ? { kind: "verify_change" as const }
      : { kind: "repair_then_reconcile" as const, reasonCodes },
  };
  return { ...input, capsuleHash: controlModel.computeControlHandoffCapsuleV2Hash(input) };
}

export function record(
  terminalStatus: "REALIZED" | "VIOLATED" | "UNPROVEN" = "REALIZED",
  changeId = "change.verifier",
): ControlHandoffRecordV2 {
  const bundleValue = planningBundle(changeId);
  const request = {
    schemaVersion: 2 as const,
    planningBundle: bundleValue,
    progress: {
      state: "step_completed" as const,
      completedRefinementStepId: "step.0",
      currentCoordinateId: "repo:file.src-x" as const,
    },
  };
  return {
    schemaVersion: 2,
    kind: "control_handoff_record",
    request,
    capsule: capsuleV2(bundleValue, terminalStatus),
  };
}

export function provider(overrides: Partial<ChangeAuthorizationProviderV1> = {}): ChangeAuthorizationProviderV1 {
  return {
    schemaVersion: 1,
    providerId: "provider.tests",
    kind: "test_runner",
    version: "1.0.0",
    digest: hashA,
    status: "AVAILABLE",
    capabilities: ["run_tests"],
    observedAt: "2026-08-01T09:00:00.000Z",
    expiresAt: "2026-09-01T09:00:00.000Z",
    trustRootId: "root.tests",
    ...overrides,
  };
}

export function policyDescriptor(): ChangeAuthorizationPolicyDescriptorV1 {
  return {
    schemaVersion: 1,
    policyId: "policy.verifier-tests",
    policyVersion: "1.0.0",
    policyUri: "https://semctx.test/policy/verifier",
  };
}

export function trustPolicyDescriptor(): ChangeAuthorizationTrustPolicyDescriptorV1 {
  return {
    schemaVersion: 1,
    trustPolicyId: "trust-policy.verifier-tests",
    trustPolicyVersion: "1.0.0",
  };
}

export const REQUIRED_CLAIM_ID = "claim.tests-pass";

export function testsPassClaimInput(): ChangeAuthorizationClaimInputV1 {
  return {
    claimId: REQUIRED_CLAIM_ID,
    statement: "The candidate diff is covered by a passing test observation.",
    subject: { kind: "CHANGE_REQUIREMENT", requirementId: "requirement.tests-pass" },
  };
}

export function passingAssertionInput(
  overrides: Partial<ChangeAuthorizationAssertionInputV1> = {},
): ChangeAuthorizationAssertionInputV1 {
  return {
    assertionId: "assertion.test-pass",
    claimId: REQUIRED_CLAIM_ID,
    conclusion: "SUPPORTS",
    modality: "TEST_OBSERVED",
    producerId: "producer.bun-test",
    producerVersion: "1.2.3",
    methodName: "bun test",
    methodParameters: { pattern: "packages/**/*.test.ts" },
    scope: { schemaVersion: 1, coordinateIds: ["repo:file.src-x"] },
    observedAt: "2026-08-01T09:30:00.000Z",
    expiresAt: "2026-09-01T09:30:00.000Z",
    providerId: "provider.tests",
    artifacts: [],
    dependsOnAssertionIds: [],
    contradictsAssertionIds: [],
    ...overrides,
  };
}

export function testsPassRule(
  overrides: Partial<ChangeAuthorizationPolicyRuleInputV1> = {},
): ChangeAuthorizationPolicyRuleInputV1 {
  return {
    ruleId: "rule.tests-pass",
    description: "The candidate diff must be covered by a passing test observation.",
    requiredClaimId: REQUIRED_CLAIM_ID,
    allowedModalities: ["FORMALLY_PROVED", "RUNTIME_OBSERVED", "STATICALLY_VERIFIED", "TEST_OBSERVED"],
    ...overrides,
  };
}

export function baseEvaluationInput(
  overrides: Partial<ChangeAuthorizationEvaluationInputV1> = {},
): ChangeAuthorizationEvaluationInputV1 {
  return {
    capsuleId: "capsule.verifier-test",
    basisRecord: record("REALIZED"),
    providers: [provider()],
    claims: [testsPassClaimInput()],
    assertions: [passingAssertionInput()],
    evidenceBundles: [{ bundleId: "bundle.rule-tests-pass", ruleId: "rule.tests-pass", assertionIds: ["assertion.test-pass"] }],
    policyRules: [testsPassRule()],
    trustedRootIds: ["root.tests"],
    policyDescriptor: policyDescriptor(),
    trustPolicyDescriptor: trustPolicyDescriptor(),
    evaluatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}
