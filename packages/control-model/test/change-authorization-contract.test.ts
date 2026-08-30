import { describe, expect, it } from "bun:test";
import * as controlModel from "@semantic-context/control-model";
import * as changeAuthorization from "@semantic-context/control-model/change-authorization";
import type {
  ChangeAuthorizationAssertionV1,
  ChangeAuthorizationAuthorityDescriptorV1,
  ChangeAuthorizationCapsuleV1,
  ChangeAuthorizationClaimV1,
  ChangeAuthorizationEvidenceBundleV1,
  ChangeAuthorizationEvidenceUniverseV1,
  ChangeAuthorizationPolicyDescriptorV1,
  ChangeAuthorizationPolicyEvaluationV1,
  ChangeAuthorizationPolicyRuleV1,
  ChangeAuthorizationProviderV1,
  ChangeAuthorizationSubjectV1,
  ChangeAuthorizationTrustPolicyDescriptorV1,
  ControlHandoffRecordV2,
  PlanningBundleV1,
  Sha256Hash,
  SemanticChangeSetV1,
  TaskEnvelopeV1,
  TaskFrameSnapshotV1,
} from "@semantic-context/control-model";

const hashA = `sha256:${"a".repeat(64)}` as const;
const hashB = `sha256:${"b".repeat(64)}` as const;
const hashC = `sha256:${"c".repeat(64)}` as const;
const hashD = `sha256:${"d".repeat(64)}` as const;

function taskFrame(): TaskFrameSnapshotV1 {
  return {
    schemaVersion: 1,
    taskFrameId: "task.authorization",
    rawTaskDigest: hashA,
    mode: "feature",
    createdAt: "2026-08-01T10:00:00.000Z",
    capabilitySignals: ["authorization"],
    riskSignals: ["control_plane"],
    profileCandidate: "feature",
    altitudeCandidate: 3,
  };
}

