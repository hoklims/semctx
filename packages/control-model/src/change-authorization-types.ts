/**
 * ChangeAuthorizationCapsuleV1 (HOK-89): a read-only, replayable change-authorization record.
 * It never grants execution or write authority; `verdict` is a descriptive report.
 */

import type { EvidenceRefV1 } from "./refinement";
import type {
  ControlHandoffRecordV2,
  ControlHandoffReconciliationReasonCodeV2,
} from "./control-handoff";
import type { DeclaredReconciliationScopeV1 } from "./task-envelope-types";
import type { QualifiedCoordinateId, Sha256Hash } from "./types";

/** Distinguishes formal/mechanical proof from human approval, attestation, approximation, and the unknown. */
export const CHANGE_AUTHORIZATION_MODALITIES = [
  "FORMALLY_PROVED",
  "STATICALLY_VERIFIED",
  "TEST_OBSERVED",
  "RUNTIME_OBSERVED",
  "HUMAN_APPROVED",
  "ATTESTED",
  "APPROXIMATED",
  "UNKNOWN",
] as const;
export type ChangeAuthorizationModalityV1 = typeof CHANGE_AUTHORIZATION_MODALITIES[number];

/** These two modalities can never satisfy any policy rule; no rule may allowlist them. */
export const CHANGE_AUTHORIZATION_NEVER_ALLOWLISTABLE_MODALITIES = [
  "APPROXIMATED",
  "UNKNOWN",
] as const satisfies readonly ChangeAuthorizationModalityV1[];

export const CHANGE_AUTHORIZATION_PROVIDER_STATUSES = [
  "AVAILABLE",
  "DEGRADED",
  "UNAVAILABLE",
  "UNTRUSTED",
] as const;
export type ChangeAuthorizationProviderStatusV1 = typeof CHANGE_AUTHORIZATION_PROVIDER_STATUSES[number];

export type ChangeAuthorizationVerdictV1 = "ALLOW" | "DENY" | "REQUIRE_EVIDENCE";

/** DENY outranks REQUIRE_EVIDENCE outranks ALLOW; a lower rank can never be produced by removing or degrading evidence. */
export const CHANGE_AUTHORIZATION_VERDICT_RANK: Readonly<Record<ChangeAuthorizationVerdictV1, number>> = {
  DENY: 0,
  REQUIRE_EVIDENCE: 1,
  ALLOW: 2,
};

/** Closed conclusion of an assertion with respect to the single claim it addresses. */
export const CHANGE_AUTHORIZATION_CONCLUSIONS = ["SUPPORTS", "CONTRADICTS", "INCONCLUSIVE"] as const;
export type ChangeAuthorizationConclusionV1 = typeof CHANGE_AUTHORIZATION_CONCLUSIONS[number];

export const CHANGE_AUTHORIZATION_POSITIVE_REASONS = ["POLICY_SATISFIED"] as const;
export const CHANGE_AUTHORIZATION_VIOLATION_REASONS = [
  "POLICY_RULE_VIOLATED",
  "SCOPE_EXCEEDED",
  "EVIDENCE_CONTRADICTED",
  "REQUIRED_CLAIM_CONTRADICTED",
  "INVARIANT_VIOLATED",
] as const;
export const CHANGE_AUTHORIZATION_INSUFFICIENCY_REASONS = [
  "REQUIRED_EVIDENCE_MISSING",
  "REQUIRED_EVIDENCE_EXPIRED",
  "REQUIRED_EVIDENCE_UNBOUND",
  "REQUIRED_EVIDENCE_MODALITY_INSUFFICIENT",
  "REQUIRED_CLAIM_UNBOUND",
  "REQUIRED_CLAIM_INCONCLUSIVE",
  "PROVIDER_CAPABILITY_MISSING",
  "PROVIDER_CAPABILITY_DEGRADED",
  "PROVIDER_CAPABILITY_UNTRUSTED",
  "OPEN_UNKNOWN",
  "SOURCE_SEAL_STALE",
  "TRUST_ROOT_UNAVAILABLE",
  "CLOCK_UNAVAILABLE",
] as const;
export const CHANGE_AUTHORIZATION_REASON_ORDER = [
  ...CHANGE_AUTHORIZATION_POSITIVE_REASONS,
  ...CHANGE_AUTHORIZATION_VIOLATION_REASONS,
  ...CHANGE_AUTHORIZATION_INSUFFICIENCY_REASONS,
] as const;
export type ChangeAuthorizationReasonCodeV1 = typeof CHANGE_AUTHORIZATION_REASON_ORDER[number];

