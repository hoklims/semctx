import { describe, expect, it } from "bun:test";
import * as controlModel from "@semantic-context/control-model";
import type {
  ChangeAuthorizationCapsuleV1,
  ChangeAuthorizationPolicyDescriptorV1,
  ChangeAuthorizationProviderV1,
  ChangeAuthorizationTrustPolicyDescriptorV1,
  ControlHandoffRecordV2,
  EvidenceRefV1,
  PlanningBundleV1,
  SemanticChangeSetV1,
  TaskEnvelopeV1,
  TaskFrameSnapshotV1,
} from "@semantic-context/control-model";
import {
  ChangeAuthorizationEvaluationError,
  compareChangeAuthorizationMonotonicityV1,
  evaluateChangeAuthorizationV1,
  projectChangeAuthorizationSubjectV1,
  replayChangeAuthorizationV1,
  type ChangeAuthorizationAssertionInputV1,
  type ChangeAuthorizationClaimInputV1,
  type ChangeAuthorizationEvaluationInputV1,
  type ChangeAuthorizationPolicyRuleInputV1,
} from "../src";

const hashA = `sha256:${"a".repeat(64)}` as const;
const hashB = `sha256:${"b".repeat(64)}` as const;
const hashC = `sha256:${"c".repeat(64)}` as const;

function taskFrame(): TaskFrameSnapshotV1 {
  return {
    schemaVersion: 1,
    taskFrameId: "task.authorization-engine",
    rawTaskDigest: hashA,
    mode: "feature",
    createdAt: "2026-08-01T10:00:00.000Z",
    capabilitySignals: ["authorization"],
    riskSignals: ["control_plane"],
    profileCandidate: "feature",
    altitudeCandidate: 3,
  };
}

function envelope(changeId = "change.authorization-engine"): TaskEnvelopeV1 {
  const snapshot = taskFrame();
  const input: Omit<TaskEnvelopeV1, "envelopeHash"> = {
    schemaVersion: 1,
    kind: "task_envelope",
    executionAuthority: "none",
    envelopeId: "envelope.authorization-engine",
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
    parentIntentIds: ["goal.authorization"],
    preservedInvariantIds: ["invariant.no-authority"],
    nonGoals: ["execute.patch"],
    expectedBehaviorDelta: ["authorization.is.reproducible"],
    declaredReconciliationScope: { kind: "file", bindingId: "binding.file", path: "src/x.ts" },
    proofObligationIds: ["proof.authorization"],
    compatibilityNotes: [],
  };
  return { ...input, envelopeHash: controlModel.computeTaskEnvelopeV1Hash(input) };
}

function changeSet(changeId = "change.authorization-engine"): SemanticChangeSetV1 {
  const taskEnvelope = envelope(changeId);
  const input: Omit<SemanticChangeSetV1, "changeSetHash"> = {
    schemaVersion: 1,
    kind: "semantic_change_set",
    executionAuthority: "none",
    changeSetId: "changeset.authorization-engine",
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
      subjectId: "semantic:capability.authorization",
      statement: "The authorization is bound to the observed repository state.",
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
    testReferences: ["test.authorization"],
    acceptanceEvidenceIds: ["evidence.behavior"],
    proofObligationIds: ["proof.authorization"],
  };
  return { ...input, changeSetHash: controlModel.computeSemanticChangeSetV1Hash(input) };
}

