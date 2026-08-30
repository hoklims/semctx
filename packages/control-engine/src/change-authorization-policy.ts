import {
  CHANGE_AUTHORIZATION_VERDICT_RANK,
  ChangeAuthorizationAssertionV1Schema,
  ChangeAuthorizationCapsuleV1Schema,
  ChangeAuthorizationClaimV1Schema,
  ChangeAuthorizationEvidenceBundleV1Schema,
  ChangeAuthorizationEvidenceScopeV1Schema,
  ChangeAuthorizationPolicyRuleV1Schema,
  ChangeAuthorizationPolicyDescriptorV1Schema,
  ChangeAuthorizationProviderV1Schema,
  ChangeAuthorizationTimestampV1Schema,
  ChangeAuthorizationTrustPolicyDescriptorV1Schema,
  ControlHandoffRecordV2Schema,
  canonicalizeEvidenceRefs,
  canonicalizeChangeAuthorizationReasons,
  compareCodeUnits,
  computeChangeAuthorizationAssertionV1Hash,
  computeChangeAuthorizationAuthorityDescriptorV1Hash,
  computeChangeAuthorizationCapsuleV1Hash,
  computeChangeAuthorizationClaimV1Hash,
  computeChangeAuthorizationEvidenceBundleV1Hash,
  computeChangeAuthorizationEvidenceUniverseV1Hash,
  computeChangeAuthorizationPolicyEvaluationV1Hash,
  computeChangeAuthorizationPolicyRuleSetV1Hash,
  computeChangeAuthorizationSubjectV1Hash,
  computeChangeAuthorizationTrustRootSetV1Hash,
  isChangeAuthorizationJcsSafeV1,
  requiredClaimKindForModality,
  type ChangeAuthorizationAssertionV1,
  type ChangeAuthorizationAuthorityDescriptorV1,
  type ChangeAuthorizationCapsuleV1,
  type ChangeAuthorizationClaimSubjectV1,
  type ChangeAuthorizationClaimV1,
  type ChangeAuthorizationConclusionV1,
  type ChangeAuthorizationEvidenceBundleV1,
  type ChangeAuthorizationEvidenceScopeV1,
  type ChangeAuthorizationEvidenceUniverseV1,
  type ChangeAuthorizationModalityV1,
  type ChangeAuthorizationPolicyDescriptorV1,
  type ChangeAuthorizationPolicyEvaluationV1,
  type ChangeAuthorizationPolicyRuleV1,
  type ChangeAuthorizationProviderV1,
  type ChangeAuthorizationReasonCodeV1,
  type ChangeAuthorizationRuleOutcomeV1,
  type ChangeAuthorizationSubjectV1,
  type ChangeAuthorizationTrustPolicyDescriptorV1,
  type ChangeAuthorizationVerdictV1,
  type ControlHandoffRecordV2,
  type EvidenceRefV1,
  type QualifiedCoordinateId,
  type Sha256Hash,
} from "@semantic-context/control-model";

export type ChangeAuthorizationEvaluationReason =
  | "BASIS_RECORD_INVALID"
  | "PROVIDER_INVALID"
  | "PROVIDER_DUPLICATE"
  | "CLAIM_INVALID"
  | "CLAIM_DUPLICATE"
  | "POLICY_RULE_INVALID"
  | "POLICY_RULE_DUPLICATE"
  | "POLICY_RULE_CLAIM_UNKNOWN"
  | "ASSERTION_INVALID"
  | "ASSERTION_ID_DUPLICATE"
  | "ASSERTION_CLAIM_UNKNOWN"
  | "ASSERTION_CLAIM_MODALITY_MISMATCH"
  | "ASSERTION_PROVIDER_UNKNOWN"
  | "ASSERTION_SCOPE_OUT_OF_BOUNDS"
  | "ASSERTION_METHOD_PARAMETERS_UNSAFE"
  | "ASSERTION_DEPENDENCY_UNRESOLVED"
  | "ASSERTION_SELF_REFERENCE"
  | "EVIDENCE_BUNDLE_RULE_UNKNOWN"
  | "EVIDENCE_BUNDLE_INVALID"
  | "EVIDENCE_BUNDLE_ID_DUPLICATE"
  | "EVIDENCE_BUNDLE_DUPLICATE_RULE"
  | "EVIDENCE_BUNDLE_ASSERTION_UNKNOWN"
  | "CAPSULE_SCHEMA_INVALID"
  | "EVALUATION_INPUT_INVALID";

/** Structural, authenticity, substitution, hash, and type errors are INVALID — never DENY or REQUIRE_EVIDENCE. */
export class ChangeAuthorizationEvaluationError extends Error {
  constructor(
    readonly reason: ChangeAuthorizationEvaluationReason,
    message: string,
  ) {
    super(message);
    this.name = "ChangeAuthorizationEvaluationError";
  }
}

/** Caller-supplied claim subject, minus the `changeId` the evaluator injects from the basis record. */
export type ChangeAuthorizationClaimSubjectInputV1 =
  | { kind: "CHANGE_REQUIREMENT"; requirementId: string }
  | { kind: "HUMAN_APPROVAL"; approverRole: string }
  | { kind: "ASSERTION_AUTHENTICITY"; producerId: string };

export interface ChangeAuthorizationClaimInputV1 {
  /** Caller-local identifier used only to wire assertions/rules to this claim before hashing. */
  claimId: string;
  statement: string;
  subject: ChangeAuthorizationClaimSubjectInputV1;
}

export interface ChangeAuthorizationAssertionInputV1 {
  /** Caller-local identifier used only to wire dependsOn/contradicts before hashing; not itself a hash reference. */
  assertionId: string;
  /** References a `claimId` declared in this same input's `claims`. */
  claimId: string;
  conclusion: ChangeAuthorizationConclusionV1;
  modality: ChangeAuthorizationModalityV1;
  producerId: string;
  producerVersion: string;
  methodName: string;
  methodParameters: Record<string, unknown>;
  scope: ChangeAuthorizationEvidenceScopeV1;
  observedAt: string;
  expiresAt: string;
  providerId: string;
  artifacts: readonly EvidenceRefV1[];
  /** References other entries' `assertionId` in this same input; must be declared earlier in the array. */
  dependsOnAssertionIds: readonly string[];
  contradictsAssertionIds: readonly string[];
}

