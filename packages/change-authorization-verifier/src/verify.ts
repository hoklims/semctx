/**
 * HOK-91: verify a sealed ChangeAuthorizationCapsuleV1 outside the process and host that produced
 * it. Purely read-only: this module never mutates a target repository, Git, `.semctx/`, a trust
 * registry, or any external system, and grants no execution authority.
 */
import {
  ChangeAuthorizationCapsuleV1Schema,
  compareCodeUnits,
  type ChangeAuthorizationCapsuleV1,
  type ChangeAuthorizationReasonCodeV1,
  type ChangeAuthorizationVerdictV1,
} from "@semantic-context/control-model";
import { computeChangeAuthorizationVerificationReportV1Hash } from "./canonical";
import { deriveChangeAuthorizationVerificationDecisionV1, projectSubjectIndependentlyV1 } from "./derive";
import {
  canonicalOrder,
  resolveAuthorityOutcomeV1,
  resolveOverallResultV1,
  resolveReportReasonCodesV1,
  resolveSemanticReasonsV1,
} from "./precedence";
import { ChangeAuthorizationVerificationRequestV1Schema } from "./schemas";
import {
  CHANGE_AUTHORIZATION_VERIFICATION_INTEGRITY_REASONS,
  type ChangeAuthorizationVerificationAuthorityReportV1,
  type ChangeAuthorizationVerificationIntegrityReasonV1,
  type ChangeAuthorizationVerificationIntegrityReportV1,
  type ChangeAuthorizationVerificationReportV1,
  type ChangeAuthorizationVerificationRequestV1,
  type ChangeAuthorizationVerificationSemanticReportV1,
} from "./types";

/**
 * Verifies a capsule against:
 * 1. its own historical self-consistency, re-derived independently at `capsule.evaluatedAt`
 *    (`integrity`);
 * 2. an authority digest sourced outside the capsule (`authority`);
 * 3. the capsule's own sealed evidence, re-derived independently at `request.verifiedAt` instead of
 *    `capsule.evaluatedAt` (`semantic`) — only the clock moves, so this can surface an assertion or
 *    provider snapshot that has since expired against its own recorded `expiresAt`, never a
 *    provider status learned after sealing.
 *
 * Precedence (never an implicit promotion): integrity invalid, or the authority digest diverges,
 * or either the recorded/current decision is DENY -> FAILED. Otherwise an absent expected digest,
 * or either decision is REQUIRE_EVIDENCE -> REQUIRE_EVIDENCE. Only ALLOW -> ALLOW can PASS.
 */
