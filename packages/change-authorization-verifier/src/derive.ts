/**
 * Independent re-derivation of a ChangeAuthorizationCapsuleV1's policy verdict.
 *
 * This module intentionally does NOT import `@semantic-context/control-engine`. It reimplements
 * the normative algorithm from docs/architecture/change-authorization-v1.md directly against the
 * public `@semantic-context/control-model` contract, so that a verifier running outside the host
 * and process that produced a capsule can independently confirm (or refute) its verdict — a bug or
 * a forgery in the engine that produced the capsule does not propagate silently into this check.
 */
import {
  compareCodeUnits,
  computeChangeAuthorizationAuthorityDescriptorV1Hash,
  computeChangeAuthorizationEvidenceUniverseV1Hash,
  computeChangeAuthorizationPolicyEvaluationV1Hash,
  computeChangeAuthorizationPolicyRuleSetV1Hash,
  computeChangeAuthorizationSubjectV1Hash,
  computeChangeAuthorizationTrustRootSetV1Hash,
  canonicalizeChangeAuthorizationReasons,
  type ChangeAuthorizationAssertionV1,
  type ChangeAuthorizationAuthorityDescriptorV1,
  type ChangeAuthorizationEvidenceBundleV1,
  type ChangeAuthorizationEvidenceUniverseV1,
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
  type Sha256Hash,
} from "@semantic-context/control-model";

const VERDICT_RANK: Readonly<Record<ChangeAuthorizationVerdictV1, number>> = {
  DENY: 0,
  REQUIRE_EVIDENCE: 1,
  ALLOW: 2,
};
const VERDICT_BY_RANK: readonly ChangeAuthorizationVerdictV1[] = ["DENY", "REQUIRE_EVIDENCE", "ALLOW"];

/** Independent projection of the change-authorization subject from a basis ControlHandoffRecordV2. */
export function projectSubjectIndependentlyV1(record: ControlHandoffRecordV2): ChangeAuthorizationSubjectV1 {
  const taskEnvelope = record.request.planningBundle.taskEnvelope;
  const basisCapsule = record.capsule;
  const payload: Omit<ChangeAuthorizationSubjectV1, "subjectHash"> = {
    schemaVersion: 1,
    changeId: taskEnvelope.changeId,
    changeContractHash: taskEnvelope.changeContractHash,
    parentIntentIds: taskEnvelope.parentIntentIds,
    nonGoals: taskEnvelope.nonGoals,
    expectedBehaviorDelta: taskEnvelope.expectedBehaviorDelta,
    declaredReconciliationScope: taskEnvelope.declaredReconciliationScope,
    planningCommit: taskEnvelope.planningCommit,
    observedCommit: basisCapsule.observedCommit,
    observedWorkingDiffHash: basisCapsule.observedWorkingDiffHash,
    touchedCoordinateIds: basisCapsule.touchedCoordinateIds,
    reconciliationTerminalStatus: basisCapsule.reconciliationTerminalStatus,
    reconciliationReasonCodes: basisCapsule.reconciliationReasonCodes,
  };
  return { ...payload, subjectHash: computeChangeAuthorizationSubjectV1Hash(payload) };
}

export interface ChangeAuthorizationVerificationDerivationInputV1 {
  providers: readonly ChangeAuthorizationProviderV1[];
  assertions: readonly ChangeAuthorizationAssertionV1[];
  evidenceBundles: readonly ChangeAuthorizationEvidenceBundleV1[];
  policyRules: readonly ChangeAuthorizationPolicyRuleV1[];
  trustRootIds: readonly string[];
  policyDescriptor: ChangeAuthorizationPolicyDescriptorV1;
  trustPolicyDescriptor: ChangeAuthorizationTrustPolicyDescriptorV1;
  basisReconciliationTerminalStatus: "REALIZED" | "VIOLATED" | "UNPROVEN";
  /** The single clock input; never ambient. Historical replay uses `capsule.evaluatedAt`, the
   *  current decision uses `request.verifiedAt`. */
  evaluatedAt: string;
}