export interface ChangeAuthorizationEvidenceBundleInputV1 {
  bundleId: string;
  ruleId: string;
  assertionIds: readonly string[];
}

export interface ChangeAuthorizationPolicyRuleInputV1 {
  ruleId: string;
  description: string;
  /** References a `claimId` declared in this same input's `claims`. */
  requiredClaimId: string;
  allowedModalities: readonly ChangeAuthorizationModalityV1[];
  scopeCoordinateIds?: readonly QualifiedCoordinateId[];
  requiredCapability?: string;
}

export interface ChangeAuthorizationEvaluationInputV1 {
  capsuleId: string;
  basisRecord: ControlHandoffRecordV2;
  providers: readonly ChangeAuthorizationProviderV1[];
  claims: readonly ChangeAuthorizationClaimInputV1[];
  assertions: readonly ChangeAuthorizationAssertionInputV1[];
  evidenceBundles: readonly ChangeAuthorizationEvidenceBundleInputV1[];
  policyRules: readonly ChangeAuthorizationPolicyRuleInputV1[];
  trustedRootIds: readonly string[];
  policyDescriptor: ChangeAuthorizationPolicyDescriptorV1;
  trustPolicyDescriptor: ChangeAuthorizationTrustPolicyDescriptorV1;
  evaluatedAt: string;
}

/** Pure projection of a ControlHandoffRecordV2 into the change-authorization subject; no caller override accepted. */
export function projectChangeAuthorizationSubjectV1(
  record: ControlHandoffRecordV2,
): ChangeAuthorizationSubjectV1 {
  const taskEnvelope = record.request.planningBundle.taskEnvelope;
  const capsuleV2 = record.capsule;
  const payload: Omit<ChangeAuthorizationSubjectV1, "subjectHash"> = {
    schemaVersion: 1,
    changeId: taskEnvelope.changeId,
    changeContractHash: taskEnvelope.changeContractHash,
    parentIntentIds: taskEnvelope.parentIntentIds,
    nonGoals: taskEnvelope.nonGoals,
    expectedBehaviorDelta: taskEnvelope.expectedBehaviorDelta,
    declaredReconciliationScope: taskEnvelope.declaredReconciliationScope,
    planningCommit: taskEnvelope.planningCommit,
    observedCommit: capsuleV2.observedCommit,
    observedWorkingDiffHash: capsuleV2.observedWorkingDiffHash,
    touchedCoordinateIds: capsuleV2.touchedCoordinateIds,
    reconciliationTerminalStatus: capsuleV2.reconciliationTerminalStatus,
    reconciliationReasonCodes: capsuleV2.reconciliationReasonCodes,
  };
  return { ...payload, subjectHash: computeChangeAuthorizationSubjectV1Hash(payload) };
}

interface ChangeAuthorizationDerivationInputV1 {
  providers: readonly ChangeAuthorizationProviderV1[];
  assertions: readonly ChangeAuthorizationAssertionV1[];
  evidenceBundles: readonly ChangeAuthorizationEvidenceBundleV1[];
  policyRules: readonly ChangeAuthorizationPolicyRuleV1[];
  trustRootIds: readonly string[];
  policyDescriptor: ChangeAuthorizationPolicyDescriptorV1;
  trustPolicyDescriptor: ChangeAuthorizationTrustPolicyDescriptorV1;
  basisReconciliationTerminalStatus: "REALIZED" | "VIOLATED" | "UNPROVEN";
  evaluatedAt: string;
}

interface ChangeAuthorizationDerivationV1 {
  policyEvaluations: readonly ChangeAuthorizationPolicyEvaluationV1[];
  verdict: ChangeAuthorizationVerdictV1;
  reasonCodes: readonly ChangeAuthorizationReasonCodeV1[];
  evidenceUniverse: ChangeAuthorizationEvidenceUniverseV1;
  authorityDescriptor: ChangeAuthorizationAuthorityDescriptorV1;
}

function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyRuntimeString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRuntimeStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Shared pure derivation core: given already-hashed, sealed entities (never raw caller-local
 * wiring), produces the policy evaluations, verdict, evidence universe, and authority descriptor.
 * `evaluateChangeAuthorizationV1` calls this after resolving raw input; `replayChangeAuthorizationV1`
 * calls it again over a sealed capsule's own declared entities and compares the result — this is
 * what makes replay a real re-derivation rather than a structural `safeParse`.
 */
function deriveChangeAuthorizationDecisionV1(
  input: ChangeAuthorizationDerivationInputV1,
): ChangeAuthorizationDerivationV1 {
  const assertionsByHash = new Map(input.assertions.map((assertion) => [assertion.assertionHash, assertion]));
  const providersById = new Map(input.providers.map((provider) => [provider.providerId, provider]));
  const bundlesByRule = new Map(input.evidenceBundles.map((bundle) => [bundle.ruleId, bundle]));
  const trustRootIdSet = new Set(input.trustRootIds);

  const policyEvaluations = input.policyRules
    .map((rule) => evaluateRule(rule, bundlesByRule.get(rule.ruleId), assertionsByHash, providersById, trustRootIdSet, input.evaluatedAt))
    .sort((left, right) => compareCodeUnits(left.evaluationHash, right.evaluationHash));

  const { verdict, reasonCodes } = aggregateVerdict(policyEvaluations, input.basisReconciliationTerminalStatus);

  const evidenceUniversePayload: Omit<ChangeAuthorizationEvidenceUniverseV1, "universeHash"> = {
    schemaVersion: 1,
    assertionHashes: [...assertionsByHash.keys()].sort(compareCodeUnits),
    bundleHashes: input.evidenceBundles.map((bundle) => bundle.bundleHash).sort(compareCodeUnits),
  };
  const evidenceUniverse: ChangeAuthorizationEvidenceUniverseV1 = {
    ...evidenceUniversePayload,
    universeHash: computeChangeAuthorizationEvidenceUniverseV1Hash(evidenceUniversePayload),
  };

  const sortedTrustRootIds = [...trustRootIdSet].sort(compareCodeUnits);
  const authorityDescriptorPayload: Omit<ChangeAuthorizationAuthorityDescriptorV1, "descriptorDigest"> = {
    schemaVersion: 1,
    policy: input.policyDescriptor,
    policyRulesHash: computeChangeAuthorizationPolicyRuleSetV1Hash(input.policyRules),
    trustPolicy: input.trustPolicyDescriptor,
    trustRootIds: sortedTrustRootIds,
    trustedRootSetHash: computeChangeAuthorizationTrustRootSetV1Hash(sortedTrustRootIds),
  };
  const authorityDescriptor: ChangeAuthorizationAuthorityDescriptorV1 = {
    ...authorityDescriptorPayload,
    descriptorDigest: computeChangeAuthorizationAuthorityDescriptorV1Hash(authorityDescriptorPayload),
  };

  return { policyEvaluations, verdict, reasonCodes, evidenceUniverse, authorityDescriptor };
}