export function verifyChangeAuthorizationCapsuleV1(
  request: ChangeAuthorizationVerificationRequestV1,
): ChangeAuthorizationVerificationReportV1 {
  assertRequestEnvelope(request);

  const capsuleParse = ChangeAuthorizationCapsuleV1Schema.safeParse(request.capsule);
  const integrityReasons: ChangeAuthorizationVerificationIntegrityReasonV1[] = [];
  let sealed: ChangeAuthorizationCapsuleV1 | undefined;

  if (!capsuleParse.success) {
    integrityReasons.push("CAPSULE_SCHEMA_INVALID");
  } else {
    sealed = capsuleParse.data as ChangeAuthorizationCapsuleV1;

    const rederivedSubject = projectSubjectIndependentlyV1(sealed.basis.record);
    if (rederivedSubject.subjectHash !== sealed.subject.subjectHash) {
      integrityReasons.push("SUBJECT_REDERIVATION_MISMATCH");
    }

    const historical = deriveChangeAuthorizationVerificationDecisionV1({
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

    const historicalEvaluationHashes = historical.policyEvaluations
      .map((evaluation) => evaluation.evaluationHash)
      .sort(compareCodeUnits);
    const sealedEvaluationHashes = sealed.policyEvaluations
      .map((evaluation) => evaluation.evaluationHash)
      .sort(compareCodeUnits);
    if (JSON.stringify(historicalEvaluationHashes) !== JSON.stringify(sealedEvaluationHashes)) {
      integrityReasons.push("POLICY_EVALUATION_REDERIVATION_MISMATCH");
    }
    if (historical.verdict !== sealed.verdict) integrityReasons.push("VERDICT_REDERIVATION_MISMATCH");
    if (JSON.stringify(historical.reasonCodes) !== JSON.stringify(sealed.reasonCodes)) {
      integrityReasons.push("REASON_CODES_REDERIVATION_MISMATCH");
    }
    if (historical.evidenceUniverse.universeHash !== sealed.evidenceUniverse.universeHash) {
      integrityReasons.push("EVIDENCE_UNIVERSE_REDERIVATION_MISMATCH");
    }
    if (historical.authorityDescriptor.descriptorDigest !== sealed.authorityDescriptor.descriptorDigest) {
      integrityReasons.push("AUTHORITY_DESCRIPTOR_REDERIVATION_MISMATCH");
    }
  }

  const integrity: ChangeAuthorizationVerificationIntegrityReportV1 = {
    schemaVersion: 1,
    result: integrityReasons.length === 0 ? "VALID" : "INVALID",
    reasons: canonicalOrder(integrityReasons, CHANGE_AUTHORIZATION_VERIFICATION_INTEGRITY_REASONS),
  };

  const authority = buildAuthorityReport(request, sealed);
  const semantic = buildSemanticReport(request, sealed);

  const result = resolveOverallResultV1({
    integrityResult: integrity.result,
    authorityResult: authority.result,
    recordedVerdict: semantic.recordedVerdict,
    currentVerdict: semantic.currentVerdict,
  });
  const reasonCodes = resolveReportReasonCodesV1(integrity.reasons, authority.reasons, semantic.reasons);

  const payload: Omit<ChangeAuthorizationVerificationReportV1, "reportHash"> = {
    schemaVersion: 1,
    kind: "change_authorization_verification_report",
    verifierId: "semctx-change-authorization-verifier",
    verifierVersion: "1.0.0",
    executionAuthority: "none",
    enforcementMode: "shadow",
    blockingEnabled: false,
    authorizationEffect: "advisory_verification",
    result,
    reasonCodes,
    integrity,
    authority,
    semantic,
    subjectChangeId: sealed?.subject.changeId ?? null,
    subjectHash: sealed?.subject.subjectHash ?? null,
    capsuleHash: sealed?.capsuleHash ?? null,
    verifiedAt: request.verifiedAt,
  };
  return { ...payload, reportHash: computeChangeAuthorizationVerificationReportV1Hash(payload) };
}

function assertRequestEnvelope(request: ChangeAuthorizationVerificationRequestV1): void {
  const parsed = ChangeAuthorizationVerificationRequestV1Schema.safeParse(request);
  if (!parsed.success) {
    throw new Error(
      `change authorization verification request failed its public schema: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
}

function buildAuthorityReport(
  request: ChangeAuthorizationVerificationRequestV1,
  sealed: ChangeAuthorizationCapsuleV1 | undefined,
): ChangeAuthorizationVerificationAuthorityReportV1 {
  const recordedAuthorityDescriptorDigest = sealed?.authorityDescriptor.descriptorDigest ?? null;
  const { result, reasons } = resolveAuthorityOutcomeV1(
    request.expectedAuthorityDescriptorDigest,
    recordedAuthorityDescriptorDigest,
  );
  return {
    schemaVersion: 1,
    expectedAuthorityDescriptorDigest: request.expectedAuthorityDescriptorDigest,
    recordedAuthorityDescriptorDigest,
    result,
    reasons,
  };
}

function buildSemanticReport(
  request: ChangeAuthorizationVerificationRequestV1,
  sealed: ChangeAuthorizationCapsuleV1 | undefined,
): ChangeAuthorizationVerificationSemanticReportV1 {
  let currentVerdict: ChangeAuthorizationVerdictV1 | null = null;
  let currentReasonCodes: readonly ChangeAuthorizationReasonCodeV1[] = [];
  if (sealed !== undefined) {
    const current = deriveChangeAuthorizationVerificationDecisionV1({
      providers: sealed.providers,
      assertions: sealed.assertions,
      evidenceBundles: sealed.evidenceBundles,
      policyRules: sealed.policyRules,
      trustRootIds: sealed.authorityDescriptor.trustRootIds,
      policyDescriptor: sealed.authorityDescriptor.policy,
      trustPolicyDescriptor: sealed.authorityDescriptor.trustPolicy,
      basisReconciliationTerminalStatus: sealed.basis.record.capsule.reconciliationTerminalStatus,
      evaluatedAt: request.verifiedAt,
    });
    currentVerdict = current.verdict;
    currentReasonCodes = current.reasonCodes;
  }
  return {
    schemaVersion: 1,
    recordedVerdict: sealed?.verdict ?? null,
    recordedEvaluatedAt: sealed?.evaluatedAt ?? null,
    recordedReasonCodes: sealed?.reasonCodes ?? [],
    currentVerdict,
    currentEvaluatedAt: request.verifiedAt,
    currentReasonCodes,
    reasons: resolveSemanticReasonsV1(sealed?.verdict ?? null, currentVerdict),
  };
}