/** Exact projection of the basis ControlHandoffRecordV2; any divergent projection invalidates the capsule. */
export interface ChangeAuthorizationSubjectV1 {
  schemaVersion: 1;
  changeId: string;
  changeContractHash: Sha256Hash;
  parentIntentIds: readonly string[];
  nonGoals: readonly string[];
  expectedBehaviorDelta: readonly string[];
  declaredReconciliationScope: DeclaredReconciliationScopeV1;
  planningCommit: string;
  observedCommit: string;
  observedWorkingDiffHash: Sha256Hash;
  touchedCoordinateIds: readonly QualifiedCoordinateId[];
  reconciliationTerminalStatus: "REALIZED" | "VIOLATED" | "UNPROVEN";
  reconciliationReasonCodes: readonly ControlHandoffReconciliationReasonCodeV2[];
  subjectHash: Sha256Hash;
}

export interface ChangeAuthorizationProviderV1 {
  schemaVersion: 1;
  providerId: string;
  kind: string;
  version: string;
  digest: Sha256Hash;
  status: ChangeAuthorizationProviderStatusV1;
  capabilities: readonly string[];
  observedAt: string;
  expiresAt: string;
  trustRootId: string;
}

export interface ChangeAuthorizationEvidenceScopeV1 {
  schemaVersion: 1;
  coordinateIds: readonly QualifiedCoordinateId[];
}

/**
 * A machine-verifiable claim about the subject under authorization. Every assertion and every
 * policy rule binds to a claim by its content hash, never by free text: `kind` closes the claim
 * to exactly what modality of evidence may address it (see `requiredClaimKindForModality`).
 */
export type ChangeAuthorizationClaimSubjectV1 =
  | { kind: "CHANGE_REQUIREMENT"; changeId: string; requirementId: string }
  | { kind: "HUMAN_APPROVAL"; changeId: string; approverRole: string }
  | { kind: "ASSERTION_AUTHENTICITY"; changeId: string; producerId: string };

export type ChangeAuthorizationClaimKindV1 = ChangeAuthorizationClaimSubjectV1["kind"];

export const CHANGE_AUTHORIZATION_CLAIM_KINDS = [
  "CHANGE_REQUIREMENT",
  "HUMAN_APPROVAL",
  "ASSERTION_AUTHENTICITY",
] as const satisfies readonly ChangeAuthorizationClaimKindV1[];

export interface ChangeAuthorizationClaimV1 {
  schemaVersion: 1;
  claimId: string;
  statement: string;
  subject: ChangeAuthorizationClaimSubjectV1;
  claimHash: Sha256Hash;
}

/**
 * The only claim kind a given modality may address. `HUMAN_APPROVED` and `ATTESTED` are narrowed
 * to their matching claim kind; every other modality may only address a `CHANGE_REQUIREMENT`
 * claim. This closes the "unrelated claim" forgery: an assertion cannot borrow a modality that
 * does not match what it is claiming to prove.
 */
export function requiredClaimKindForModality(
  modality: ChangeAuthorizationModalityV1,
): ChangeAuthorizationClaimKindV1 {
  if (modality === "HUMAN_APPROVED") return "HUMAN_APPROVAL";
  if (modality === "ATTESTED") return "ASSERTION_AUTHENTICITY";
  return "CHANGE_REQUIREMENT";
}

export interface ChangeAuthorizationAssertionV1 {
  schemaVersion: 1;
  assertionId: string;
  /** The single claim this assertion addresses; contribution requires an exact match to a rule's `requiredClaimHash`. */
  claimHash: Sha256Hash;
  /** Closed conclusion with respect to `claimHash`; never free text. */
  conclusion: ChangeAuthorizationConclusionV1;
  modality: ChangeAuthorizationModalityV1;
  producerId: string;
  producerVersion: string;
  sourceCommit: string;
  sourceDiffHash: Sha256Hash;
  methodName: string;
  methodParameters: Record<string, unknown>;
  scope: ChangeAuthorizationEvidenceScopeV1;
  observedAt: string;
  expiresAt: string;
  providerId: string;
  artifacts: readonly EvidenceRefV1[];
  dependsOnAssertionHashes: readonly Sha256Hash[];
  contradicts: readonly Sha256Hash[];
  assertionHash: Sha256Hash;
}

export interface ChangeAuthorizationEvidenceBundleV1 {
  schemaVersion: 1;
  bundleId: string;
  ruleId: string;
  assertionHashes: readonly Sha256Hash[];
  bundleHash: Sha256Hash;
}

/** The exact evidence considered by an evaluation; two capsules are monotonicity-comparable only when their universe hashes match. */
export interface ChangeAuthorizationEvidenceUniverseV1 {
  schemaVersion: 1;
  assertionHashes: readonly Sha256Hash[];
  bundleHashes: readonly Sha256Hash[];
  universeHash: Sha256Hash;
}