/**
 * Deterministic pure evaluator: same sealed inputs and clock always produce the same capsule.
 * No ambient time or randomness; `evaluatedAt` is the sole clock input.
 */
export function evaluateChangeAuthorizationV1(
  input: ChangeAuthorizationEvaluationInputV1,
): ChangeAuthorizationCapsuleV1 {
  if (!isRuntimeRecord(input as unknown)) {
    throw new ChangeAuthorizationEvaluationError("BASIS_RECORD_INVALID", "evaluation input must be an object");
  }
  const basisParse = ControlHandoffRecordV2Schema.safeParse(input.basisRecord);
  if (!basisParse.success) {
    throw new ChangeAuthorizationEvaluationError(
      "BASIS_RECORD_INVALID",
      `basis ControlHandoffRecordV2 failed schema validation: ${basisParse.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  const record = basisParse.data as ControlHandoffRecordV2;
  if (!isChangeAuthorizationJcsSafeV1(record)) {
    throw new ChangeAuthorizationEvaluationError(
      "BASIS_RECORD_INVALID",
      "basis ControlHandoffRecordV2 must be JCS-safe",
    );
  }
  const capsuleV2 = record.capsule;
  const subject = projectChangeAuthorizationSubjectV1(record);

  if (!isNonEmptyRuntimeString(input.capsuleId)) {
    throw new ChangeAuthorizationEvaluationError("EVALUATION_INPUT_INVALID", "capsule id must be a non-empty string");
  }
  const evaluatedAtParse = ChangeAuthorizationTimestampV1Schema.safeParse(input.evaluatedAt);
  const policyDescriptorParse = ChangeAuthorizationPolicyDescriptorV1Schema.safeParse(input.policyDescriptor);
  const trustPolicyDescriptorParse = ChangeAuthorizationTrustPolicyDescriptorV1Schema.safeParse(
    input.trustPolicyDescriptor,
  );
  if (!evaluatedAtParse.success || !policyDescriptorParse.success || !trustPolicyDescriptorParse.success) {
    throw new ChangeAuthorizationEvaluationError(
      "EVALUATION_INPUT_INVALID",
      "evaluatedAt and authority descriptors must satisfy their public schemas",
    );
  }
  const evaluatedAt = evaluatedAtParse.data;
  const policyDescriptor = policyDescriptorParse.data as ChangeAuthorizationPolicyDescriptorV1;
  const trustPolicyDescriptor = trustPolicyDescriptorParse.data as ChangeAuthorizationTrustPolicyDescriptorV1;

  if (!Array.isArray(input.providers)) {
    throw new ChangeAuthorizationEvaluationError("PROVIDER_INVALID", "providers must be an array");
  }
  if (!Array.isArray(input.claims)) {
    throw new ChangeAuthorizationEvaluationError("CLAIM_INVALID", "claims must be an array");
  }
  if (!Array.isArray(input.policyRules)) {
    throw new ChangeAuthorizationEvaluationError("POLICY_RULE_INVALID", "policy rules must be an array");
  }
  if (!Array.isArray(input.assertions)) {
    throw new ChangeAuthorizationEvaluationError("ASSERTION_INVALID", "assertions must be an array");
  }
  if (!Array.isArray(input.evidenceBundles)) {
    throw new ChangeAuthorizationEvaluationError("EVIDENCE_BUNDLE_INVALID", "evidence bundles must be an array");
  }
  if (!isRuntimeStringArray(input.trustedRootIds) || input.trustedRootIds.some((id) => id.length === 0)) {
    throw new ChangeAuthorizationEvaluationError(
      "EVALUATION_INPUT_INVALID",
      "trusted root ids must be an array of non-empty strings",
    );
  }
  if (
    !isChangeAuthorizationJcsSafeV1(input.capsuleId)
    || !isChangeAuthorizationJcsSafeV1(evaluatedAt)
    || !isChangeAuthorizationJcsSafeV1(policyDescriptor)
    || !isChangeAuthorizationJcsSafeV1(trustPolicyDescriptor)
    || !isChangeAuthorizationJcsSafeV1(input.trustedRootIds)
  ) {
    throw new ChangeAuthorizationEvaluationError(
      "EVALUATION_INPUT_INVALID",
      "capsule identity, clock, authority descriptors, and trusted root ids must be JCS-safe",
    );
  }

  const providers: ChangeAuthorizationProviderV1[] = [];
  for (const provider of input.providers as readonly ChangeAuthorizationProviderV1[]) {
    const providerValue: unknown = provider;
    if (!isRuntimeRecord(providerValue)) {
      throw new ChangeAuthorizationEvaluationError("PROVIDER_INVALID", "provider input must be an object");
    }
    const parsed = ChangeAuthorizationProviderV1Schema.safeParse(providerValue);
    if (!parsed.success) {
      const providerId = typeof providerValue.providerId === "string" ? providerValue.providerId : "<invalid>";
      throw new ChangeAuthorizationEvaluationError(
        "PROVIDER_INVALID",
        `provider ${providerId} failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
      );
    }
    if (!isChangeAuthorizationJcsSafeV1(parsed.data)) {
      throw new ChangeAuthorizationEvaluationError(
        "PROVIDER_INVALID",
        "provider input must be JCS-safe",
      );
    }
    providers.push(parsed.data as ChangeAuthorizationProviderV1);
  }
  if (new Set(providers.map((provider) => provider.providerId)).size !== providers.length) {
    throw new ChangeAuthorizationEvaluationError("PROVIDER_DUPLICATE", "provider ids must be unique");
  }
  const providersById = new Map(providers.map((provider) => [provider.providerId, provider]));

  const claims: ChangeAuthorizationClaimV1[] = [];
  const claimHashById = new Map<string, Sha256Hash>();
  for (const rawClaim of input.claims as readonly ChangeAuthorizationClaimInputV1[]) {
    const rawClaimValue: unknown = rawClaim;
    if (
      !isRuntimeRecord(rawClaimValue)
      || !isNonEmptyRuntimeString(rawClaimValue.claimId)
      || !isNonEmptyRuntimeString(rawClaimValue.statement)
      || !isRuntimeRecord(rawClaimValue.subject)
    ) {
      throw new ChangeAuthorizationEvaluationError(
        "CLAIM_INVALID",
        "claim input must declare an id, statement, and subject object",
      );
    }
    if (claimHashById.has(rawClaim.claimId)) {
      throw new ChangeAuthorizationEvaluationError("CLAIM_DUPLICATE", `claim id ${rawClaim.claimId} is declared twice`);
    }
    const subjectPayload = { ...rawClaim.subject, changeId: subject.changeId } as ChangeAuthorizationClaimSubjectV1;
    const payload: Omit<ChangeAuthorizationClaimV1, "claimHash"> = {
      schemaVersion: 1,
      claimId: rawClaim.claimId,
      statement: rawClaim.statement,
      subject: subjectPayload,
    };
    let claimHash: Sha256Hash;
    try {
      claimHash = computeChangeAuthorizationClaimV1Hash(payload);
    } catch {
      throw new ChangeAuthorizationEvaluationError(
        "CLAIM_INVALID",
        `claim ${rawClaim.claimId} cannot be canonically hashed`,
      );
    }
    const parsed = ChangeAuthorizationClaimV1Schema.safeParse({ ...payload, claimHash });
    if (!parsed.success) {
      throw new ChangeAuthorizationEvaluationError(
        "CLAIM_INVALID",
        `claim ${rawClaim.claimId} failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
      );
    }
    claimHashById.set(rawClaim.claimId, claimHash);
    claims.push(parsed.data as ChangeAuthorizationClaimV1);
  }
  const claimsByHash = new Map(claims.map((claim) => [claim.claimHash, claim]));

  const policyRules: ChangeAuthorizationPolicyRuleV1[] = [];
  for (const rawRule of input.policyRules as readonly ChangeAuthorizationPolicyRuleInputV1[]) {
    const rawRuleValue: unknown = rawRule;
    if (
      !isRuntimeRecord(rawRuleValue)
      || !isNonEmptyRuntimeString(rawRuleValue.ruleId)
      || !isNonEmptyRuntimeString(rawRuleValue.description)
      || !isNonEmptyRuntimeString(rawRuleValue.requiredClaimId)
      || !isRuntimeStringArray(rawRuleValue.allowedModalities)
    ) {
      throw new ChangeAuthorizationEvaluationError(
        "POLICY_RULE_INVALID",
        "policy rule input must declare string ids, a description, and a modality array",
      );
    }
    const requiredClaimHash = claimHashById.get(rawRule.requiredClaimId);
    if (requiredClaimHash === undefined) {
      throw new ChangeAuthorizationEvaluationError(
        "POLICY_RULE_CLAIM_UNKNOWN",
        `policy rule ${rawRule.ruleId} references undeclared claim ${rawRule.requiredClaimId}`,
      );
    }
    const payload = {
      schemaVersion: 1 as const,
      ruleId: rawRule.ruleId,
      description: rawRule.description,
      requiredClaimHash,
      allowedModalities: rawRule.allowedModalities,
      ...(rawRule.scopeCoordinateIds === undefined ? {} : { scopeCoordinateIds: rawRule.scopeCoordinateIds }),
      ...(rawRule.requiredCapability === undefined ? {} : { requiredCapability: rawRule.requiredCapability }),
    };
    const parsed = ChangeAuthorizationPolicyRuleV1Schema.safeParse(payload);
    if (!parsed.success) {
      throw new ChangeAuthorizationEvaluationError(
        "POLICY_RULE_INVALID",
        `policy rule ${rawRule.ruleId} failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
      );
    }
    if (!isChangeAuthorizationJcsSafeV1(parsed.data)) {
      throw new ChangeAuthorizationEvaluationError(
        "POLICY_RULE_INVALID",
        `policy rule ${rawRule.ruleId} must be JCS-safe`,
      );
    }
    policyRules.push(parsed.data as ChangeAuthorizationPolicyRuleV1);
  }
  if (new Set(policyRules.map((rule) => rule.ruleId)).size !== policyRules.length) {
    throw new ChangeAuthorizationEvaluationError("POLICY_RULE_DUPLICATE", "policy rule ids must be unique");
  }

  const touchedCoordinateIds = new Set<QualifiedCoordinateId>(capsuleV2.touchedCoordinateIds);
  const assertionHashById = new Map<string, Sha256Hash>();
  const assertions: ChangeAuthorizationAssertionV1[] = [];
  for (const rawAssertion of input.assertions as readonly ChangeAuthorizationAssertionInputV1[]) {
    const rawAssertionValue: unknown = rawAssertion;
    if (
      !isRuntimeRecord(rawAssertionValue)
      || !isNonEmptyRuntimeString(rawAssertionValue.assertionId)
      || !isNonEmptyRuntimeString(rawAssertionValue.claimId)
      || !isRuntimeStringArray(rawAssertionValue.dependsOnAssertionIds)
      || !isRuntimeStringArray(rawAssertionValue.contradictsAssertionIds)
    ) {
      throw new ChangeAuthorizationEvaluationError(
        "ASSERTION_INVALID",
        "assertion input must declare string ids and string dependency arrays",
      );
    }
    const scopeParse = ChangeAuthorizationEvidenceScopeV1Schema.safeParse(rawAssertionValue.scope);
    if (!scopeParse.success) {
      throw new ChangeAuthorizationEvaluationError(
        "ASSERTION_INVALID",
        `assertion ${rawAssertion.assertionId} scope failed schema validation: ${scopeParse.error.issues[0]?.message ?? "unknown error"}`,
      );
    }
    const scope = scopeParse.data as ChangeAuthorizationEvidenceScopeV1;
    if (assertionHashById.has(rawAssertion.assertionId)) {
      throw new ChangeAuthorizationEvaluationError(
        "ASSERTION_ID_DUPLICATE",
        `assertion id ${rawAssertion.assertionId} is declared twice`,
      );
    }
    if (!providersById.has(rawAssertion.providerId)) {
      throw new ChangeAuthorizationEvaluationError(
        "ASSERTION_PROVIDER_UNKNOWN",
        `assertion ${rawAssertion.assertionId} references undeclared provider ${rawAssertion.providerId}`,
      );
    }
    const claimHash = claimHashById.get(rawAssertion.claimId);
    if (claimHash === undefined) {
      throw new ChangeAuthorizationEvaluationError(
        "ASSERTION_CLAIM_UNKNOWN",
        `assertion ${rawAssertion.assertionId} references undeclared claim ${rawAssertion.claimId}`,
      );
    }
    const claim = claimsByHash.get(claimHash)!;
    if (requiredClaimKindForModality(rawAssertion.modality) !== claim.subject.kind) {
      throw new ChangeAuthorizationEvaluationError(
        "ASSERTION_CLAIM_MODALITY_MISMATCH",
        `assertion ${rawAssertion.assertionId} modality ${rawAssertion.modality} cannot address a ${claim.subject.kind} claim`,
      );
    }
    if (scope.coordinateIds.some((id) => !touchedCoordinateIds.has(id))) {
      throw new ChangeAuthorizationEvaluationError(
        "ASSERTION_SCOPE_OUT_OF_BOUNDS",
        `assertion ${rawAssertion.assertionId} scope escapes the basis touched coordinates`,
      );
    }
    if (!isChangeAuthorizationJcsSafeV1(rawAssertion.methodParameters)) {
      throw new ChangeAuthorizationEvaluationError(
        "ASSERTION_METHOD_PARAMETERS_UNSAFE",
        `assertion ${rawAssertion.assertionId} method parameters are not JCS-safe`,
      );
    }
    if (rawAssertion.dependsOnAssertionIds.includes(rawAssertion.assertionId)) {
      throw new ChangeAuthorizationEvaluationError(
        "ASSERTION_SELF_REFERENCE",
        `assertion ${rawAssertion.assertionId} cannot depend on itself`,
      );
    }
    if (rawAssertion.contradictsAssertionIds.includes(rawAssertion.assertionId)) {
      throw new ChangeAuthorizationEvaluationError(
        "ASSERTION_SELF_REFERENCE",
        `assertion ${rawAssertion.assertionId} cannot contradict itself`,
      );
    }
    const dependsOnAssertionHashes = resolveHashes(
      rawAssertion.dependsOnAssertionIds,
      assertionHashById,
      rawAssertion.assertionId,
    );
    const contradicts = resolveHashes(
      rawAssertion.contradictsAssertionIds,
      assertionHashById,
      rawAssertion.assertionId,
    );
    let artifacts: readonly EvidenceRefV1[];
    try {
      artifacts = canonicalizeEvidenceRefs(rawAssertion.artifacts);
    } catch {
      throw new ChangeAuthorizationEvaluationError(
        "ASSERTION_INVALID",
        `assertion ${rawAssertion.assertionId} artifacts are invalid or non-canonicalizable`,
      );
    }
    const payload: Omit<ChangeAuthorizationAssertionV1, "assertionHash"> = {
      schemaVersion: 1,
      assertionId: rawAssertion.assertionId,
      claimHash,
      conclusion: rawAssertion.conclusion,
      modality: rawAssertion.modality,
      producerId: rawAssertion.producerId,
      producerVersion: rawAssertion.producerVersion,
      sourceCommit: capsuleV2.observedCommit,
      sourceDiffHash: capsuleV2.observedWorkingDiffHash,
      methodName: rawAssertion.methodName,
      methodParameters: rawAssertion.methodParameters,
      scope,
      observedAt: rawAssertion.observedAt,
      expiresAt: rawAssertion.expiresAt,
      providerId: rawAssertion.providerId,
      artifacts,
      dependsOnAssertionHashes,
      contradicts,
    };
    let assertionHash: Sha256Hash;
    try {
      assertionHash = computeChangeAuthorizationAssertionV1Hash(payload);
    } catch {
      throw new ChangeAuthorizationEvaluationError(
        "ASSERTION_INVALID",
        `assertion ${rawAssertion.assertionId} cannot be canonically hashed`,
      );
    }
    const assertionParse = ChangeAuthorizationAssertionV1Schema.safeParse({ ...payload, assertionHash });
    if (!assertionParse.success) {
      throw new ChangeAuthorizationEvaluationError(
        "ASSERTION_INVALID",
        `assertion ${rawAssertion.assertionId} failed schema validation: ${assertionParse.error.issues[0]?.message ?? "unknown error"}`,
      );
    }
    const assertion = assertionParse.data as ChangeAuthorizationAssertionV1;
    assertionHashById.set(rawAssertion.assertionId, assertionHash);
    assertions.push(assertion);
  }

  const ruleIds = new Set(policyRules.map((rule) => rule.ruleId));
  const bundlesByRule = new Map<string, ChangeAuthorizationEvidenceBundleV1>();
  const bundleIds = new Set<string>();
  for (const rawBundle of input.evidenceBundles as readonly ChangeAuthorizationEvidenceBundleInputV1[]) {
    const rawBundleValue: unknown = rawBundle;
    if (
      !isRuntimeRecord(rawBundleValue)
      || !isNonEmptyRuntimeString(rawBundleValue.bundleId)
      || !isNonEmptyRuntimeString(rawBundleValue.ruleId)
      || !isRuntimeStringArray(rawBundleValue.assertionIds)
    ) {
      throw new ChangeAuthorizationEvaluationError(
        "EVIDENCE_BUNDLE_INVALID",
        "evidence bundle input must declare string ids and an assertion id array",
      );
    }
    if (!ruleIds.has(rawBundle.ruleId)) {
      throw new ChangeAuthorizationEvaluationError(
        "EVIDENCE_BUNDLE_RULE_UNKNOWN",
        `evidence bundle ${rawBundle.bundleId} references undeclared rule ${rawBundle.ruleId}`,
      );
    }
    if (bundlesByRule.has(rawBundle.ruleId)) {
      throw new ChangeAuthorizationEvaluationError(
        "EVIDENCE_BUNDLE_DUPLICATE_RULE",
        `rule ${rawBundle.ruleId} has more than one evidence bundle`,
      );
    }
    if (bundleIds.has(rawBundle.bundleId)) {
      throw new ChangeAuthorizationEvaluationError(
        "EVIDENCE_BUNDLE_ID_DUPLICATE",
        `evidence bundle id ${rawBundle.bundleId} is declared twice`,
      );
    }
    const assertionHashes = rawBundle.assertionIds.map((assertionId) => {
      const hash = assertionHashById.get(assertionId);
      if (hash === undefined) {
        throw new ChangeAuthorizationEvaluationError(
          "EVIDENCE_BUNDLE_ASSERTION_UNKNOWN",
          `evidence bundle ${rawBundle.bundleId} references undeclared assertion ${assertionId}`,
        );
      }
      return hash;
    });
    const payload: Omit<ChangeAuthorizationEvidenceBundleV1, "bundleHash"> = {
      schemaVersion: 1,
      bundleId: rawBundle.bundleId,
      ruleId: rawBundle.ruleId,
      assertionHashes: [...new Set(assertionHashes)].sort(compareCodeUnits),
    };
    let bundleHash: Sha256Hash;
    try {
      bundleHash = computeChangeAuthorizationEvidenceBundleV1Hash(payload);
    } catch {
      throw new ChangeAuthorizationEvaluationError(
        "EVIDENCE_BUNDLE_INVALID",
        `evidence bundle ${rawBundle.bundleId} cannot be canonically hashed`,
      );
    }
    const bundleParse = ChangeAuthorizationEvidenceBundleV1Schema.safeParse({ ...payload, bundleHash });
    if (!bundleParse.success) {
      throw new ChangeAuthorizationEvaluationError(
        "EVIDENCE_BUNDLE_INVALID",
        `evidence bundle ${rawBundle.bundleId} failed schema validation: ${bundleParse.error.issues[0]?.message ?? "unknown error"}`,
      );
    }
    const bundle = bundleParse.data as ChangeAuthorizationEvidenceBundleV1;
    bundleIds.add(rawBundle.bundleId);
    bundlesByRule.set(rawBundle.ruleId, bundle);
  }

  const derived = deriveChangeAuthorizationDecisionV1({
    providers,
    assertions,
    evidenceBundles: [...bundlesByRule.values()],
    policyRules,
    trustRootIds: input.trustedRootIds,
    policyDescriptor,
    trustPolicyDescriptor,
    basisReconciliationTerminalStatus: capsuleV2.reconciliationTerminalStatus,
    evaluatedAt,
  });

  const capsulePayload: Omit<ChangeAuthorizationCapsuleV1, "capsuleHash"> = {
    schemaVersion: 1,
    kind: "change_authorization_capsule",
    executionAuthority: "none",
    enforcementMode: "shadow",
    blockingEnabled: false,
    authorizationEffect: "advisory_record",
    capsuleId: input.capsuleId,
    basis: { record },
    subject,
    providers: [...providers].sort((left, right) => compareCodeUnits(left.providerId, right.providerId)),
    claims: [...claims].sort((left, right) => compareCodeUnits(left.claimHash, right.claimHash)),
    assertions: [...assertions].sort((left, right) => compareCodeUnits(left.assertionHash, right.assertionHash)),
    evidenceBundles: [...bundlesByRule.values()]
      .sort((left, right) => compareCodeUnits(left.bundleHash, right.bundleHash)),
    evidenceUniverse: derived.evidenceUniverse,
    policyRules: [...policyRules].sort((left, right) => compareCodeUnits(left.ruleId, right.ruleId)),
    policyEvaluations: derived.policyEvaluations,
    authorityDescriptor: derived.authorityDescriptor,
    verdict: derived.verdict,
    reasonCodes: derived.reasonCodes,
    evaluatedAt,
  };
  const capsuleHash = computeChangeAuthorizationCapsuleV1Hash(capsulePayload);
  const parsedCapsule = ChangeAuthorizationCapsuleV1Schema.safeParse({ ...capsulePayload, capsuleHash });
  if (!parsedCapsule.success) {
    throw new ChangeAuthorizationEvaluationError(
      "CAPSULE_SCHEMA_INVALID",
      `constructed capsule failed schema validation: ${parsedCapsule.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  return parsedCapsule.data as ChangeAuthorizationCapsuleV1;
}

export const CHANGE_AUTHORIZATION_REPLAY_REASONS = [
  "CAPSULE_SCHEMA_INVALID",
  "SUBJECT_REDERIVATION_MISMATCH",
  "POLICY_EVALUATION_REDERIVATION_MISMATCH",
  "VERDICT_REDERIVATION_MISMATCH",
  "REASON_CODES_REDERIVATION_MISMATCH",
  "EVIDENCE_UNIVERSE_MISMATCH",
  "AUTHORITY_DESCRIPTOR_MISMATCH",
] as const;
export type ChangeAuthorizationReplayReasonV1 = typeof CHANGE_AUTHORIZATION_REPLAY_REASONS[number];

export interface ChangeAuthorizationReplayReportV1 {
  result: "VALID" | "INVALID";
  reasons: readonly ChangeAuthorizationReplayReasonV1[];
}

/**
 * Re-derives a sealed capsule's verdict from its own declared providers/claims/assertions/rules
 * using `deriveChangeAuthorizationDecisionV1` — the same pure core the evaluator used to build it
 * — and compares every re-derived value byte-exactly against what the capsule claims.
 * `ChangeAuthorizationCapsuleV1Schema.safeParse` alone only checks internal self-consistency (every
 * hash matches its own recomputed content); it cannot catch a capsule whose `policyEvaluations`
 * were hand-authored to say "satisfied" without actually satisfying the disqualification rules
 * (expired evidence, a degraded/untrusted provider, an unbound trust root). Replay does, because it
 * reruns the same rule evaluation the evaluator would have run.
 *
 * `expectedAuthorityDescriptorDigest` must come from outside the capsule (a verifier's own pinned
 * record of the authority in force), never from the capsule itself: a capsule that recomputes every
 * internal hash consistently but substitutes a different policy or trust-root set is still rejected,
 * because the externally supplied digest will not match.
 */
export function replayChangeAuthorizationV1(
  capsule: ChangeAuthorizationCapsuleV1,
  options: { expectedAuthorityDescriptorDigest: Sha256Hash },
): ChangeAuthorizationReplayReportV1 {
  const parsed = ChangeAuthorizationCapsuleV1Schema.safeParse(capsule);
  if (!parsed.success) return { result: "INVALID", reasons: ["CAPSULE_SCHEMA_INVALID"] };
  const sealed = parsed.data as ChangeAuthorizationCapsuleV1;

  const reasons: ChangeAuthorizationReplayReasonV1[] = [];

  const rederivedSubject = projectChangeAuthorizationSubjectV1(sealed.basis.record);
  if (rederivedSubject.subjectHash !== sealed.subject.subjectHash) reasons.push("SUBJECT_REDERIVATION_MISMATCH");

  const derived = deriveChangeAuthorizationDecisionV1({
    providers: sealed.providers,
    assertions: sealed.assertions,
    evidenceBundles: sealed.evidenceBundles,
    policyRules: sealed.policyRules,
    trustRootIds: sealed.authorityDescriptor.trustRootIds,
    policyDescriptor: sealed.authorityDescriptor.policy,
    trustPolicyDescriptor: sealed.authorityDescriptor.trustPolicy,
    basisReconciliationTerminalStatus: sealed.basis.record.capsule.reconciliationTerminalStatus,
    evaluatedAt: sealed.evaluatedAt,
  });

  const derivedEvaluationHashes = derived.policyEvaluations.map((evaluation) => evaluation.evaluationHash).sort(compareCodeUnits);
  const sealedEvaluationHashes = sealed.policyEvaluations.map((evaluation) => evaluation.evaluationHash).sort(compareCodeUnits);
  if (JSON.stringify(derivedEvaluationHashes) !== JSON.stringify(sealedEvaluationHashes)) {
    reasons.push("POLICY_EVALUATION_REDERIVATION_MISMATCH");
  }
  if (derived.verdict !== sealed.verdict) reasons.push("VERDICT_REDERIVATION_MISMATCH");
  if (JSON.stringify(derived.reasonCodes) !== JSON.stringify(sealed.reasonCodes)) {
    reasons.push("REASON_CODES_REDERIVATION_MISMATCH");
  }
  if (derived.evidenceUniverse.universeHash !== sealed.evidenceUniverse.universeHash) {
    reasons.push("EVIDENCE_UNIVERSE_MISMATCH");
  }
  if (
    derived.authorityDescriptor.descriptorDigest !== sealed.authorityDescriptor.descriptorDigest
    || sealed.authorityDescriptor.descriptorDigest !== options.expectedAuthorityDescriptorDigest
  ) {
    reasons.push("AUTHORITY_DESCRIPTOR_MISMATCH");
  }

  return reasons.length === 0 ? { result: "VALID", reasons: [] } : { result: "INVALID", reasons: [...new Set(reasons)] };
}

export const CHANGE_AUTHORIZATION_MONOTONICITY_REASONS = [
  "SUBJECT_MISMATCH",
  "AUTHORITY_DESCRIPTOR_MISMATCH",
  "EVIDENCE_UNIVERSE_MISMATCH",
  "VERDICT_RANK_INCREASED",
] as const;
export type ChangeAuthorizationMonotonicityReasonV1 = typeof CHANGE_AUTHORIZATION_MONOTONICITY_REASONS[number];

export interface ChangeAuthorizationMonotonicityReportV1 {
  result: "VALID" | "INVALID";
  reasons: readonly ChangeAuthorizationMonotonicityReasonV1[];
}

/**
 * Monotonicity ("removing or degrading evidence never raises the verdict") is provable only
 * between two capsules that evaluated the exact same evidence universe, the exact same subject,
 * and the exact same authority. Comparing across a *different* evidence universe — for example,
 * one where a poisoned (mutually contradicting) assertion was removed rather than merely expired
 * or degraded — is not a monotonicity claim at all: the evaluations are about different evidence,
 * and a rank change there is expected, not a violation. This function refuses that comparison
 * instead of silently treating it as monotone or non-monotone.
 */
export function compareChangeAuthorizationMonotonicityV1(
  previous: ChangeAuthorizationCapsuleV1,
  next: ChangeAuthorizationCapsuleV1,
): ChangeAuthorizationMonotonicityReportV1 {
  const reasons: ChangeAuthorizationMonotonicityReasonV1[] = [];
  if (previous.subject.subjectHash !== next.subject.subjectHash) reasons.push("SUBJECT_MISMATCH");
  if (previous.authorityDescriptor.descriptorDigest !== next.authorityDescriptor.descriptorDigest) {
    reasons.push("AUTHORITY_DESCRIPTOR_MISMATCH");
  }
  if (previous.evidenceUniverse.universeHash !== next.evidenceUniverse.universeHash) {
    reasons.push("EVIDENCE_UNIVERSE_MISMATCH");
  }
  if (reasons.length === 0 && CHANGE_AUTHORIZATION_VERDICT_RANK[next.verdict] > CHANGE_AUTHORIZATION_VERDICT_RANK[previous.verdict]) {
    reasons.push("VERDICT_RANK_INCREASED");
  }
  return reasons.length === 0 ? { result: "VALID", reasons: [] } : { result: "INVALID", reasons };
}

function resolveHashes(
  ids: readonly string[],
  known: ReadonlyMap<string, Sha256Hash>,
  ownerAssertionId: string,
): Sha256Hash[] {
  const hashes = ids.map((id) => {
    const hash = known.get(id);
    if (hash === undefined) {
      throw new ChangeAuthorizationEvaluationError(
        "ASSERTION_DEPENDENCY_UNRESOLVED",
        `assertion ${ownerAssertionId} references ${id}, which must be declared earlier in the same evaluation`,
      );
    }
    return hash;
  });
  return [...new Set(hashes)].sort(compareCodeUnits);
}

function evaluateRule(
  rule: ChangeAuthorizationPolicyRuleV1,
  bundle: ChangeAuthorizationEvidenceBundleV1 | undefined,
  assertionsByHash: ReadonlyMap<Sha256Hash, ChangeAuthorizationAssertionV1>,
  providersById: ReadonlyMap<string, ChangeAuthorizationProviderV1>,
  trustedRootIds: ReadonlySet<string>,
  evaluatedAt: string,
): ChangeAuthorizationPolicyEvaluationV1 {
  const build = (
    outcome: ChangeAuthorizationRuleOutcomeV1,
    reasonCodes: readonly ChangeAuthorizationReasonCodeV1[],
    contributingAssertionHashes: readonly Sha256Hash[],
  ): ChangeAuthorizationPolicyEvaluationV1 => {
    const payload: Omit<ChangeAuthorizationPolicyEvaluationV1, "evaluationHash"> = {
      schemaVersion: 1,
      ruleId: rule.ruleId,
      outcome,
      reasonCodes: canonicalizeChangeAuthorizationReasons(reasonCodes),
      contributingAssertionHashes: [...contributingAssertionHashes].sort(compareCodeUnits),
    };
    return {
      ...payload,
      evaluationHash: computeChangeAuthorizationPolicyEvaluationV1Hash(payload),
    };
  };

  if (bundle === undefined) return build("insufficient", ["REQUIRED_EVIDENCE_MISSING"], []);

  const bundleAssertions = bundle.assertionHashes.map((hash) => assertionsByHash.get(hash)!);

  if (bundleAssertions.some((assertion) => assertion.modality === "APPROXIMATED" || assertion.modality === "UNKNOWN")) {
    return build("violated", ["POLICY_RULE_VIOLATED"], []);
  }
  if (rule.scopeCoordinateIds !== undefined) {
    const allowedScope = new Set(rule.scopeCoordinateIds);
    if (bundleAssertions.some((assertion) => assertion.scope.coordinateIds.some((id) => !allowedScope.has(id)))) {
      return build("violated", ["SCOPE_EXCEEDED"], []);
    }
  }
  const bundleHashes = new Set(bundle.assertionHashes);
  if (bundleAssertions.some((assertion) => assertion.contradicts.some((hash) => bundleHashes.has(hash)))) {
    return build("violated", ["EVIDENCE_CONTRADICTED"], []);
  }
  if (
    bundleAssertions.some(
      (assertion) => assertion.claimHash === rule.requiredClaimHash && assertion.conclusion === "CONTRADICTS",
    )
  ) {
    return build("violated", ["REQUIRED_CLAIM_CONTRADICTED"], []);
  }

  const reasons = new Set<ChangeAuthorizationReasonCodeV1>();
  const contributing: Sha256Hash[] = [];
  for (const assertion of bundleAssertions) {
    if (assertion.claimHash !== rule.requiredClaimHash) { reasons.add("REQUIRED_CLAIM_UNBOUND"); continue; }
    if (assertion.conclusion === "INCONCLUSIVE") { reasons.add("REQUIRED_CLAIM_INCONCLUSIVE"); continue; }
    const provider = providersById.get(assertion.providerId);
    if (provider === undefined) { reasons.add("REQUIRED_EVIDENCE_UNBOUND"); continue; }
    if (!rule.allowedModalities.includes(assertion.modality)) {
      reasons.add("REQUIRED_EVIDENCE_MODALITY_INSUFFICIENT");
      continue;
    }
    if (Date.parse(assertion.observedAt) > Date.parse(evaluatedAt) || Date.parse(evaluatedAt) > Date.parse(assertion.expiresAt)) {
      reasons.add("REQUIRED_EVIDENCE_EXPIRED");
      continue;
    }
    if (provider.status === "UNTRUSTED") { reasons.add("PROVIDER_CAPABILITY_UNTRUSTED"); continue; }
    if (provider.status === "UNAVAILABLE") { reasons.add("PROVIDER_CAPABILITY_MISSING"); continue; }
    if (provider.status === "DEGRADED") { reasons.add("PROVIDER_CAPABILITY_DEGRADED"); continue; }
    if (Date.parse(provider.observedAt) > Date.parse(evaluatedAt) || Date.parse(evaluatedAt) > Date.parse(provider.expiresAt)) {
      reasons.add("SOURCE_SEAL_STALE");
      continue;
    }
    if (!trustedRootIds.has(provider.trustRootId)) { reasons.add("TRUST_ROOT_UNAVAILABLE"); continue; }
    if (rule.requiredCapability !== undefined && !provider.capabilities.includes(rule.requiredCapability)) {
      reasons.add("PROVIDER_CAPABILITY_MISSING");
      continue;
    }
    contributing.push(assertion.assertionHash);
  }
  if (contributing.length === 0) return build("insufficient", [...reasons], []);
  return build("satisfied", ["POLICY_SATISFIED"], contributing);
}

function aggregateVerdict(
  evaluations: readonly ChangeAuthorizationPolicyEvaluationV1[],
  basisStatus: "REALIZED" | "VIOLATED" | "UNPROVEN",
): { verdict: ChangeAuthorizationVerdictV1; reasonCodes: readonly ChangeAuthorizationReasonCodeV1[] } {
  const ruleRank = Math.min(...evaluations.map((evaluation) => outcomeRank(evaluation.outcome)));
  const basisCeiling = basisStatus === "VIOLATED" ? 0 : basisStatus === "UNPROVEN" ? 1 : 2;
  const rank = Math.min(ruleRank, basisCeiling);
  const verdict = ([...(["DENY", "REQUIRE_EVIDENCE", "ALLOW"] as const)])
    .find((candidate) => CHANGE_AUTHORIZATION_VERDICT_RANK[candidate] === rank)!;
  const reasons = new Set<ChangeAuthorizationReasonCodeV1>();
  for (const evaluation of evaluations) {
    if (evaluation.outcome !== "satisfied") for (const reason of evaluation.reasonCodes) reasons.add(reason);
  }
  if (basisStatus !== "REALIZED") reasons.add("OPEN_UNKNOWN");
  if (basisStatus === "VIOLATED") reasons.add("INVARIANT_VIOLATED");
  if (reasons.size === 0) reasons.add("POLICY_SATISFIED");
  return { verdict, reasonCodes: canonicalizeChangeAuthorizationReasons([...reasons]) };
}

function outcomeRank(outcome: ChangeAuthorizationRuleOutcomeV1): number {
  return outcome === "violated" ? 0 : outcome === "insufficient" ? 1 : 2;
}
