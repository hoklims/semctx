/**
 * Pure precedence rules shared between construction (`verify.ts`) and validation
 * (`schemas.ts`): both must agree on how `authority`/`semantic` outcomes are derived from their
 * inputs, and on how the top-level `result`/`reasonCodes` are derived from the three sections —
 * otherwise the schema could only check shape, not that a forged report's stated verdict actually
 * follows from its own declared sections.
 */
import type { ChangeAuthorizationVerdictV1, Sha256Hash } from "@semantic-context/control-model";
import {
  CHANGE_AUTHORIZATION_VERIFICATION_REASON_CODES,
  type ChangeAuthorizationVerificationAuthorityReasonV1,
  type ChangeAuthorizationVerificationAuthorityResultV1,
  type ChangeAuthorizationVerificationIntegrityResultV1,
  type ChangeAuthorizationVerificationReasonCodeV1,
  type ChangeAuthorizationVerificationResultV1,
  type ChangeAuthorizationVerificationSemanticReasonV1,
} from "./types";

export function canonicalOrder<T extends string>(values: readonly T[], order: readonly T[]): readonly T[] {
  return [...new Set(values)].sort((left, right) => order.indexOf(left) - order.indexOf(right));
}

/** Never trusts the capsule's own digest: `expected === null` is always UNKNOWN, never MATCHED. */
export function resolveAuthorityOutcomeV1(
  expected: Sha256Hash | null,
  recorded: Sha256Hash | null,
): {
  result: ChangeAuthorizationVerificationAuthorityResultV1;
  reasons: readonly ChangeAuthorizationVerificationAuthorityReasonV1[];
} {
  if (expected === null) return { result: "UNKNOWN", reasons: ["EXPECTED_AUTHORITY_DIGEST_ABSENT"] };
  if (recorded === null) return { result: "UNKNOWN", reasons: [] };
  if (recorded !== expected) return { result: "MISMATCHED", reasons: ["EXPECTED_AUTHORITY_DIGEST_MISMATCH"] };
  return { result: "MATCHED", reasons: [] };
}

export function resolveSemanticReasonsV1(
  recordedVerdict: ChangeAuthorizationVerdictV1 | null,
  currentVerdict: ChangeAuthorizationVerdictV1 | null,
): readonly ChangeAuthorizationVerificationSemanticReasonV1[] {
  const reasons: ChangeAuthorizationVerificationSemanticReasonV1[] = [];
  if (recordedVerdict === "DENY") reasons.push("RECORDED_DECISION_DENY");
  if (recordedVerdict === "REQUIRE_EVIDENCE") reasons.push("RECORDED_DECISION_REQUIRE_EVIDENCE");
  if (currentVerdict === "DENY") reasons.push("CURRENT_DECISION_DENY");
  if (currentVerdict === "REQUIRE_EVIDENCE") reasons.push("CURRENT_DECISION_REQUIRE_EVIDENCE");
  return reasons;
}

/** Never an implicit promotion: integrity/authority failures and DENY all outrank REQUIRE_EVIDENCE, which outranks PASSED. */
export function resolveOverallResultV1(input: {
  integrityResult: ChangeAuthorizationVerificationIntegrityResultV1;
  authorityResult: ChangeAuthorizationVerificationAuthorityResultV1;
  recordedVerdict: ChangeAuthorizationVerdictV1 | null;
  currentVerdict: ChangeAuthorizationVerdictV1 | null;
}): ChangeAuthorizationVerificationResultV1 {
  if (input.integrityResult === "INVALID") return "FAILED";
  if (input.authorityResult === "MISMATCHED") return "FAILED";
  if (input.recordedVerdict === null || input.currentVerdict === null) return "FAILED";
  if (input.recordedVerdict === "DENY") return "FAILED";
  if (input.currentVerdict === "DENY") return "FAILED";
  if (
    input.authorityResult === "UNKNOWN"
    || input.recordedVerdict === "REQUIRE_EVIDENCE"
    || input.currentVerdict === "REQUIRE_EVIDENCE"
  ) return "REQUIRE_EVIDENCE";
  return "PASSED";
}

export function resolveReportReasonCodesV1(
  integrityReasons: readonly string[],
  authorityReasons: readonly string[],
  semanticReasons: readonly string[],
): readonly ChangeAuthorizationVerificationReasonCodeV1[] {
  const collected = new Set<ChangeAuthorizationVerificationReasonCodeV1>([
    ...integrityReasons,
    ...authorityReasons,
    ...semanticReasons,
  ] as ChangeAuthorizationVerificationReasonCodeV1[]);
  if (collected.size === 0) collected.add("VERIFICATION_PASSED");
  return canonicalOrder([...collected], CHANGE_AUTHORIZATION_VERIFICATION_REASON_CODES);
}