function planningBundle(changeId = "change.authorization-engine"): PlanningBundleV1 {
  const taskEnvelope = envelope(changeId);
  const semanticChangeSet = changeSet(changeId);
  const input: Omit<PlanningBundleV1, "bundleHash"> = {
    schemaVersion: 1,
    kind: "planning_bundle",
    executionAuthority: "none",
    bundleId: "bundle.authorization-engine",
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
      toolVersion: "semctx@0.1.17",
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

function record(
  terminalStatus: "REALIZED" | "VIOLATED" | "UNPROVEN" = "REALIZED",
  changeId = "change.authorization-engine",
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

function provider(overrides: Partial<ChangeAuthorizationProviderV1> = {}): ChangeAuthorizationProviderV1 {
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

function policyDescriptor(): ChangeAuthorizationPolicyDescriptorV1 {
  return {
    schemaVersion: 1,
    policyId: "policy.authorization-engine-tests",
    policyVersion: "1.0.0",
    policyUri: "https://semctx.test/policy/authorization-engine",
  };
}

function trustPolicyDescriptor(): ChangeAuthorizationTrustPolicyDescriptorV1 {
  return {
    schemaVersion: 1,
    trustPolicyId: "trust-policy.authorization-engine-tests",
    trustPolicyVersion: "1.0.0",
  };
}

const REQUIRED_CLAIM_ID = "claim.tests-pass";

function testsPassClaimInput(): ChangeAuthorizationClaimInputV1 {
  return {
    claimId: REQUIRED_CLAIM_ID,
    statement: "The candidate diff is covered by a passing test observation.",
    subject: { kind: "CHANGE_REQUIREMENT", requirementId: "requirement.tests-pass" },
  };
}

function passingAssertionInput(
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

function testsPassRule(overrides: Partial<ChangeAuthorizationPolicyRuleInputV1> = {}): ChangeAuthorizationPolicyRuleInputV1 {
  return {
    ruleId: "rule.tests-pass",
    description: "The candidate diff must be covered by a passing test observation.",
    requiredClaimId: REQUIRED_CLAIM_ID,
    allowedModalities: ["FORMALLY_PROVED", "RUNTIME_OBSERVED", "STATICALLY_VERIFIED", "TEST_OBSERVED"],
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<ChangeAuthorizationEvaluationInputV1> = {},
): ChangeAuthorizationEvaluationInputV1 {
  return {
    capsuleId: "capsule.authorization-engine-test",
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

describe("evaluateChangeAuthorizationV1", () => {
  it("is deterministic: identical sealed input always yields the same capsule hash", () => {
    const input = baseInput();
    const first = evaluateChangeAuthorizationV1(input);
    const second = evaluateChangeAuthorizationV1(baseInput());
    expect(first.capsuleHash).toBe(second.capsuleHash);
    expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(first).success).toBe(true);
  });

  it("stores artifacts canonically so input permutations produce one assertion and capsule identity", () => {
    const artifactA: EvidenceRefV1 = {
      schemaVersion: 1,
      kind: "test_result",
      locator: "artifact.a",
      digest: { algorithm: "sha256", value: "a".repeat(64) },
    };
    const artifactB: EvidenceRefV1 = {
      schemaVersion: 1,
      kind: "test_result",
      locator: "artifact.b",
      digest: { algorithm: "sha256", value: "b".repeat(64) },
    };
    const first = evaluateChangeAuthorizationV1(baseInput({
      assertions: [passingAssertionInput({ artifacts: [artifactA, artifactB] })],
    }));
    const second = evaluateChangeAuthorizationV1(baseInput({
      assertions: [passingAssertionInput({ artifacts: [artifactB, artifactA] })],
    }));
    expect(first.assertions[0]?.artifacts).toEqual([artifactA, artifactB]);
    expect(first.assertions[0]?.assertionHash).toBe(second.assertions[0]?.assertionHash);
    expect(first.capsuleHash).toBe(second.capsuleHash);
    expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(first).success).toBe(true);
    expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(second).success).toBe(true);
  });

  it("returns ALLOW with POLICY_SATISFIED when the basis is realized and the rule is satisfied", () => {
    const capsule = evaluateChangeAuthorizationV1(baseInput());
    expect(capsule.verdict).toBe("ALLOW");
    expect(capsule.reasonCodes).toEqual(["POLICY_SATISFIED"]);
    expect(capsule.executionAuthority).toBe("none");
    expect(capsule.enforcementMode).toBe("shadow");
    expect(capsule.blockingEnabled).toBe(false);
    expect(capsule.authorizationEffect).toBe("advisory_record");
  });

  it("returns REQUIRE_EVIDENCE when no evidence bundle exists for a rule", () => {
    const capsule = evaluateChangeAuthorizationV1(baseInput({ evidenceBundles: [] }));
    expect(capsule.verdict).toBe("REQUIRE_EVIDENCE");
    expect(capsule.reasonCodes).toContain("REQUIRED_EVIDENCE_MISSING");
  });

  it("never lets ATTESTED evidence produce ALLOW for a CHANGE_REQUIREMENT rule (modality/claim-kind binding)", () => {
    expect(() => evaluateChangeAuthorizationV1(baseInput({
      assertions: [passingAssertionInput({ modality: "ATTESTED" })],
    }))).toThrow(ChangeAuthorizationEvaluationError);
  });

  it("treats a rule's own APPROXIMATED/UNKNOWN evidence submission as a violation, not mere insufficiency", () => {
    const capsule = evaluateChangeAuthorizationV1(baseInput({
      assertions: [passingAssertionInput({ modality: "UNKNOWN" })],
    }));
    expect(capsule.verdict).toBe("DENY");
    expect(capsule.reasonCodes).toContain("POLICY_RULE_VIOLATED");
  });

  it("forces DENY when the basis reconciliation is VIOLATED, regardless of satisfied rules", () => {
    const capsule = evaluateChangeAuthorizationV1(baseInput({ basisRecord: record("VIOLATED") }));
    expect(capsule.verdict).toBe("DENY");
    expect(capsule.reasonCodes).toContain("INVARIANT_VIOLATED");
  });

  it("ceilings at REQUIRE_EVIDENCE when the basis reconciliation is UNPROVEN, regardless of satisfied rules", () => {
    const capsule = evaluateChangeAuthorizationV1(baseInput({ basisRecord: record("UNPROVEN") }));
    expect(capsule.verdict).toBe("REQUIRE_EVIDENCE");
    expect(capsule.reasonCodes).toContain("OPEN_UNKNOWN");
  });

  it("is fail-closed: expiring or degrading evidence within the same evidence universe never raises the verdict rank", () => {
    const rank: Record<string, number> = { DENY: 0, REQUIRE_EVIDENCE: 1, ALLOW: 2 };
    const allow = evaluateChangeAuthorizationV1(baseInput());
    expect(rank[allow.verdict]).toBe(2);

    const expired = evaluateChangeAuthorizationV1(baseInput({
      assertions: [passingAssertionInput({ expiresAt: "2026-08-01T09:31:00.000Z" })],
    }));
    expect(rank[expired.verdict]).toBeLessThanOrEqual(rank[allow.verdict]!);

    const degraded = evaluateChangeAuthorizationV1(baseInput({
      providers: [provider({ status: "DEGRADED" })],
    }));
    expect(rank[degraded.verdict]).toBeLessThanOrEqual(rank[allow.verdict]!);

    const untrusted = evaluateChangeAuthorizationV1(baseInput({ trustedRootIds: [] }));
    expect(rank[untrusted.verdict]).toBeLessThanOrEqual(rank[allow.verdict]!);
  });

  it("throws a typed INVALID error for a malformed basis record, never DENY or REQUIRE_EVIDENCE", () => {
    let caught: unknown;
    try {
      evaluateChangeAuthorizationV1(baseInput({ basisRecord: { not: "a record" } as unknown as ControlHandoffRecordV2 }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChangeAuthorizationEvaluationError);
    expect((caught as ChangeAuthorizationEvaluationError).reason).toBe("BASIS_RECORD_INVALID");
  });

  it("rejects a schema-valid but JCS-hostile basis record through the typed INVALID channel", () => {
    const hostileSubjectRecord = record("REALIZED", "\ud800");
    const ordinaryRecord = record();
    const { capsuleHash: _capsuleHash, ...hostileCapsulePayload } = {
      ...ordinaryRecord.capsule,
      repositoryIdentity: "\ud800",
    };
    const hostileEmbeddedRecord: ControlHandoffRecordV2 = {
      ...ordinaryRecord,
      capsule: {
        ...hostileCapsulePayload,
        capsuleHash: controlModel.computeControlHandoffCapsuleV2Hash(hostileCapsulePayload),
      },
    };

    for (const hostileRecord of [hostileSubjectRecord, hostileEmbeddedRecord]) {
      expect(controlModel.ControlHandoffRecordV2Schema.safeParse(hostileRecord).success).toBe(true);
      let caught: unknown;
      try {
        evaluateChangeAuthorizationV1(baseInput({ basisRecord: hostileRecord }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ChangeAuthorizationEvaluationError);
      expect((caught as ChangeAuthorizationEvaluationError).reason).toBe("BASIS_RECORD_INVALID");
    }
  });

  it("keeps the typed INVALID channel closed for every top-level collection", () => {
    const hostileCases: readonly [unknown, ChangeAuthorizationEvaluationError["reason"]][] = [
      [{ providers: null }, "PROVIDER_INVALID"],
      [{ providers: [null] }, "PROVIDER_INVALID"],
      [{ claims: null }, "CLAIM_INVALID"],
      [{ claims: [null] }, "CLAIM_INVALID"],
      [{ policyRules: null }, "POLICY_RULE_INVALID"],
      [{ policyRules: [null] }, "POLICY_RULE_INVALID"],
      [{ assertions: null }, "ASSERTION_INVALID"],
      [{ evidenceBundles: null }, "EVIDENCE_BUNDLE_INVALID"],
      [{ trustedRootIds: null }, "EVALUATION_INPUT_INVALID"],
      [{ trustedRootIds: "root.tests" }, "EVALUATION_INPUT_INVALID"],
      [{ capsuleId: null }, "EVALUATION_INPUT_INVALID"],
      [{ capsuleId: "" }, "EVALUATION_INPUT_INVALID"],
      [{ evaluatedAt: null }, "EVALUATION_INPUT_INVALID"],
      [{ evaluatedAt: "not-a-timestamp" }, "EVALUATION_INPUT_INVALID"],
      [{ policyDescriptor: null }, "EVALUATION_INPUT_INVALID"],
      [{ policyDescriptor: { ...policyDescriptor(), policyUri: undefined } }, "EVALUATION_INPUT_INVALID"],
      [{ trustPolicyDescriptor: null }, "EVALUATION_INPUT_INVALID"],
      [{ trustPolicyDescriptor: { ...trustPolicyDescriptor(), trustPolicyId: () => "invalid" } }, "EVALUATION_INPUT_INVALID"],
      [{ capsuleId: "\ud800" }, "EVALUATION_INPUT_INVALID"],
      [{ policyDescriptor: { ...policyDescriptor(), policyId: "\ud800" } }, "EVALUATION_INPUT_INVALID"],
      [{ trustPolicyDescriptor: { ...trustPolicyDescriptor(), trustPolicyId: "\ud800" } }, "EVALUATION_INPUT_INVALID"],
      [{ trustedRootIds: ["\ud800"] }, "EVALUATION_INPUT_INVALID"],
      [{ providers: [provider({ providerId: "\ud800" })] }, "PROVIDER_INVALID"],
      [{ policyRules: [testsPassRule({ description: "\ud800" })] }, "POLICY_RULE_INVALID"],
    ];
    for (const [hostileOverride, expectedReason] of hostileCases) {
      let caught: unknown;
      try {
        evaluateChangeAuthorizationV1(baseInput(
          hostileOverride as Partial<ChangeAuthorizationEvaluationInputV1>,
        ));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ChangeAuthorizationEvaluationError);
      expect((caught as ChangeAuthorizationEvaluationError).reason).toBe(expectedReason);
    }
  });

  it("throws a typed INVALID error for an assertion scope that escapes the basis touched coordinates", () => {
    let caught: unknown;
    try {
      evaluateChangeAuthorizationV1(baseInput({
        assertions: [passingAssertionInput({
          scope: { schemaVersion: 1, coordinateIds: ["repo:file.other"] },
        })],
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChangeAuthorizationEvaluationError);
    expect((caught as ChangeAuthorizationEvaluationError).reason).toBe("ASSERTION_SCOPE_OUT_OF_BOUNDS");
  });

  it("throws a typed INVALID error for non-finite method parameters instead of corrupting the hash", () => {
    let caught: unknown;
    try {
      evaluateChangeAuthorizationV1(baseInput({
        assertions: [passingAssertionInput({ methodParameters: { budget: Number.NaN } })],
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChangeAuthorizationEvaluationError);
    expect((caught as ChangeAuthorizationEvaluationError).reason).toBe("ASSERTION_METHOD_PARAMETERS_UNSAFE");
  });

  it("throws the same typed INVALID error for undefined method parameters", () => {
    let caught: unknown;
    try {
      evaluateChangeAuthorizationV1(baseInput({
        assertions: [passingAssertionInput({ methodParameters: { budget: undefined } })],
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChangeAuthorizationEvaluationError);
    expect((caught as ChangeAuthorizationEvaluationError).reason).toBe("ASSERTION_METHOD_PARAMETERS_UNSAFE");
  });

  it("throws a typed INVALID error for a malformed assertion after hashing", () => {
    let caught: unknown;
    try {
      evaluateChangeAuthorizationV1(baseInput({
        assertions: [passingAssertionInput({ observedAt: "not-a-timestamp" })],
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChangeAuthorizationEvaluationError);
    expect((caught as ChangeAuthorizationEvaluationError).reason).toBe("ASSERTION_INVALID");
  });

  it("rejects missing, null, and wrongly typed assertion fields before dereference", () => {
    const hostileAssertions = [
      null,
      { ...passingAssertionInput(), scope: null },
      { ...passingAssertionInput(), dependsOnAssertionIds: null },
      { ...passingAssertionInput(), contradictsAssertionIds: "assertion.other" },
    ] as unknown as ChangeAuthorizationAssertionInputV1[];
    for (const hostileAssertion of hostileAssertions) {
      let caught: unknown;
      try {
        evaluateChangeAuthorizationV1(baseInput({ assertions: [hostileAssertion] }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ChangeAuthorizationEvaluationError);
      expect((caught as ChangeAuthorizationEvaluationError).reason).toBe("ASSERTION_INVALID");
    }
  });

  it("throws a typed INVALID error for an empty evidence bundle", () => {
    let caught: unknown;
    try {
      evaluateChangeAuthorizationV1(baseInput({
        evidenceBundles: [{ bundleId: "bundle.empty", ruleId: "rule.tests-pass", assertionIds: [] }],
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChangeAuthorizationEvaluationError);
    expect((caught as ChangeAuthorizationEvaluationError).reason).toBe("EVIDENCE_BUNDLE_INVALID");
  });

  it("rejects missing, null, and wrongly typed bundle fields before dereference", () => {
    const hostileBundles = [
      null,
      { bundleId: "bundle.invalid", ruleId: "rule.tests-pass" },
      { bundleId: "bundle.invalid", ruleId: "rule.tests-pass", assertionIds: null },
      { bundleId: "bundle.invalid", ruleId: "rule.tests-pass", assertionIds: "assertion.test-pass" },
    ] as unknown as ChangeAuthorizationEvaluationInputV1["evidenceBundles"];
    for (const hostileBundle of hostileBundles) {
      let caught: unknown;
      try {
        evaluateChangeAuthorizationV1(baseInput({ evidenceBundles: [hostileBundle] }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ChangeAuthorizationEvaluationError);
      expect((caught as ChangeAuthorizationEvaluationError).reason).toBe("EVIDENCE_BUNDLE_INVALID");
    }
  });

  it("throws a typed INVALID error for a duplicate logical bundle id across rules", () => {
    const secondClaimId = "claim.second";
    let caught: unknown;
    try {
      evaluateChangeAuthorizationV1(baseInput({
        claims: [
          testsPassClaimInput(),
          {
            claimId: secondClaimId,
            statement: "A second requirement is covered.",
            subject: { kind: "CHANGE_REQUIREMENT", requirementId: "requirement.second" },
          },
        ],
        assertions: [
          passingAssertionInput(),
          passingAssertionInput({ assertionId: "assertion.second", claimId: secondClaimId }),
        ],
        policyRules: [testsPassRule(), testsPassRule({ ruleId: "rule.second", requiredClaimId: secondClaimId })],
        evidenceBundles: [
          { bundleId: "bundle.duplicate", ruleId: "rule.tests-pass", assertionIds: ["assertion.test-pass"] },
          { bundleId: "bundle.duplicate", ruleId: "rule.second", assertionIds: ["assertion.second"] },
        ],
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChangeAuthorizationEvaluationError);
    expect((caught as ChangeAuthorizationEvaluationError).reason).toBe("EVIDENCE_BUNDLE_ID_DUPLICATE");
  });

  it("rejects non-JSON method parameter objects before they can collide in a hash", () => {
    for (const hostile of [new Date(0), new Map(), /x/, new Array(1)]) {
      let caught: unknown;
      try {
        evaluateChangeAuthorizationV1(baseInput({
          assertions: [passingAssertionInput({ methodParameters: { hostile } })],
        }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ChangeAuthorizationEvaluationError);
      expect((caught as ChangeAuthorizationEvaluationError).reason).toBe("ASSERTION_METHOD_PARAMETERS_UNSAFE");
    }
  });

  it("resolves assertion dependencies declared earlier in the same evaluation by caller-local id", () => {
    const capsule = evaluateChangeAuthorizationV1(baseInput({
      assertions: [
        passingAssertionInput({ assertionId: "assertion.base" }),
        passingAssertionInput({ assertionId: "assertion.test-pass", dependsOnAssertionIds: ["assertion.base"] }),
      ],
    }));
    const dependent = capsule.assertions.find((item) => item.assertionId === "assertion.test-pass")!;
    const base = capsule.assertions.find((item) => item.assertionId === "assertion.base")!;
    expect(dependent.dependsOnAssertionHashes).toEqual([base.assertionHash]);
  });

  it("throws a typed INVALID error for a dependency that is not declared earlier", () => {
    let caught: unknown;
    try {
      evaluateChangeAuthorizationV1(baseInput({
        assertions: [passingAssertionInput({ dependsOnAssertionIds: ["assertion.never-declared"] })],
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChangeAuthorizationEvaluationError);
    expect((caught as ChangeAuthorizationEvaluationError).reason).toBe("ASSERTION_DEPENDENCY_UNRESOLVED");
  });

  // --- HOK-89 rework: hostile regressions for the six reported findings ---

  describe("finding: unrelated or negative assertions can never produce ALLOW", () => {
    it("never lets an assertion addressing an unrelated claim contribute (foreign claim)", () => {
      const capsule = evaluateChangeAuthorizationV1(baseInput({
        claims: [
          testsPassClaimInput(),
          { claimId: "claim.unrelated", statement: "an unrelated requirement.", subject: { kind: "CHANGE_REQUIREMENT", requirementId: "requirement.unrelated" } },
        ],
        assertions: [passingAssertionInput({ claimId: "claim.unrelated" })],
      }));
      expect(capsule.verdict).not.toBe("ALLOW");
      expect(capsule.reasonCodes).toContain("REQUIRED_CLAIM_UNBOUND");
    });

    it("forces DENY when an assertion CONTRADICTS the rule's required claim", () => {
      const capsule = evaluateChangeAuthorizationV1(baseInput({
        assertions: [passingAssertionInput({ conclusion: "CONTRADICTS" })],
      }));
      expect(capsule.verdict).toBe("DENY");
      expect(capsule.reasonCodes).toContain("REQUIRED_CLAIM_CONTRADICTED");
    });

    it("never lets an INCONCLUSIVE assertion on the correct claim contribute", () => {
      const capsule = evaluateChangeAuthorizationV1(baseInput({
        assertions: [passingAssertionInput({ conclusion: "INCONCLUSIVE" })],
      }));
      expect(capsule.verdict).not.toBe("ALLOW");
      expect(capsule.reasonCodes).toContain("REQUIRED_CLAIM_INCONCLUSIVE");
    });

    it("rejects at construction time an ATTESTED assertion addressing a CHANGE_REQUIREMENT claim (modality/claim-kind binding)", () => {
      let caught: unknown;
      try {
        evaluateChangeAuthorizationV1(baseInput({ assertions: [passingAssertionInput({ modality: "ATTESTED" })] }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ChangeAuthorizationEvaluationError);
      expect((caught as ChangeAuthorizationEvaluationError).reason).toBe("ASSERTION_CLAIM_MODALITY_MISMATCH");
    });
  });

  describe("finding: monotonicity is bounded to a single evidence universe", () => {
    it("refuses to compare two capsules whose evidence universe differs (poison removal is not a monotonicity claim)", () => {
      const poison = passingAssertionInput({ assertionId: "assertion.poison", conclusion: "CONTRADICTS" });
      const withPoison = evaluateChangeAuthorizationV1(baseInput({
        assertions: [passingAssertionInput(), poison],
        evidenceBundles: [{ bundleId: "bundle.rule-tests-pass", ruleId: "rule.tests-pass", assertionIds: ["assertion.test-pass", "assertion.poison"] }],
      }));
      const withoutPoison = evaluateChangeAuthorizationV1(baseInput());
      expect(withPoison.verdict).toBe("DENY");
      expect(withoutPoison.verdict).toBe("ALLOW");

      const comparison = compareChangeAuthorizationMonotonicityV1(withPoison, withoutPoison);
      expect(comparison.result).toBe("INVALID");
      expect(comparison.reasons).toContain("EVIDENCE_UNIVERSE_MISMATCH");
    });

    it("is VALID for a same-universe downgrade (provider degrades, evidence set unchanged)", () => {
      const allow = evaluateChangeAuthorizationV1(baseInput());
      const degraded = evaluateChangeAuthorizationV1(baseInput({ providers: [provider({ status: "DEGRADED" })] }));
      expect(allow.evidenceUniverse.universeHash).toBe(degraded.evidenceUniverse.universeHash);

      const comparison = compareChangeAuthorizationMonotonicityV1(allow, degraded);
      expect(comparison.result).toBe("VALID");
    });

    it("is INVALID with VERDICT_RANK_INCREASED if a same-universe pair somehow raises the rank", () => {
      const allow = evaluateChangeAuthorizationV1(baseInput());
      const forcedHigherRank = { ...allow, verdict: "ALLOW" as const };
      const forcedLowerPrevious: ChangeAuthorizationCapsuleV1 = { ...allow, verdict: "DENY" as const };
      const comparison = compareChangeAuthorizationMonotonicityV1(forcedLowerPrevious, forcedHigherRank);
      expect(comparison.result).toBe("INVALID");
      expect(comparison.reasons).toContain("VERDICT_RANK_INCREASED");
    });
  });

  describe("finding: replay re-derives the verdict instead of trusting safeParse alone", () => {
    it("is VALID for a genuinely evaluated capsule against its own authority descriptor digest", () => {
      const capsule = evaluateChangeAuthorizationV1(baseInput());
      const report = replayChangeAuthorizationV1(capsule, {
        expectedAuthorityDescriptorDigest: capsule.authorityDescriptor.descriptorDigest,
      });
      expect(report.result).toBe("VALID");
    });

    it("rejects a resealed capsule whose stored artifacts are not canonical", () => {
      const artifactA: EvidenceRefV1 = {
        schemaVersion: 1,
        kind: "test_result",
        locator: "artifact.a",
        digest: { algorithm: "sha256", value: "a".repeat(64) },
      };
      const artifactB: EvidenceRefV1 = {
        schemaVersion: 1,
        kind: "test_result",
        locator: "artifact.b",
        digest: { algorithm: "sha256", value: "b".repeat(64) },
      };
      const capsule = evaluateChangeAuthorizationV1(baseInput({
        assertions: [passingAssertionInput({ artifacts: [artifactA, artifactB] })],
      }));
      const reversedAssertion = {
        ...capsule.assertions[0]!,
        artifacts: [artifactB, artifactA],
      };
      const payload = { ...capsule, assertions: [reversedAssertion], capsuleHash: undefined };
      const { capsuleHash: _ignored, ...withoutHash } = payload;
      const resealed = {
        ...withoutHash,
        capsuleHash: controlModel.computeChangeAuthorizationCapsuleV1Hash(withoutHash),
      } as ChangeAuthorizationCapsuleV1;

      expect(resealed.capsuleHash).toBe(capsule.capsuleHash);
      expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(resealed).success).toBe(false);
      expect(replayChangeAuthorizationV1(resealed, {
        expectedAuthorityDescriptorDigest: resealed.authorityDescriptor.descriptorDigest,
      }).result).toBe("INVALID");
    });

    it("catches a hand-forged capsule that claims a DEGRADED-provider assertion as satisfied, even though every hash is internally self-consistent", () => {
      const allow = evaluateChangeAuthorizationV1(baseInput());
      const degradedProvider = provider({ status: "DEGRADED" });
      const forgedEvaluation = {
        schemaVersion: 1 as const,
        ruleId: allow.policyEvaluations[0]!.ruleId,
        outcome: "satisfied" as const,
        reasonCodes: ["POLICY_SATISFIED"] as const,
        contributingAssertionHashes: allow.assertions.map((assertion) => assertion.assertionHash),
      };
      const forgedEvaluationHash = controlModel.computeChangeAuthorizationPolicyEvaluationV1Hash(forgedEvaluation);
      const forged: ChangeAuthorizationCapsuleV1 = {
        ...allow,
        providers: [degradedProvider],
        policyEvaluations: [{ ...forgedEvaluation, evaluationHash: forgedEvaluationHash }],
      };
      const capsuleHash = controlModel.computeChangeAuthorizationCapsuleV1Hash(forged);
      const resealed: ChangeAuthorizationCapsuleV1 = { ...forged, capsuleHash };

      // The forged capsule is internally self-consistent: every hash matches its own recomputed
      // content, so schema-level safeParse alone cannot distinguish it from a genuine ALLOW.
      expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(resealed).success).toBe(true);
      expect(resealed.verdict).toBe("ALLOW");

      const report = replayChangeAuthorizationV1(resealed, {
        expectedAuthorityDescriptorDigest: resealed.authorityDescriptor.descriptorDigest,
      });
      expect(report.result).toBe("INVALID");
      expect(report.reasons).toContain("POLICY_EVALUATION_REDERIVATION_MISMATCH");
    });

    it("rejects a capsule whose authority descriptor does not match an externally pinned expected digest, even though every internal hash recomputes correctly", () => {
      const capsule = evaluateChangeAuthorizationV1(baseInput());
      const report = replayChangeAuthorizationV1(capsule, {
        expectedAuthorityDescriptorDigest: `sha256:${"9".repeat(64)}` as const,
      });
      expect(report.result).toBe("INVALID");
      expect(report.reasons).toContain("AUTHORITY_DESCRIPTOR_MISMATCH");
    });

    it("is INVALID for a capsule that fails schema validation", () => {
      const capsule = evaluateChangeAuthorizationV1(baseInput());
      const corrupted = { ...capsule, capsuleHash: `sha256:${"9".repeat(64)}` as const };
      const report = replayChangeAuthorizationV1(corrupted, {
        expectedAuthorityDescriptorDigest: capsule.authorityDescriptor.descriptorDigest,
      });
      expect(report.result).toBe("INVALID");
      expect(report.reasons).toEqual(["CAPSULE_SCHEMA_INVALID"]);
    });

    it("returns CAPSULE_SCHEMA_INVALID instead of throwing for non-canonicalizable assertion content", () => {
      for (const hostile of [Number.NaN, "\uD800"] as const) {
        const capsule = structuredClone(evaluateChangeAuthorizationV1(baseInput()));
        capsule.assertions[0]!.methodParameters = { hostile };
        let report: ReturnType<typeof replayChangeAuthorizationV1> | undefined;
        expect(() => {
          report = replayChangeAuthorizationV1(capsule, {
            expectedAuthorityDescriptorDigest: capsule.authorityDescriptor.descriptorDigest,
          });
        }).not.toThrow();
        expect(report).toEqual({ result: "INVALID", reasons: ["CAPSULE_SCHEMA_INVALID"] });
      }
    });
  });
});

describe("projectChangeAuthorizationSubjectV1", () => {
  it("projects a deterministic subject bound to the basis record", () => {
    const recordValue = record("REALIZED");
    const subject = projectChangeAuthorizationSubjectV1(recordValue);
    expect(subject.changeId).toBe(recordValue.request.planningBundle.taskEnvelope.changeId);
    expect(subject.observedCommit).toBe(recordValue.capsule.observedCommit);
    expect(controlModel.ChangeAuthorizationSubjectV1Schema.safeParse(subject).success).toBe(true);
    expect(projectChangeAuthorizationSubjectV1(record("REALIZED")).subjectHash).toBe(subject.subjectHash);
  });
});
