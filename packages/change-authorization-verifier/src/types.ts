/**
 * HOK-91: offline, host-independent verification of a sealed ChangeAuthorizationCapsuleV1.
 * This surface never grants execution authority; it reports a read-only verification verdict.
 */
import type {
  ChangeAuthorizationReasonCodeV1,
  ChangeAuthorizationVerdictV1,
  Sha256Hash,
} from "@semantic-context/control-model";

export const CHANGE_AUTHORIZATION_VERIFICATION_RESULTS = ["PASSED", "FAILED", "REQUIRE_EVIDENCE"] as const;
export type ChangeAuthorizationVerificationResultV1 = typeof CHANGE_AUTHORIZATION_VERIFICATION_RESULTS[number];

export const CHANGE_AUTHORIZATION_VERIFICATION_INTEGRITY_RESULTS = ["VALID", "INVALID"] as const;
export type ChangeAuthorizationVerificationIntegrityResultV1 =
  typeof CHANGE_AUTHORIZATION_VERIFICATION_INTEGRITY_RESULTS[number];

export const CHANGE_AUTHORIZATION_VERIFICATION_AUTHORITY_RESULTS = ["MATCHED", "MISMATCHED", "UNKNOWN"] as const;
export type ChangeAuthorizationVerificationAuthorityResultV1 =
  typeof CHANGE_AUTHORIZATION_VERIFICATION_AUTHORITY_RESULTS[number];

/** Structural, authenticity, or historical-rederivation failure; catches a self-consistent but hand-forged capsule. */
export const CHANGE_AUTHORIZATION_VERIFICATION_INTEGRITY_REASONS = [
  "CAPSULE_SCHEMA_INVALID",
  "SUBJECT_REDERIVATION_MISMATCH",
  "POLICY_EVALUATION_REDERIVATION_MISMATCH",
  "VERDICT_REDERIVATION_MISMATCH",
  "REASON_CODES_REDERIVATION_MISMATCH",
  "EVIDENCE_UNIVERSE_REDERIVATION_MISMATCH",
  "AUTHORITY_DESCRIPTOR_REDERIVATION_MISMATCH",
] as const;
export type ChangeAuthorizationVerificationIntegrityReasonV1 =
  typeof CHANGE_AUTHORIZATION_VERIFICATION_INTEGRITY_REASONS[number];

/** Whether the capsule's own authority descriptor matches a digest sourced outside the capsule. */
export const CHANGE_AUTHORIZATION_VERIFICATION_AUTHORITY_REASONS = [
  "EXPECTED_AUTHORITY_DIGEST_ABSENT",
  "EXPECTED_AUTHORITY_DIGEST_MISMATCH",
] as const;
export type ChangeAuthorizationVerificationAuthorityReasonV1 =
  typeof CHANGE_AUTHORIZATION_VERIFICATION_AUTHORITY_REASONS[number];

/** Whether re-evaluating the capsule's own declared evidence at `verifiedAt` still supports the recorded verdict. */
export const CHANGE_AUTHORIZATION_VERIFICATION_SEMANTIC_REASONS = [
  "RECORDED_DECISION_DENY",
  "RECORDED_DECISION_REQUIRE_EVIDENCE",
  "CURRENT_DECISION_DENY",
  "CURRENT_DECISION_REQUIRE_EVIDENCE",
] as const;
export type ChangeAuthorizationVerificationSemanticReasonV1 =
  typeof CHANGE_AUTHORIZATION_VERIFICATION_SEMANTIC_REASONS[number];

export const CHANGE_AUTHORIZATION_VERIFICATION_REASON_CODES = [
  "VERIFICATION_PASSED",
  ...CHANGE_AUTHORIZATION_VERIFICATION_INTEGRITY_REASONS,
  ...CHANGE_AUTHORIZATION_VERIFICATION_AUTHORITY_REASONS,
  ...CHANGE_AUTHORIZATION_VERIFICATION_SEMANTIC_REASONS,
] as const;
export type ChangeAuthorizationVerificationReasonCodeV1 =
  typeof CHANGE_AUTHORIZATION_VERIFICATION_REASON_CODES[number];

/** Public request: the capsule is `unknown` because it is untrusted input from outside this process. */
export interface ChangeAuthorizationVerificationRequestV1 {
  schemaVersion: 1;
  capsule: unknown;
  /** Sourced independently of the capsule; `null` means the caller holds no external authority pin. */
  expectedAuthorityDescriptorDigest: Sha256Hash | null;
  verifiedAt: string;
}

export interface ChangeAuthorizationVerificationIntegrityReportV1 {
  schemaVersion: 1;
  result: ChangeAuthorizationVerificationIntegrityResultV1;
  reasons: readonly ChangeAuthorizationVerificationIntegrityReasonV1[];
}

export interface ChangeAuthorizationVerificationAuthorityReportV1 {
  schemaVersion: 1;
  expectedAuthorityDescriptorDigest: Sha256Hash | null;
  recordedAuthorityDescriptorDigest: Sha256Hash | null;
  result: ChangeAuthorizationVerificationAuthorityResultV1;
  reasons: readonly ChangeAuthorizationVerificationAuthorityReasonV1[];
}

export interface ChangeAuthorizationVerificationSemanticReportV1 {
  schemaVersion: 1;
  recordedVerdict: ChangeAuthorizationVerdictV1 | null;
  recordedEvaluatedAt: string | null;
  recordedReasonCodes: readonly ChangeAuthorizationReasonCodeV1[];
  currentVerdict: ChangeAuthorizationVerdictV1 | null;
  currentEvaluatedAt: string;
  currentReasonCodes: readonly ChangeAuthorizationReasonCodeV1[];
  reasons: readonly ChangeAuthorizationVerificationSemanticReasonV1[];
}

export interface ChangeAuthorizationVerificationReportV1 {
  schemaVersion: 1;
  kind: "change_authorization_verification_report";
  verifierId: "semctx-change-authorization-verifier";
  verifierVersion: "1.0.0";
  executionAuthority: "none";
  enforcementMode: "shadow";
  blockingEnabled: false;
  authorizationEffect: "advisory_verification";
  result: ChangeAuthorizationVerificationResultV1;
  reasonCodes: readonly ChangeAuthorizationVerificationReasonCodeV1[];
  integrity: ChangeAuthorizationVerificationIntegrityReportV1;
  authority: ChangeAuthorizationVerificationAuthorityReportV1;
  semantic: ChangeAuthorizationVerificationSemanticReportV1;
  subjectChangeId: string | null;
  subjectHash: Sha256Hash | null;
  capsuleHash: Sha256Hash | null;
  verifiedAt: string;
  reportHash: Sha256Hash;
}