export interface ChangeAuthorizationVerificationDerivationV1 {
  policyEvaluations: readonly ChangeAuthorizationPolicyEvaluationV1[];
  verdict: ChangeAuthorizationVerdictV1;
  reasonCodes: readonly ChangeAuthorizationReasonCodeV1[];
  evidenceUniverse: ChangeAuthorizationEvidenceUniverseV1;
  authorityDescriptor: ChangeAuthorizationAuthorityDescriptorV1;
}

/** Re-derives policyEvaluations/verdict/reasonCodes/evidenceUniverse/authorityDescriptor at one clock instant. */
export function deriveChangeAuthorizationVerificationDecisionV1(
  input: ChangeAuthorizationVerificationDerivationInputV1,
): ChangeAuthorizationVerificationDerivationV1 {
  const assertionsByHash = new Map(input.assertions.map((assertion) => [assertion.assertionHash, assertion]));
  const providersById = new Map(input.providers.map((provider) => [provider.providerId, provider]));
  const bundleByRuleId = new Map(input.evidenceBundles.map((bundle) => [bundle.ruleId, bundle]));
  const trustedRootIds = new Set(input.trustRootIds);

  const policyEvaluations = input.policyRules
    .map((rule) => evaluatePolicyRule(
      rule,
      bundleByRuleId.get(rule.ruleId),
      assertionsByHash,
      providersById,
      trustedRootIds,
      input.evaluatedAt,
    ))
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

  const sortedTrustRootIds = [...trustedRootIds].sort(compareCodeUnits);
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

function evaluatePolicyRule(
  rule: ChangeAuthorizationPolicyRuleV1,
  bundle: ChangeAuthorizationEvidenceBundleV1 | undefined,
  assertionsByHash: ReadonlyMap<Sha256Hash, ChangeAuthorizationAssertionV1>,
  providersById: ReadonlyMap<string, ChangeAuthorizationProviderV1>,
  trustedRootIds: ReadonlySet<string>,
  evaluatedAt: string,
): ChangeAuthorizationPolicyEvaluationV1 {
  const seal = (
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
    return { ...payload, evaluationHash: computeChangeAuthorizationPolicyEvaluationV1Hash(payload) };
  };

  if (bundle === undefined) return seal("insufficient", ["REQUIRED_EVIDENCE_MISSING"], []);

  const offered = bundle.assertionHashes.map((hash) => assertionsByHash.get(hash)!);

  if (offered.some((assertion) => assertion.modality === "APPROXIMATED" || assertion.modality === "UNKNOWN")) {
    return seal("violated", ["POLICY_RULE_VIOLATED"], []);
  }
  if (rule.scopeCoordinateIds !== undefined) {
    const allowedScope = new Set(rule.scopeCoordinateIds);
    if (offered.some((assertion) => assertion.scope.coordinateIds.some((id) => !allowedScope.has(id)))) {
      return seal("violated", ["SCOPE_EXCEEDED"], []);
    }
  }
  const offeredHashes = new Set(bundle.assertionHashes);
  if (offered.some((assertion) => assertion.contradicts.some((hash) => offeredHashes.has(hash)))) {
    return seal("violated", ["EVIDENCE_CONTRADICTED"], []);
  }
  if (offered.some((assertion) => assertion.claimHash === rule.requiredClaimHash && assertion.conclusion === "CONTRADICTS")) {
    return seal("violated", ["REQUIRED_CLAIM_CONTRADICTED"], []);
  }

  const collectedReasons = new Set<ChangeAuthorizationReasonCodeV1>();
  const contributing: Sha256Hash[] = [];
  for (const assertion of offered) {
    if (assertion.claimHash !== rule.requiredClaimHash) {
      collectedReasons.add("REQUIRED_CLAIM_UNBOUND");
      continue;
    }
    if (assertion.conclusion === "INCONCLUSIVE") {
      collectedReasons.add("REQUIRED_CLAIM_INCONCLUSIVE");
      continue;
    }
    const provider = providersById.get(assertion.providerId);
    if (provider === undefined) {
      collectedReasons.add("REQUIRED_EVIDENCE_UNBOUND");
      continue;
    }
    if (!rule.allowedModalities.includes(assertion.modality)) {
      collectedReasons.add("REQUIRED_EVIDENCE_MODALITY_INSUFFICIENT");
      continue;
    }
    if (Date.parse(assertion.observedAt) > Date.parse(evaluatedAt) || Date.parse(evaluatedAt) > Date.parse(assertion.expiresAt)) {
      collectedReasons.add("REQUIRED_EVIDENCE_EXPIRED");
      continue;
    }
    if (provider.status === "UNTRUSTED") {
      collectedReasons.add("PROVIDER_CAPABILITY_UNTRUSTED");
      continue;
    }
    if (provider.status === "UNAVAILABLE") {
      collectedReasons.add("PROVIDER_CAPABILITY_MISSING");
      continue;
    }
    if (provider.status === "DEGRADED") {
      collectedReasons.add("PROVIDER_CAPABILITY_DEGRADED");
      continue;
    }
    if (Date.parse(provider.observedAt) > Date.parse(evaluatedAt) || Date.parse(evaluatedAt) > Date.parse(provider.expiresAt)) {
      collectedReasons.add("SOURCE_SEAL_STALE");
      continue;
    }
    if (!trustedRootIds.has(provider.trustRootId)) {
      collectedReasons.add("TRUST_ROOT_UNAVAILABLE");
      continue;
    }
    if (rule.requiredCapability !== undefined && !provider.capabilities.includes(rule.requiredCapability)) {
      collectedReasons.add("PROVIDER_CAPABILITY_MISSING");
      continue;
    }
    contributing.push(assertion.assertionHash);
  }
  if (contributing.length === 0) return seal("insufficient", [...collectedReasons], []);
  return seal("satisfied", ["POLICY_SATISFIED"], contributing);
}

function aggregateVerdict(
  evaluations: readonly ChangeAuthorizationPolicyEvaluationV1[],
  basisReconciliationTerminalStatus: "REALIZED" | "VIOLATED" | "UNPROVEN",
): { verdict: ChangeAuthorizationVerdictV1; reasonCodes: readonly ChangeAuthorizationReasonCodeV1[] } {
  const ruleRank = Math.min(...evaluations.map((evaluation) => outcomeRank(evaluation.outcome)));
  const basisCeiling = basisReconciliationTerminalStatus === "VIOLATED"
    ? 0
    : basisReconciliationTerminalStatus === "UNPROVEN"
      ? 1
      : 2;
  const rank = Math.min(ruleRank, basisCeiling);
  const verdict = VERDICT_BY_RANK.find((candidate) => VERDICT_RANK[candidate] === rank)!;

  const reasons = new Set<ChangeAuthorizationReasonCodeV1>();
  for (const evaluation of evaluations) {
    if (evaluation.outcome !== "satisfied") {
      for (const reason of evaluation.reasonCodes) reasons.add(reason);
    }
  }
  if (basisReconciliationTerminalStatus !== "REALIZED") reasons.add("OPEN_UNKNOWN");
  if (basisReconciliationTerminalStatus === "VIOLATED") reasons.add("INVARIANT_VIOLATED");
  if (reasons.size === 0) reasons.add("POLICY_SATISFIED");
  return { verdict, reasonCodes: canonicalizeChangeAuthorizationReasons([...reasons]) };
}

function outcomeRank(outcome: ChangeAuthorizationRuleOutcomeV1): number {
  return outcome === "violated" ? 0 : outcome === "insufficient" ? 1 : 2;
}