export interface ChangeAuthorizationPolicyRuleV1 {
  schemaVersion: 1;
  ruleId: string;
  description: string;
  /** The claim this rule requires to be SUPPORTS-contributed; the sole binding between a rule and its evidence's meaning. */
  requiredClaimHash: Sha256Hash;
  allowedModalities: readonly ChangeAuthorizationModalityV1[];
  /** Narrows this rule's admissible evidence to a subset of the basis touched coordinates. */
  scopeCoordinateIds?: readonly QualifiedCoordinateId[];
  requiredCapability?: string;
}

export type ChangeAuthorizationRuleOutcomeV1 = "satisfied" | "insufficient" | "violated";

export interface ChangeAuthorizationPolicyEvaluationV1 {
  schemaVersion: 1;
  ruleId: string;
  outcome: ChangeAuthorizationRuleOutcomeV1;
  reasonCodes: readonly ChangeAuthorizationReasonCodeV1[];
  contributingAssertionHashes: readonly Sha256Hash[];
  evaluationHash: Sha256Hash;
}

export interface ChangeAuthorizationPolicyDescriptorV1 {
  schemaVersion: 1;
  policyId: string;
  policyVersion: string;
  policyUri: string;
}

export interface ChangeAuthorizationTrustPolicyDescriptorV1 {
  schemaVersion: 1;
  trustPolicyId: string;
  trustPolicyVersion: string;
}

/**
 * Pins the policy and trust-root snapshot the verdict was evaluated against, hashed and outside
 * the capsule's own self-consistency loop: a verifier compares `descriptorDigest` to an
 * independently held `expectedAuthorityDescriptorDigest`, so a capsule that recomputes every
 * internal hash correctly but substitutes a different policy or trust-root set is still caught.
 * This is a digested evaluation of a caller-supplied snapshot, not a live authority query.
 */
export interface ChangeAuthorizationAuthorityDescriptorV1 {
  schemaVersion: 1;
  policy: ChangeAuthorizationPolicyDescriptorV1;
  policyRulesHash: Sha256Hash;
  trustPolicy: ChangeAuthorizationTrustPolicyDescriptorV1;
  trustRootIds: readonly string[];
  trustedRootSetHash: Sha256Hash;
  descriptorDigest: Sha256Hash;
}

export interface ChangeAuthorizationCapsuleV1 {
  schemaVersion: 1;
  kind: "change_authorization_capsule";
  executionAuthority: "none";
  enforcementMode: "shadow";
  blockingEnabled: false;
  authorizationEffect: "advisory_record";
  capsuleId: string;
  basis: { record: ControlHandoffRecordV2 };
  subject: ChangeAuthorizationSubjectV1;
  providers: readonly ChangeAuthorizationProviderV1[];
  claims: readonly ChangeAuthorizationClaimV1[];
  assertions: readonly ChangeAuthorizationAssertionV1[];
  evidenceBundles: readonly ChangeAuthorizationEvidenceBundleV1[];
  evidenceUniverse: ChangeAuthorizationEvidenceUniverseV1;
  policyRules: readonly ChangeAuthorizationPolicyRuleV1[];
  policyEvaluations: readonly ChangeAuthorizationPolicyEvaluationV1[];
  authorityDescriptor: ChangeAuthorizationAuthorityDescriptorV1;
  verdict: ChangeAuthorizationVerdictV1;
  reasonCodes: readonly ChangeAuthorizationReasonCodeV1[];
  evaluatedAt: string;
  capsuleHash: Sha256Hash;
}

/** in-toto Statement v1 predicate binding; v1 never signs or verifies a DSSE envelope. */
export const CHANGE_AUTHORIZATION_PREDICATE_TYPE_V1 =
  "https://github.com/hoklims/semctx/attestation/change-authorization/v1" as const;

export interface ChangeAuthorizationInTotoSubjectV1 {
  name: string;
  digest: { sha256: string };
}

/**
 * `subject` binds to the change under authorization (`predicate.subject.changeId` /
 * `predicate.subject.subjectHash`), not to the capsule record. `capsuleHash` identifies the
 * predicate record only; it is never the statement's subject digest.
 */
export interface ChangeAuthorizationInTotoStatementV1 {
  _type: "https://in-toto.io/Statement/v1";
  subject: readonly [ChangeAuthorizationInTotoSubjectV1];
  predicateType: typeof CHANGE_AUTHORIZATION_PREDICATE_TYPE_V1;
  predicate: ChangeAuthorizationCapsuleV1;
}

export const CHANGE_AUTHORIZATION_DSSE_PAYLOAD_TYPE_V1 = "application/vnd.in-toto+json" as const;

/** Documents the bound DSSE envelope shape only; v1 implements no signing, verification, or transport. */
export interface ChangeAuthorizationDsseEnvelopeShapeV1 {
  payloadType: typeof CHANGE_AUTHORIZATION_DSSE_PAYLOAD_TYPE_V1;
  payload: string;
  signatures: readonly { keyid?: string; sig: string }[];
}