function envelope(): TaskEnvelopeV1 {
  const snapshot = taskFrame();
  const input: Omit<TaskEnvelopeV1, "envelopeHash"> = {
    schemaVersion: 1,
    kind: "task_envelope",
    executionAuthority: "none",
    envelopeId: "envelope.authorization",
    planningCommit: "abc123",
    taskFrameSnapshot: snapshot,
    taskFrameHash: controlModel.computeTaskFrameSnapshotV1Hash(snapshot),
    changeId: "change.authorization",
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

function changeSet(): SemanticChangeSetV1 {
  const taskEnvelope = envelope();
  const input: Omit<SemanticChangeSetV1, "changeSetHash"> = {
    schemaVersion: 1,
    kind: "semantic_change_set",
    executionAuthority: "none",
    changeSetId: "changeset.authorization",
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

function planningBundle(): PlanningBundleV1 {
  const taskEnvelope = envelope();
  const semanticChangeSet = changeSet();
  const input: Omit<PlanningBundleV1, "bundleHash"> = {
    schemaVersion: 1,
    kind: "planning_bundle",
    executionAuthority: "none",
    bundleId: "bundle.authorization",
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

function record(terminalStatus: "REALIZED" | "VIOLATED" | "UNPROVEN" = "REALIZED"): ControlHandoffRecordV2 {
  const bundleValue = planningBundle();
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

function claim(recordValue: ControlHandoffRecordV2, overrides: Partial<Omit<ChangeAuthorizationClaimV1, "claimHash">> = {}): ChangeAuthorizationClaimV1 {
  const input: Omit<ChangeAuthorizationClaimV1, "claimHash"> = {
    schemaVersion: 1,
    claimId: "claim.tests-pass",
    statement: "The candidate diff is covered by a passing test observation.",
    subject: {
      kind: "CHANGE_REQUIREMENT",
      changeId: recordValue.request.planningBundle.taskEnvelope.changeId,
      requirementId: "requirement.tests-pass",
    },
    ...overrides,
  };
  return { ...input, claimHash: controlModel.computeChangeAuthorizationClaimV1Hash(input) };
}

function assertion(
  claimValue: ChangeAuthorizationClaimV1,
  overrides: Partial<Omit<ChangeAuthorizationAssertionV1, "assertionHash">> = {},
): ChangeAuthorizationAssertionV1 {
  const input: Omit<ChangeAuthorizationAssertionV1, "assertionHash"> = {
    schemaVersion: 1,
    assertionId: "assertion.test-pass",
    claimHash: claimValue.claimHash,
    conclusion: "SUPPORTS",
    modality: "TEST_OBSERVED",
    producerId: "producer.bun-test",
    producerVersion: "1.2.3",
    sourceCommit: "def456",
    sourceDiffHash: hashB,
    methodName: "bun test",
    methodParameters: { pattern: "packages/**/*.test.ts" },
    scope: { schemaVersion: 1, coordinateIds: ["repo:file.src-x"] },
    observedAt: "2026-08-01T09:30:00.000Z",
    expiresAt: "2026-09-01T09:30:00.000Z",
    providerId: "provider.tests",
    artifacts: [],
    dependsOnAssertionHashes: [],
    contradicts: [],
    ...overrides,
  };
  return { ...input, assertionHash: controlModel.computeChangeAuthorizationAssertionV1Hash(input) };
}

function bundleForRule(
  ruleId: string,
  assertions: readonly ChangeAuthorizationAssertionV1[],
  bundleId = `bundle.${ruleId}`,
): ChangeAuthorizationEvidenceBundleV1 {
  const input = {
    schemaVersion: 1 as const,
    bundleId,
    ruleId,
    assertionHashes: assertions.map((item) => item.assertionHash),
  };
  return { ...input, bundleHash: controlModel.computeChangeAuthorizationEvidenceBundleV1Hash(input) };
}

function evidenceUniverse(
  assertions: readonly ChangeAuthorizationAssertionV1[],
  bundles: readonly ChangeAuthorizationEvidenceBundleV1[],
): ChangeAuthorizationEvidenceUniverseV1 {
  const input = {
    schemaVersion: 1 as const,
    assertionHashes: [...new Set(assertions.map((item) => item.assertionHash))].sort(controlModel.compareCodeUnits),
    bundleHashes: [...new Set(bundles.map((item) => item.bundleHash))].sort(controlModel.compareCodeUnits),
  };
  return { ...input, universeHash: controlModel.computeChangeAuthorizationEvidenceUniverseV1Hash(input) };
}

function policyDescriptor(): ChangeAuthorizationPolicyDescriptorV1 {
  return {
    schemaVersion: 1,
    policyId: "policy.authorization-tests",
    policyVersion: "1.0.0",
    policyUri: "https://semctx.test/policy/authorization-tests",
  };
}

function trustPolicyDescriptor(): ChangeAuthorizationTrustPolicyDescriptorV1 {
  return {
    schemaVersion: 1,
    trustPolicyId: "trust-policy.authorization-tests",
    trustPolicyVersion: "1.0.0",
  };
}

function authorityDescriptor(
  rules: readonly ChangeAuthorizationPolicyRuleV1[],
  trustRootIds: readonly string[] = ["root.tests"],
): ChangeAuthorizationAuthorityDescriptorV1 {
  const sortedTrustRootIds = [...new Set(trustRootIds)].sort(controlModel.compareCodeUnits);
  const input = {
    schemaVersion: 1 as const,
    policy: policyDescriptor(),
    policyRulesHash: controlModel.computeChangeAuthorizationPolicyRuleSetV1Hash(rules),
    trustPolicy: trustPolicyDescriptor(),
    trustRootIds: sortedTrustRootIds,
    trustedRootSetHash: controlModel.computeChangeAuthorizationTrustRootSetV1Hash(sortedTrustRootIds),
  };
  return { ...input, descriptorDigest: controlModel.computeChangeAuthorizationAuthorityDescriptorV1Hash(input) };
}

function policyRule(
  requiredClaimHash: Sha256Hash,
  overrides: Partial<ChangeAuthorizationPolicyRuleV1> = {},
): ChangeAuthorizationPolicyRuleV1 {
  return {
    schemaVersion: 1,
    ruleId: "rule.tests-pass",
    description: "The candidate diff must be covered by a passing test observation.",
    requiredClaimHash,
    allowedModalities: ["FORMALLY_PROVED", "RUNTIME_OBSERVED", "STATICALLY_VERIFIED", "TEST_OBSERVED"],
    ...overrides,
  };
}

function policyEvaluation(
  rule: ChangeAuthorizationPolicyRuleV1,
  contributingAssertionHashes: readonly Sha256Hash[] = [],
): ChangeAuthorizationPolicyEvaluationV1 {
  const satisfied = contributingAssertionHashes.length > 0;
  const outcome: ChangeAuthorizationPolicyEvaluationV1["outcome"] = satisfied ? "satisfied" : "insufficient";
  const reasonCodes: ChangeAuthorizationPolicyEvaluationV1["reasonCodes"] = satisfied
    ? ["POLICY_SATISFIED"]
    : ["REQUIRED_EVIDENCE_MISSING"];
  const input = {
    schemaVersion: 1 as const,
    ruleId: rule.ruleId,
    outcome,
    reasonCodes,
    contributingAssertionHashes,
  };
  return { ...input, evaluationHash: controlModel.computeChangeAuthorizationPolicyEvaluationV1Hash(input) };
}

function subject(recordValue: ControlHandoffRecordV2): ChangeAuthorizationSubjectV1 {
  const taskEnvelope = recordValue.request.planningBundle.taskEnvelope;
  const capsule = recordValue.capsule;
  const input: Omit<ChangeAuthorizationSubjectV1, "subjectHash"> = {
    schemaVersion: 1,
    changeId: taskEnvelope.changeId,
    changeContractHash: taskEnvelope.changeContractHash,
    parentIntentIds: taskEnvelope.parentIntentIds,
    nonGoals: taskEnvelope.nonGoals,
    expectedBehaviorDelta: taskEnvelope.expectedBehaviorDelta,
    declaredReconciliationScope: taskEnvelope.declaredReconciliationScope,
    planningCommit: taskEnvelope.planningCommit,
    observedCommit: capsule.observedCommit,
    observedWorkingDiffHash: capsule.observedWorkingDiffHash,
    touchedCoordinateIds: capsule.touchedCoordinateIds,
    reconciliationTerminalStatus: capsule.reconciliationTerminalStatus,
    reconciliationReasonCodes: capsule.reconciliationReasonCodes,
  };
  return { ...input, subjectHash: controlModel.computeChangeAuthorizationSubjectV1Hash(input) };
}

function capsuleV1(
  recordValue: ControlHandoffRecordV2,
  claims: readonly ChangeAuthorizationClaimV1[],
  assertions: readonly ChangeAuthorizationAssertionV1[],
  rules: readonly ChangeAuthorizationPolicyRuleV1[],
  evaluations: readonly ChangeAuthorizationPolicyEvaluationV1[],
  bundles: readonly ChangeAuthorizationEvidenceBundleV1[],
  providers: readonly ChangeAuthorizationProviderV1[],
): ChangeAuthorizationCapsuleV1 {
  const ranks: Record<string, number> = { violated: 0, insufficient: 1, satisfied: 2 };
  const ruleRank = Math.min(...evaluations.map((item) => ranks[item.outcome]!));
  const basisCeiling = recordValue.capsule.reconciliationTerminalStatus === "VIOLATED"
    ? 0
    : recordValue.capsule.reconciliationTerminalStatus === "UNPROVEN"
      ? 1
      : 2;
  const rank = Math.min(ruleRank, basisCeiling);
  const verdict = rank === 0 ? "DENY" as const : rank === 1 ? "REQUIRE_EVIDENCE" as const : "ALLOW" as const;
  const reasons = new Set<string>();
  for (const evaluation of evaluations) {
    if (evaluation.outcome !== "satisfied") for (const reason of evaluation.reasonCodes) reasons.add(reason);
  }
  if (recordValue.capsule.reconciliationTerminalStatus !== "REALIZED") reasons.add("OPEN_UNKNOWN");
  if (recordValue.capsule.reconciliationTerminalStatus === "VIOLATED") reasons.add("INVARIANT_VIOLATED");
  if (reasons.size === 0) reasons.add("POLICY_SATISFIED");
  const order = changeAuthorization.CHANGE_AUTHORIZATION_REASON_ORDER;
  const reasonCodes = [...reasons].sort((left, right) => order.indexOf(left as never) - order.indexOf(right as never));
  const input = {
    schemaVersion: 1 as const,
    kind: "change_authorization_capsule" as const,
    executionAuthority: "none" as const,
    enforcementMode: "shadow" as const,
    blockingEnabled: false as const,
    authorizationEffect: "advisory_record" as const,
    capsuleId: "capsule.authorization-test",
    basis: { record: recordValue },
    subject: subject(recordValue),
    providers,
    claims,
    assertions,
    evidenceBundles: bundles,
    evidenceUniverse: evidenceUniverse(assertions, bundles),
    policyRules: rules,
    policyEvaluations: evaluations,
    authorityDescriptor: authorityDescriptor(rules),
    verdict,
    reasonCodes: reasonCodes as ChangeAuthorizationCapsuleV1["reasonCodes"],
    evaluatedAt: "2026-08-01T10:00:00.000Z",
  };
  return { ...input, capsuleHash: controlModel.computeChangeAuthorizationCapsuleV1Hash(input) };
}

function validCapsule(): ChangeAuthorizationCapsuleV1 {
  const recordValue = record("REALIZED");
  const claimValue = claim(recordValue);
  const rule = policyRule(claimValue.claimHash);
  const passingAssertion = assertion(claimValue);
  const bundle = bundleForRule(rule.ruleId, [passingAssertion]);
  const evaluation = policyEvaluation(rule, [passingAssertion.assertionHash]);
  return capsuleV1(
    recordValue,
    [claimValue],
    [passingAssertion],
    [rule],
    [evaluation],
    [bundle],
    [provider()],
  );
}

describe("RFC 8785 (JCS) canonicalization", () => {
  it("sorts object keys and preserves array order", () => {
    const serialized = changeAuthorization.serializeChangeAuthorizationJcsV1({ b: 1, a: 2, c: [3, 1, 2] });
    expect(serialized).toBe(`{"a":2,"b":1,"c":[3,1,2]}`);
  });

  it("sorts integer-like object keys by UTF-16 code units instead of ECMAScript index order", () => {
    expect(changeAuthorization.serializeChangeAuthorizationJcsV1({ 2: "two", 10: "ten" }))
      .toBe('{"10":"ten","2":"two"}');
    expect(changeAuthorization.serializeChangeAuthorizationJcsV1({ 10: "ten", 2: "two" }))
      .toBe('{"10":"ten","2":"two"}');
    expect(changeAuthorization.changeAuthorizationDomainHashV1("numeric-keys\0", { 2: "two", 10: "ten" }))
      .toBe(changeAuthorization.changeAuthorizationDomainHashV1("numeric-keys\0", { 10: "ten", 2: "two" }));
  });

  it("normalizes negative zero to 0", () => {
    expect(changeAuthorization.serializeChangeAuthorizationJcsV1({ value: -0 })).toBe(`{"value":0}`);
  });

  it("rejects non-finite numbers", () => {
    expect(changeAuthorization.isChangeAuthorizationJcsSafeV1({ value: Number.NaN })).toBe(false);
    expect(changeAuthorization.isChangeAuthorizationJcsSafeV1({ value: Number.POSITIVE_INFINITY })).toBe(false);
    expect(() => changeAuthorization.serializeChangeAuthorizationJcsV1({ value: Number.NaN })).toThrow();
  });

  it("rejects undefined instead of silently dropping hash input", () => {
    expect(changeAuthorization.isChangeAuthorizationJcsSafeV1({ a: 1, b: undefined })).toBe(false);
    expect(() => changeAuthorization.serializeChangeAuthorizationJcsV1({ a: 1, b: undefined })).toThrow();
  });

  it("rejects non-JSON objects, sparse arrays, symbols, accessors, and hidden properties", () => {
    const sparse = new Array(1);
    const symbolValue = { a: 1, [Symbol("hidden")]: 2 };
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
    const hidden = Object.defineProperty({}, "value", { enumerable: false, value: 1 });
    for (const hostile of [new Date(0), new Map(), /x/, sparse, symbolValue, accessor, hidden]) {
      expect(changeAuthorization.isChangeAuthorizationJcsSafeV1(hostile)).toBe(false);
      expect(() => changeAuthorization.serializeChangeAuthorizationJcsV1(hostile)).toThrow();
    }
  });

  it("is stable across a duplicate-key JSON text boundary (last key wins, as JSON.parse does)", () => {
    const parsed = JSON.parse(`{"x":1,"x":2}`) as Record<string, unknown>;
    expect(changeAuthorization.serializeChangeAuthorizationJcsV1(parsed)).toBe(`{"x":2}`);
  });

  it("does not perform Unicode normalization: distinct code-point sequences remain distinct", () => {
    const nfc = "é";
    const nfd = "e\u0301";
    expect(nfc).not.toBe(nfd);
    expect(changeAuthorization.serializeChangeAuthorizationJcsV1({ v: nfc }))
      .not.toBe(changeAuthorization.serializeChangeAuthorizationJcsV1({ v: nfd }));
  });

  it("produces the same domain hash regardless of key insertion order", () => {
    const left = changeAuthorization.changeAuthorizationDomainHashV1("DOMAIN\0", { a: 1, b: 2 });
    const right = changeAuthorization.changeAuthorizationDomainHashV1("DOMAIN\0", { b: 2, a: 1 });
    expect(left).toBe(right);
  });

  it("rejects a lone (unpaired) high surrogate in a property value", () => {
    const lone = "prefix-\uD800-suffix";
    expect(changeAuthorization.isChangeAuthorizationJcsSafeV1({ v: lone })).toBe(false);
    expect(() => changeAuthorization.serializeChangeAuthorizationJcsV1({ v: lone })).toThrow();
  });

  it("rejects a lone (unpaired) low surrogate in a property value", () => {
    const lone = "prefix-\uDC00-suffix";
    expect(changeAuthorization.isChangeAuthorizationJcsSafeV1({ v: lone })).toBe(false);
    expect(() => changeAuthorization.serializeChangeAuthorizationJcsV1({ v: lone })).toThrow();
  });

  it("rejects a lone surrogate in a property name", () => {
    const value: Record<string, unknown> = {};
    value["key-\uD800-lone"] = 1;
    expect(changeAuthorization.isChangeAuthorizationJcsSafeV1(value)).toBe(false);
    expect(() => changeAuthorization.serializeChangeAuthorizationJcsV1(value)).toThrow();
  });

  it("preserves a valid surrogate pair (a real astral character)", () => {
    const paired = "prefix-🐎-suffix"; // U+1F40E HORSE, a legitimate surrogate pair
    expect(changeAuthorization.isChangeAuthorizationJcsSafeV1({ v: paired })).toBe(true);
    expect(changeAuthorization.serializeChangeAuthorizationJcsV1({ v: paired })).toBe(JSON.stringify({ v: paired }));
  });

  it("matches the frozen golden vector for every hash domain", () => {
    const payload = { a: 1 };
    const vectors = [
      ["SEMCTX_CHANGE_AUTHORIZATION_SUBJECT_V1\0", "sha256:94b10fea0a45afdd6bf479d49a351c23ced093e3d52c9e05a7e80721353e2cec"],
      ["SEMCTX_CHANGE_AUTHORIZATION_EVIDENCE_V1\0", "sha256:fb09e28011772551e02972e1db229662faee59fdf3c5f99cf3339094cc5e8aed"],
      ["SEMCTX_CHANGE_AUTHORIZATION_EVIDENCE_BUNDLE_V1\0", "sha256:a0b585d01c4e45960e45ed58482fbdf59ea424e926dffc881fcb0237392f66d2"],
      ["SEMCTX_CHANGE_AUTHORIZATION_POLICY_EVALUATION_V1\0", "sha256:7311629e0737e59f9fc42882a7a76388fe0a26a7cb631352bbf6de00f076e13b"],
      ["SEMCTX_CHANGE_AUTHORIZATION_CAPSULE_V1\0", "sha256:e352be93803acafe2d8512227b88ef03affde13503c00c5531483af6d025258a"],
      ["SEMCTX_CHANGE_AUTHORIZATION_CLAIM_V1\0", "sha256:3307f386ba417ca47b651a1049f19ee466a755404e1615975f3cec506d922b02"],
      ["SEMCTX_CHANGE_AUTHORIZATION_POLICY_RULE_SET_V1\0", "sha256:829fbc41a40c96358b6dc1865b190843bcc499e1fccc6174b1c7013c50e8f9dd"],
      ["SEMCTX_CHANGE_AUTHORIZATION_TRUST_ROOT_SET_V1\0", "sha256:e4cd1670a3dec75cd094d10819e815d584b1d6349a5f700717c8149f65b51f16"],
      ["SEMCTX_CHANGE_AUTHORIZATION_AUTHORITY_DESCRIPTOR_V1\0", "sha256:97ecd26c987bc1d5d7d0b5b2f36e70c5e6ab699440492809844e36588553cdeb"],
      ["SEMCTX_CHANGE_AUTHORIZATION_EVIDENCE_UNIVERSE_V1\0", "sha256:4a735cc8d3bafe7b70648adea0f1b857e8df12160f0df28e2ef3e7b77c541b28"],
    ] as const;
    for (const [domain, expectedHash] of vectors) {
      expect(changeAuthorization.changeAuthorizationDomainHashV1(domain, payload)).toBe(expectedHash);
    }
  });
});

describe("ChangeAuthorizationCapsuleV1", () => {
  it("accepts a well-formed capsule and rejects a hash-mismatched one", () => {
    const capsule = validCapsule();
    expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(capsule).success).toBe(true);
    expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse({
      ...capsule,
      capsuleHash: hashD,
    }).success).toBe(false);
  });

  it("rejects non-canonical stored assertion artifacts even when every hash recomputes", () => {
    const capsule = validCapsule();
    const artifactA = {
      schemaVersion: 1 as const,
      kind: "test_result" as const,
      locator: "artifact.a",
      digest: { algorithm: "sha256" as const, value: "a".repeat(64) },
    };
    const artifactB = {
      schemaVersion: 1 as const,
      kind: "test_result" as const,
      locator: "artifact.b",
      digest: { algorithm: "sha256" as const, value: "b".repeat(64) },
    };
    const canonicalAssertion = assertion(capsule.claims[0]!, { artifacts: [artifactA, artifactB] });
    const reversedAssertion = { ...canonicalAssertion, artifacts: [artifactB, artifactA] };
    const bundle = bundleForRule(capsule.policyRules[0]!.ruleId, [canonicalAssertion]);
    const evaluation = policyEvaluation(capsule.policyRules[0]!, [canonicalAssertion.assertionHash]);
    const forged = capsuleV1(
      capsule.basis.record,
      capsule.claims,
      [reversedAssertion],
      capsule.policyRules,
      [evaluation],
      [bundle],
      capsule.providers,
    );

    expect(reversedAssertion.assertionHash).toBe(canonicalAssertion.assertionHash);
    expect(forged.capsuleHash).toBe(capsuleV1(
      capsule.basis.record,
      capsule.claims,
      [canonicalAssertion],
      capsule.policyRules,
      [evaluation],
      [bundle],
      capsule.providers,
    ).capsuleHash);
    expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(forged).success).toBe(false);
  });

  it("rejects duplicate logical claim ids even when content hashes differ", () => {
    const recordValue = record("REALIZED");
    const first = claim(recordValue);
    const duplicate = claim(recordValue, { statement: "Different content under the same logical id." });
    const rule = policyRule(first.claimHash);
    const passing = assertion(first);
    const bundle = bundleForRule(rule.ruleId, [passing]);
    const evaluation = policyEvaluation(rule, [passing.assertionHash]);
    const claims = [first, duplicate].sort((left, right) => controlModel.compareCodeUnits(left.claimHash, right.claimHash));
    const forged = capsuleV1(recordValue, claims, [passing], [rule], [evaluation], [bundle], [provider()]);
    expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(forged).success).toBe(false);
  });

  it("rejects duplicate logical assertion ids even when content hashes differ", () => {
    const recordValue = record("REALIZED");
    const claimValue = claim(recordValue);
    const first = assertion(claimValue);
    const duplicate = assertion(claimValue, { conclusion: "CONTRADICTS" });
    const rule = policyRule(claimValue.claimHash);
    const assertions = [first, duplicate].sort((left, right) => controlModel.compareCodeUnits(left.assertionHash, right.assertionHash));
    const bundle = bundleForRule(rule.ruleId, assertions);
    const evaluation = policyEvaluation(rule, [first.assertionHash]);
    const forged = capsuleV1(recordValue, [claimValue], assertions, [rule], [evaluation], [bundle], [provider()]);
    expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(forged).success).toBe(false);
  });

  it("rejects duplicate logical bundle ids even when bundle hashes differ", () => {
    const recordValue = record("REALIZED");
    const firstClaim = claim(recordValue);
    const secondClaim = claim(recordValue, {
      claimId: "claim.second",
      subject: {
        kind: "CHANGE_REQUIREMENT",
        changeId: recordValue.request.planningBundle.taskEnvelope.changeId,
        requirementId: "requirement.second",
      },
    });
    const firstRule = policyRule(firstClaim.claimHash);
    const secondRule = policyRule(secondClaim.claimHash, { ruleId: "rule.second" });
    const firstAssertion = assertion(firstClaim);
    const secondAssertion = assertion(secondClaim, { assertionId: "assertion.second" });
    const duplicateBundleId = "bundle.duplicate";
    const firstBundle = bundleForRule(firstRule.ruleId, [firstAssertion], duplicateBundleId);
    const secondBundle = bundleForRule(secondRule.ruleId, [secondAssertion], duplicateBundleId);
    const claims = [firstClaim, secondClaim].sort((left, right) => controlModel.compareCodeUnits(left.claimHash, right.claimHash));
    const assertions = [firstAssertion, secondAssertion].sort((left, right) => controlModel.compareCodeUnits(left.assertionHash, right.assertionHash));
    const rules = [firstRule, secondRule].sort((left, right) => controlModel.compareCodeUnits(left.ruleId, right.ruleId));
    const evaluations = [
      policyEvaluation(firstRule, [firstAssertion.assertionHash]),
      policyEvaluation(secondRule, [secondAssertion.assertionHash]),
    ].sort((left, right) => controlModel.compareCodeUnits(left.evaluationHash, right.evaluationHash));
    const bundles = [firstBundle, secondBundle].sort((left, right) => controlModel.compareCodeUnits(left.bundleHash, right.bundleHash));
    const forged = capsuleV1(recordValue, claims, assertions, rules, evaluations, bundles, [provider()]);
    expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(forged).success).toBe(false);
  });

  it("fails closed without throwing when hostile assertion content cannot be canonicalized", () => {
    for (const hostile of [Number.NaN, "\uD800"] as const) {
      const capsule = structuredClone(validCapsule());
      capsule.assertions[0]!.methodParameters = { hostile };
      let parsed: ReturnType<typeof controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse> | undefined;
      expect(() => {
        parsed = controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(capsule);
      }).not.toThrow();
      expect(parsed?.success).toBe(false);
    }
  });

  it("rejects a subject that diverges from the basis ControlHandoffRecordV2", () => {
    const capsule = validCapsule();
    const forgedSubjectInput = { ...capsule.subject, changeId: "change.forged" };
    const { subjectHash: _hash, ...forgedPayload } = forgedSubjectInput;
    const forgedSubject = {
      ...forgedPayload,
      subjectHash: controlModel.computeChangeAuthorizationSubjectV1Hash(forgedPayload),
    };
    const { capsuleHash: _capsuleHash, ...payload } = { ...capsule, subject: forgedSubject };
    const forged = { ...payload, capsuleHash: controlModel.computeChangeAuthorizationCapsuleV1Hash(payload) };
    expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(forged).success).toBe(false);
  });

  it("rejects an assertion whose source commit does not bind the basis observed commit", () => {
    const recordValue = record("REALIZED");
    const claimValue = claim(recordValue);
    const rule = policyRule(claimValue.claimHash);
    const substituted = assertion(claimValue, { sourceCommit: "substituted-commit" });
    const bundle = bundleForRule(rule.ruleId, [substituted]);
    const evaluation = policyEvaluation(rule, [substituted.assertionHash]);
    const forged = capsuleV1(recordValue, [claimValue], [substituted], [rule], [evaluation], [bundle], [provider()]);
    expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(forged).success).toBe(false);
  });

  it("rejects an assertion whose scope escapes the basis touched coordinates", () => {
    const recordValue = record("REALIZED");
    const claimValue = claim(recordValue);
    const rule = policyRule(claimValue.claimHash);
    const escaped = assertion(claimValue, { scope: { schemaVersion: 1, coordinateIds: ["repo:file.other"] } });
    const bundle = bundleForRule(rule.ruleId, [escaped]);
    const evaluation = policyEvaluation(rule, [escaped.assertionHash]);
    const forged = capsuleV1(recordValue, [claimValue], [escaped], [rule], [evaluation], [bundle], [provider()]);
    expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(forged).success).toBe(false);
  });

  it("rejects a policy rule that allowlists APPROXIMATED or UNKNOWN", () => {
    const recordValue = record("REALIZED");
    const claimValue = claim(recordValue);
    expect(controlModel.ChangeAuthorizationPolicyRuleV1Schema.safeParse(
      policyRule(claimValue.claimHash, { allowedModalities: ["APPROXIMATED"] }),
    ).success).toBe(false);
    expect(controlModel.ChangeAuthorizationPolicyRuleV1Schema.safeParse(
      policyRule(claimValue.claimHash, { allowedModalities: ["UNKNOWN"] }),
    ).success).toBe(false);
  });

  it("rejects an assertion dependency that does not resolve within the capsule", () => {
    // A genuine hash-reference cycle cannot be constructed honestly: computing an
    // assertion's hash requires its dependency hashes to already be fixed, which is
    // exactly what makes the dependency graph a DAG by construction. The reachable
    // adversarial case is a dangling or forged dependency hash, exercised here.
    const recordValue = record("REALIZED");
    const claimValue = claim(recordValue);
    const one = assertion(claimValue, { assertionId: "assertion.one" });
    const two = assertion(claimValue, { assertionId: "assertion.two", dependsOnAssertionHashes: [hashD] });
    const rule = policyRule(claimValue.claimHash);
    const bundle = bundleForRule(rule.ruleId, [one, two]);
    const evaluation = policyEvaluation(rule, [one.assertionHash]);
    const forged = capsuleV1(recordValue, [claimValue], [one, two], [rule], [evaluation], [bundle], [provider()]);
    expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(forged).success).toBe(false);
  });

  it("forces DENY when the basis reconciliation is VIOLATED, even with satisfied rules", () => {
    const recordValue = record("VIOLATED");
    const claimValue = claim(recordValue);
    const rule = policyRule(claimValue.claimHash);
    const passingAssertion = assertion(claimValue);
    const bundle = bundleForRule(rule.ruleId, [passingAssertion]);
    const evaluation = policyEvaluation(rule, [passingAssertion.assertionHash]);
    const capsule = capsuleV1(recordValue, [claimValue], [passingAssertion], [rule], [evaluation], [bundle], [provider()]);
    expect(capsule.verdict).toBe("DENY");
    expect(capsule.reasonCodes).toContain("INVARIANT_VIOLATED");
    expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(capsule).success).toBe(true);
  });

  it("ceilings at REQUIRE_EVIDENCE when the basis reconciliation is UNPROVEN, even with satisfied rules", () => {
    const recordValue = record("UNPROVEN");
    const claimValue = claim(recordValue);
    const rule = policyRule(claimValue.claimHash);
    const passingAssertion = assertion(claimValue);
    const bundle = bundleForRule(rule.ruleId, [passingAssertion]);
    const evaluation = policyEvaluation(rule, [passingAssertion.assertionHash]);
    const capsule = capsuleV1(recordValue, [claimValue], [passingAssertion], [rule], [evaluation], [bundle], [provider()]);
    expect(capsule.verdict).toBe("REQUIRE_EVIDENCE");
    expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(capsule).success).toBe(true);
  });

  it("maps to a bounded in-toto Statement v1 predicate without live signing, binding the subject to the change under authorization", () => {
    const capsule = validCapsule();
    const statement = controlModel.buildChangeAuthorizationInTotoStatementV1(capsule);
    expect(statement.predicateType).toBe(changeAuthorization.CHANGE_AUTHORIZATION_PREDICATE_TYPE_V1);
    expect(statement.subject).toHaveLength(1);
    expect(statement.subject[0]?.name).toBe(capsule.subject.changeId);
    expect(statement.subject[0]?.digest.sha256).toBe(capsule.subject.subjectHash.slice("sha256:".length));
    expect(statement.subject[0]?.digest.sha256).not.toBe(capsule.capsuleHash.slice("sha256:".length));
    expect(controlModel.ChangeAuthorizationInTotoStatementV1Schema.safeParse(statement).success).toBe(true);
  });

  it("rejects an in-toto statement whose subject name or digest was forged independently of the predicate", () => {
    const capsule = validCapsule();
    const statement = controlModel.buildChangeAuthorizationInTotoStatementV1(capsule);
    expect(controlModel.ChangeAuthorizationInTotoStatementV1Schema.safeParse({
      ...statement,
      subject: [{ name: "change.forged", digest: statement.subject[0]!.digest }],
    }).success).toBe(false);
    expect(controlModel.ChangeAuthorizationInTotoStatementV1Schema.safeParse({
      ...statement,
      subject: [{ name: statement.subject[0]!.name, digest: { sha256: "f".repeat(64) } }],
    }).success).toBe(false);
    // capsuleHash identifies the predicate record only; it must never substitute for subjectHash.
    expect(controlModel.ChangeAuthorizationInTotoStatementV1Schema.safeParse({
      ...statement,
      subject: [{ name: statement.subject[0]!.name, digest: { sha256: capsule.capsuleHash.slice("sha256:".length) } }],
    }).success).toBe(false);
  });

  it("rejects an in-toto statement with more than one subject", () => {
    const capsule = validCapsule();
    const statement = controlModel.buildChangeAuthorizationInTotoStatementV1(capsule);
    expect(controlModel.ChangeAuthorizationInTotoStatementV1Schema.safeParse({
      ...statement,
      subject: [...statement.subject, statement.subject[0]!],
    }).success).toBe(false);
  });

  describe("claim registry binding (unrelated or negative assertions can never be structurally valid ALLOW evidence)", () => {
    it("rejects an assertion that references an undeclared claim", () => {
      const recordValue = record("REALIZED");
      const claimValue = claim(recordValue);
      const rule = policyRule(claimValue.claimHash);
      const undeclaredClaim = claim(recordValue, { claimId: "claim.undeclared", subject: { kind: "CHANGE_REQUIREMENT", changeId: recordValue.request.planningBundle.taskEnvelope.changeId, requirementId: "requirement.undeclared" } });
      const orphanAssertion = assertion(undeclaredClaim, { assertionId: "assertion.orphan" });
      const bundle = bundleForRule(rule.ruleId, [orphanAssertion]);
      const evaluation = policyEvaluation(rule, [orphanAssertion.assertionHash]);
      // claimValue (declared) satisfies the rule's own reference; undeclaredClaim is intentionally omitted from `claims`.
      const forged = capsuleV1(recordValue, [claimValue], [orphanAssertion], [rule], [evaluation], [bundle], [provider()]);
      expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(forged).success).toBe(false);
    });

    it("rejects a satisfied evaluation whose contributing assertion addresses a different claim than the rule requires", () => {
      const recordValue = record("REALIZED");
      const claimValue = claim(recordValue);
      const otherClaim = claim(recordValue, { claimId: "claim.other", subject: { kind: "CHANGE_REQUIREMENT", changeId: recordValue.request.planningBundle.taskEnvelope.changeId, requirementId: "requirement.other" } });
      const rule = policyRule(claimValue.claimHash);
      const unrelatedAssertion = assertion(otherClaim, { assertionId: "assertion.unrelated" });
      const bundle = bundleForRule(rule.ruleId, [unrelatedAssertion]);
      // Forged: outcome says "satisfied" even though the only contributing assertion is bound to `otherClaim`, not `claimValue`.
      const forgedEvaluation = policyEvaluation(rule, [unrelatedAssertion.assertionHash]);
      const forged = capsuleV1(recordValue, [claimValue, otherClaim], [unrelatedAssertion], [rule], [forgedEvaluation], [bundle], [provider()]);
      expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(forged).success).toBe(false);
    });

    it("rejects a satisfied evaluation whose contributing assertion CONTRADICTS the required claim", () => {
      const recordValue = record("REALIZED");
      const claimValue = claim(recordValue);
      const rule = policyRule(claimValue.claimHash);
      const contradicting = assertion(claimValue, { conclusion: "CONTRADICTS" });
      const bundle = bundleForRule(rule.ruleId, [contradicting]);
      const forgedEvaluation = policyEvaluation(rule, [contradicting.assertionHash]);
      const forged = capsuleV1(recordValue, [claimValue], [contradicting], [rule], [forgedEvaluation], [bundle], [provider()]);
      expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(forged).success).toBe(false);
    });

    it("rejects a bundle that contradicts the required claim but is marked satisfied instead of violated", () => {
      const recordValue = record("REALIZED");
      const claimValue = claim(recordValue);
      const rule = policyRule(claimValue.claimHash);
      const supporting = assertion(claimValue);
      const contradicting = assertion(claimValue, { assertionId: "assertion.contradicting", conclusion: "CONTRADICTS" });
      const bundle = bundleForRule(rule.ruleId, [supporting, contradicting]);
      const forgedEvaluation = policyEvaluation(rule, [supporting.assertionHash]);
      const forged = capsuleV1(recordValue, [claimValue], [supporting, contradicting], [rule], [forgedEvaluation], [bundle], [provider()]);
      expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(forged).success).toBe(false);
    });

    it("rejects an ATTESTED assertion bound to a CHANGE_REQUIREMENT claim (modality/claim-kind binding)", () => {
      const recordValue = record("REALIZED");
      const claimValue = claim(recordValue);
      const rule = policyRule(claimValue.claimHash, { allowedModalities: ["ATTESTED", "TEST_OBSERVED"] });
      const misbound = assertion(claimValue, { modality: "ATTESTED" });
      const bundle = bundleForRule(rule.ruleId, [misbound]);
      const evaluation = policyEvaluation(rule, [misbound.assertionHash]);
      const forged = capsuleV1(recordValue, [claimValue], [misbound], [rule], [evaluation], [bundle], [provider()]);
      expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(forged).success).toBe(false);
    });

    it("accepts an ATTESTED assertion bound to a matching ASSERTION_AUTHENTICITY claim", () => {
      const recordValue = record("REALIZED");
      const authenticityClaim = claim(recordValue, {
        claimId: "claim.authenticity",
        subject: { kind: "ASSERTION_AUTHENTICITY", changeId: recordValue.request.planningBundle.taskEnvelope.changeId, producerId: "producer.bun-test" },
      });
      const rule = policyRule(authenticityClaim.claimHash, { ruleId: "rule.authenticity", allowedModalities: ["ATTESTED"] });
      const attested = assertion(authenticityClaim, { modality: "ATTESTED" });
      const bundle = bundleForRule(rule.ruleId, [attested]);
      const evaluation = policyEvaluation(rule, [attested.assertionHash]);
      const capsule = capsuleV1(recordValue, [authenticityClaim], [attested], [rule], [evaluation], [bundle], [provider()]);
      expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(capsule).success).toBe(true);
    });

    it("rejects a claim whose subject changeId diverges from the capsule's own subject", () => {
      const recordValue = record("REALIZED");
      const foreignChangeClaim = claim(recordValue, { subject: { kind: "CHANGE_REQUIREMENT", changeId: "change.someone-else", requirementId: "requirement.tests-pass" } });
      const rule = policyRule(foreignChangeClaim.claimHash);
      const passingAssertion = assertion(foreignChangeClaim);
      const bundle = bundleForRule(rule.ruleId, [passingAssertion]);
      const evaluation = policyEvaluation(rule, [passingAssertion.assertionHash]);
      const forged = capsuleV1(recordValue, [foreignChangeClaim], [passingAssertion], [rule], [evaluation], [bundle], [provider()]);
      expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(forged).success).toBe(false);
    });
  });

  describe("evidence universe (exact membership)", () => {
    it("rejects an evidenceUniverse that omits a declared assertion", () => {
      const capsule = validCapsule();
      // Self-consistent (its own hash matches its own content) but deliberately diverges from the
      // capsule's actual declared assertions, isolating the exact-membership cross-check.
      const truncatedPayload = { schemaVersion: 1 as const, assertionHashes: [], bundleHashes: capsule.evidenceUniverse.bundleHashes };
      const truncated: ChangeAuthorizationEvidenceUniverseV1 = {
        ...truncatedPayload,
        universeHash: controlModel.computeChangeAuthorizationEvidenceUniverseV1Hash(truncatedPayload),
      };
      const { capsuleHash: _hash, ...payload } = { ...capsule, evidenceUniverse: truncated };
      const forged = { ...payload, capsuleHash: controlModel.computeChangeAuthorizationCapsuleV1Hash(payload) };
      expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(forged).success).toBe(false);
    });

    it("rejects a universeHash that does not match its own declared content", () => {
      const capsule = validCapsule();
      const corrupted: ChangeAuthorizationEvidenceUniverseV1 = { ...capsule.evidenceUniverse, universeHash: hashD };
      expect(controlModel.ChangeAuthorizationEvidenceUniverseV1Schema.safeParse(corrupted).success).toBe(false);
    });
  });

  describe("authority descriptor (policy/trust pinned and hashed, outside the capsule's self-consistency loop)", () => {
    it("rejects an authorityDescriptor.policyRulesHash that does not match the declared policyRules", () => {
      const capsule = validCapsule();
      // Self-consistent (its own descriptorDigest matches its own content) but the policyRulesHash
      // it pins deliberately diverges from the capsule's actual declared policyRules.
      const corruptedPayload = {
        schemaVersion: 1 as const,
        policy: capsule.authorityDescriptor.policy,
        policyRulesHash: hashD,
        trustPolicy: capsule.authorityDescriptor.trustPolicy,
        trustRootIds: capsule.authorityDescriptor.trustRootIds,
        trustedRootSetHash: capsule.authorityDescriptor.trustedRootSetHash,
      };
      const corrupted: ChangeAuthorizationAuthorityDescriptorV1 = {
        ...corruptedPayload,
        descriptorDigest: controlModel.computeChangeAuthorizationAuthorityDescriptorV1Hash(corruptedPayload),
      };
      const { capsuleHash: _hash, ...payload } = { ...capsule, authorityDescriptor: corrupted };
      const forged = { ...payload, capsuleHash: controlModel.computeChangeAuthorizationCapsuleV1Hash(payload) };
      expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(forged).success).toBe(false);
    });

    it("rejects a descriptorDigest that does not match its own declared content", () => {
      const capsule = validCapsule();
      const corrupted: ChangeAuthorizationAuthorityDescriptorV1 = { ...capsule.authorityDescriptor, descriptorDigest: hashD };
      expect(controlModel.ChangeAuthorizationAuthorityDescriptorV1Schema.safeParse(corrupted).success).toBe(false);
    });

    it("rejects a trustedRootSetHash that does not match the declared trustRootIds", () => {
      const capsule = validCapsule();
      const corrupted: ChangeAuthorizationAuthorityDescriptorV1 = { ...capsule.authorityDescriptor, trustedRootSetHash: hashD };
      expect(controlModel.ChangeAuthorizationAuthorityDescriptorV1Schema.safeParse(corrupted).success).toBe(false);
    });
  });
});

describe("projectChangeAuthorizationSubjectV1 shape", () => {
  it("the change-authorization subpath re-exports the same schema as the root package", () => {
    expect(changeAuthorization.ChangeAuthorizationSubjectV1Schema).toBe(controlModel.ChangeAuthorizationSubjectV1Schema);
  });
});
