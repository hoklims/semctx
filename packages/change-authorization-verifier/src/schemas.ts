/**
 * Manual, dependency-free schema checks (no `zod` import): this package's only runtime dependency
 * is `@semantic-context/control-model`, whose exported schema instances are reused by calling
 * their own `safeParse`/chaining methods rather than importing the `zod` package directly.
 */
import {
  canonicalizeChangeAuthorizationReasons,
  ChangeAuthorizationCapsuleV1Schema,
  ChangeAuthorizationReasonCodeV1Schema,
  ChangeAuthorizationTimestampV1Schema,
  ChangeAuthorizationVerdictV1Schema,
  Sha256HashSchema,
  type ChangeAuthorizationReasonCodeV1,
  type ChangeAuthorizationVerdictV1,
  type Sha256Hash,
} from "@semantic-context/control-model";
import { computeChangeAuthorizationVerificationReportV1Hash } from "./canonical";
import {
  canonicalOrder,
  resolveAuthorityOutcomeV1,
  resolveOverallResultV1,
  resolveReportReasonCodesV1,
  resolveSemanticReasonsV1,
} from "./precedence";
import {
  CHANGE_AUTHORIZATION_VERIFICATION_AUTHORITY_REASONS,
  CHANGE_AUTHORIZATION_VERIFICATION_AUTHORITY_RESULTS,
  CHANGE_AUTHORIZATION_VERIFICATION_INTEGRITY_REASONS,
  CHANGE_AUTHORIZATION_VERIFICATION_INTEGRITY_RESULTS,
  CHANGE_AUTHORIZATION_VERIFICATION_REASON_CODES,
  CHANGE_AUTHORIZATION_VERIFICATION_RESULTS,
  CHANGE_AUTHORIZATION_VERIFICATION_SEMANTIC_REASONS,
  type ChangeAuthorizationVerificationReportV1,
  type ChangeAuthorizationVerificationRequestV1,
} from "./types";

export interface SchemaCheckIssue {
  message: string;
}

export type SchemaCheckResult<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: readonly SchemaCheckIssue[] } };

function ok<T>(data: T): SchemaCheckResult<T> {
  return { success: true, data };
}

function fail(message: string): SchemaCheckResult<never> {
  return { success: false, error: { issues: [{ message }] } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(record: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  const extra = Object.keys(record).find((key) => !allowed.includes(key));
  return extra === undefined ? undefined : `unexpected field: ${extra}`;
}

/**
 * Delegates to control-model's own `ChangeAuthorizationTimestampV1Schema` (RFC 3339 date-time with
 * an explicit offset, calendar-validated: no `2026-02-30`, no leap day on a non-leap year, no
 * `24:00`) so the library, the CLI, and MCP reject the exact same set of impossible instants —
 * never a looser, hand-rolled regex that a stricter transport layer would otherwise disagree with.
 */
function isTimestampV1(value: unknown): value is string {
  return ChangeAuthorizationTimestampV1Schema.safeParse(value).success;
}

function isSha256Hash(value: unknown): value is Sha256Hash {
  return Sha256HashSchema.safeParse(value).success;
}

function isVerdict(value: unknown): value is ChangeAuthorizationVerdictV1 {
  return ChangeAuthorizationVerdictV1Schema.safeParse(value).success;
}

function isReasonCode(value: unknown): value is ChangeAuthorizationReasonCodeV1 {
  return ChangeAuthorizationReasonCodeV1Schema.safeParse(value).success;
}

function isArrayOf<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(guard);
}

export const ChangeAuthorizationVerificationRequestV1Schema = {
  safeParse(value: unknown): SchemaCheckResult<ChangeAuthorizationVerificationRequestV1> {
    if (!isPlainObject(value)) return fail("request must be a JSON object");
    const keysIssue = requireExactKeys(value, [
      "schemaVersion",
      "capsule",
      "expectedAuthorityDescriptorDigest",
      "verifiedAt",
    ]);
    if (keysIssue !== undefined) return fail(keysIssue);
    if (value.schemaVersion !== 1) return fail("schemaVersion must be 1");
    if (!("capsule" in value)) return fail("capsule is required");
    const digest = value.expectedAuthorityDescriptorDigest;
    if (digest !== null && !isSha256Hash(digest)) {
      return fail("expectedAuthorityDescriptorDigest must be a sha256 hash or null");
    }
    if (!isTimestampV1(value.verifiedAt)) return fail("verifiedAt must be an ISO-8601 timestamp with an explicit offset");
    const capsule = ChangeAuthorizationCapsuleV1Schema.safeParse(value.capsule);
    if (capsule.success && Date.parse(value.verifiedAt) < Date.parse(capsule.data.evaluatedAt)) {
      return fail("verifiedAt must not precede capsule.evaluatedAt");
    }
    return ok({
      schemaVersion: 1,
      capsule: value.capsule,
      expectedAuthorityDescriptorDigest: digest as Sha256Hash | null,
      verifiedAt: value.verifiedAt,
    });
  },
};

export const ChangeAuthorizationVerificationReportV1Schema = {
  safeParse(value: unknown): SchemaCheckResult<ChangeAuthorizationVerificationReportV1> {
    if (!isPlainObject(value)) return fail("report must be a JSON object");
    const keysIssue = requireExactKeys(value, [
      "schemaVersion",
      "kind",
      "verifierId",
      "verifierVersion",
      "executionAuthority",
      "enforcementMode",
      "blockingEnabled",
      "authorizationEffect",
      "result",
      "reasonCodes",
      "integrity",
      "authority",
      "semantic",
      "subjectChangeId",
      "subjectHash",
      "capsuleHash",
      "verifiedAt",
      "reportHash",
    ]);
    if (keysIssue !== undefined) return fail(keysIssue);
    if (value.schemaVersion !== 1) return fail("schemaVersion must be 1");
    if (value.kind !== "change_authorization_verification_report") return fail("kind is fixed");
    if (value.verifierId !== "semctx-change-authorization-verifier") return fail("verifierId is fixed");
    if (value.verifierVersion !== "1.0.0") return fail("verifierVersion is fixed");
    if (value.executionAuthority !== "none") return fail("executionAuthority must be 'none'");
    if (value.enforcementMode !== "shadow") return fail("enforcementMode must be 'shadow'");
    if (value.blockingEnabled !== false) return fail("blockingEnabled must be false");
    if (value.authorizationEffect !== "advisory_verification") return fail("authorizationEffect is fixed");
    if (!CHANGE_AUTHORIZATION_VERIFICATION_RESULTS.includes(value.result as never)) return fail("result is not a closed verdict");
    if (!isArrayOf(value.reasonCodes, (item): item is string => CHANGE_AUTHORIZATION_VERIFICATION_REASON_CODES.includes(item as never))
      || (value.reasonCodes as unknown[]).length === 0) {
      return fail("reasonCodes must be a non-empty array of closed reason codes");
    }

    const integrityCheck = checkIntegrity(value.integrity);
    if (integrityCheck !== undefined) return fail(integrityCheck);
    const authorityCheck = checkAuthority(value.authority);
    if (authorityCheck !== undefined) return fail(authorityCheck);
    const semanticCheck = checkSemantic(value.semantic);
    if (semanticCheck !== undefined) return fail(semanticCheck);

    if (value.subjectChangeId !== null && (typeof value.subjectChangeId !== "string" || value.subjectChangeId.length === 0)) {
      return fail("subjectChangeId must be a non-empty string or null");
    }
    if (value.subjectHash !== null && !isSha256Hash(value.subjectHash)) return fail("subjectHash must be a sha256 hash or null");
    if (value.capsuleHash !== null && !isSha256Hash(value.capsuleHash)) return fail("capsuleHash must be a sha256 hash or null");
    if (!isTimestampV1(value.verifiedAt)) return fail("verifiedAt must be an ISO-8601 timestamp");
    if (!isSha256Hash(value.reportHash)) return fail("reportHash must be a sha256 hash");

    // Cross-section checks: the report is not merely well-shaped, its top-level verdict must
    // actually follow from its own declared sections — a forged report cannot claim PASSED while
    // its own integrity/authority/semantic sections say otherwise.
    const integrity = value.integrity as { result: "VALID" | "INVALID"; reasons: readonly string[] };
    const authority = value.authority as {
      recordedAuthorityDescriptorDigest: Sha256Hash | null;
      result: "MATCHED" | "MISMATCHED" | "UNKNOWN";
      reasons: readonly string[];
    };
    const semantic = value.semantic as {
      recordedVerdict: ChangeAuthorizationVerdictV1 | null;
      recordedEvaluatedAt: string | null;
      recordedReasonCodes: readonly ChangeAuthorizationReasonCodeV1[];
      currentVerdict: ChangeAuthorizationVerdictV1 | null;
      currentEvaluatedAt: string;
      currentReasonCodes: readonly ChangeAuthorizationReasonCodeV1[];
      reasons: readonly string[];
    };

    if (value.verifiedAt !== semantic.currentEvaluatedAt) {
      return fail("verifiedAt must equal semantic.currentEvaluatedAt");
    }
    if (
      semantic.recordedEvaluatedAt !== null
      && Date.parse(semantic.currentEvaluatedAt) < Date.parse(semantic.recordedEvaluatedAt)
    ) {
      return fail("semantic.currentEvaluatedAt must not precede semantic.recordedEvaluatedAt");
    }

    // A parsed capsule supplies every recorded/current/identity field. A structurally invalid
    // capsule supplies none of them and is represented by exactly CAPSULE_SCHEMA_INVALID. Keeping
    // this all-or-none state closed prevents a resealed report from inventing a successful replay
    // while omitting the capsule material that the replay requires.
    const hasCapsuleMaterial = semantic.recordedVerdict !== null;
    const materialPresence = [
      semantic.recordedEvaluatedAt !== null,
      semantic.currentVerdict !== null,
      authority.recordedAuthorityDescriptorDigest !== null,
      value.subjectChangeId !== null,
      value.subjectHash !== null,
      value.capsuleHash !== null,
    ];
    if (materialPresence.some((present) => present !== hasCapsuleMaterial)) {
      return fail("capsule material availability is inconsistent across report sections");
    }
    if ((semantic.recordedReasonCodes.length > 0) !== hasCapsuleMaterial
      || (semantic.currentReasonCodes.length > 0) !== hasCapsuleMaterial) {
      return fail("semantic reason-code availability must follow capsule material availability");
    }
    const capsuleSchemaInvalid = integrity.reasons.includes("CAPSULE_SCHEMA_INVALID");
    if (hasCapsuleMaterial && capsuleSchemaInvalid) {
      return fail("CAPSULE_SCHEMA_INVALID cannot accompany parsed capsule material");
    }
    if (!hasCapsuleMaterial
      && (integrity.result !== "INVALID"
        || JSON.stringify(integrity.reasons) !== JSON.stringify(["CAPSULE_SCHEMA_INVALID"]))) {
      return fail("absent capsule material requires exactly CAPSULE_SCHEMA_INVALID");
    }

    const expectedResult = resolveOverallResultV1({
      integrityResult: integrity.result,
      authorityResult: authority.result,
      recordedVerdict: semantic.recordedVerdict,
      currentVerdict: semantic.currentVerdict,
    });
    if (value.result !== expectedResult) {
      return fail("result does not follow from the integrity/authority/semantic sections' own precedence rule");
    }
    const expectedReasonCodes = resolveReportReasonCodesV1(integrity.reasons, authority.reasons, semantic.reasons);
    if (JSON.stringify(value.reasonCodes) !== JSON.stringify(expectedReasonCodes)) {
      return fail("reasonCodes is not the canonical union of the integrity/authority/semantic sections' own reasons");
    }

    // The report is self-hashing: `reportHash` must recompute to exactly this content, under its
    // own domain, or the report is not the one it claims to be.
    let recomputedReportHash: Sha256Hash;
    try {
      recomputedReportHash = computeChangeAuthorizationVerificationReportV1Hash(
        value as unknown as ChangeAuthorizationVerificationReportV1,
      );
    } catch {
      return fail("report content is not JCS-safe and cannot be canonically hashed");
    }
    if (recomputedReportHash !== value.reportHash) {
      return fail("reportHash does not match the report's own canonical content");
    }

    return ok(value as unknown as ChangeAuthorizationVerificationReportV1);
  },
};

function checkIntegrity(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "integrity must be a JSON object";
  const keysIssue = requireExactKeys(value, ["schemaVersion", "result", "reasons"]);
  if (keysIssue !== undefined) return keysIssue;
  if (value.schemaVersion !== 1) return "integrity.schemaVersion must be 1";
  if (!CHANGE_AUTHORIZATION_VERIFICATION_INTEGRITY_RESULTS.includes(value.result as never)) {
    return "integrity.result is not a closed verdict";
  }
  if (!isArrayOf(value.reasons, (item): item is string => CHANGE_AUTHORIZATION_VERIFICATION_INTEGRITY_REASONS.includes(item as never))) {
    return "integrity.reasons must be drawn from the closed integrity reason set";
  }
  if ((value.result === "VALID") !== ((value.reasons as unknown[]).length === 0)) {
    return "integrity.result and integrity.reasons must agree";
  }
  const canonicalReasons = canonicalOrder(
    value.reasons as (typeof CHANGE_AUTHORIZATION_VERIFICATION_INTEGRITY_REASONS)[number][],
    CHANGE_AUTHORIZATION_VERIFICATION_INTEGRITY_REASONS,
  );
  if (JSON.stringify(value.reasons) !== JSON.stringify(canonicalReasons)) {
    return "integrity.reasons must be unique and canonically ordered";
  }
  return undefined;
}

function checkAuthority(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "authority must be a JSON object";
  const keysIssue = requireExactKeys(value, [
    "schemaVersion",
    "expectedAuthorityDescriptorDigest",
    "recordedAuthorityDescriptorDigest",
    "result",
    "reasons",
  ]);
  if (keysIssue !== undefined) return keysIssue;
  if (value.schemaVersion !== 1) return "authority.schemaVersion must be 1";
  const expected = value.expectedAuthorityDescriptorDigest;
  if (expected !== null && !isSha256Hash(expected)) {
    return "authority.expectedAuthorityDescriptorDigest must be a sha256 hash or null";
  }
  const recorded = value.recordedAuthorityDescriptorDigest;
  if (recorded !== null && !isSha256Hash(recorded)) {
    return "authority.recordedAuthorityDescriptorDigest must be a sha256 hash or null";
  }
  if (!CHANGE_AUTHORIZATION_VERIFICATION_AUTHORITY_RESULTS.includes(value.result as never)) {
    return "authority.result is not a closed verdict";
  }
  if (!isArrayOf(value.reasons, (item): item is string => CHANGE_AUTHORIZATION_VERIFICATION_AUTHORITY_REASONS.includes(item as never))) {
    return "authority.reasons must be drawn from the closed authority reason set";
  }
  const expectedOutcome = resolveAuthorityOutcomeV1(expected as Sha256Hash | null, recorded as Sha256Hash | null);
  if (value.result !== expectedOutcome.result) {
    return "authority.result does not follow from expectedAuthorityDescriptorDigest/recordedAuthorityDescriptorDigest";
  }
  if (JSON.stringify(value.reasons) !== JSON.stringify(expectedOutcome.reasons)) {
    return "authority.reasons does not follow from expectedAuthorityDescriptorDigest/recordedAuthorityDescriptorDigest";
  }
  return undefined;
}

function checkSemantic(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "semantic must be a JSON object";
  const keysIssue = requireExactKeys(value, [
    "schemaVersion",
    "recordedVerdict",
    "recordedEvaluatedAt",
    "recordedReasonCodes",
    "currentVerdict",
    "currentEvaluatedAt",
    "currentReasonCodes",
    "reasons",
  ]);
  if (keysIssue !== undefined) return keysIssue;
  if (value.schemaVersion !== 1) return "semantic.schemaVersion must be 1";
  if (value.recordedVerdict !== null && !isVerdict(value.recordedVerdict)) return "semantic.recordedVerdict is invalid";
  if (value.recordedEvaluatedAt !== null && !isTimestampV1(value.recordedEvaluatedAt)) return "semantic.recordedEvaluatedAt is invalid";
  if (!isArrayOf(value.recordedReasonCodes, isReasonCode)) return "semantic.recordedReasonCodes is invalid";
  if (value.currentVerdict !== null && !isVerdict(value.currentVerdict)) return "semantic.currentVerdict is invalid";
  if (!isTimestampV1(value.currentEvaluatedAt)) return "semantic.currentEvaluatedAt is invalid";
  if (!isArrayOf(value.currentReasonCodes, isReasonCode)) return "semantic.currentReasonCodes is invalid";
  if (!isArrayOf(value.reasons, (item): item is string => CHANGE_AUTHORIZATION_VERIFICATION_SEMANTIC_REASONS.includes(item as never))) {
    return "semantic.reasons must be drawn from the closed semantic reason set";
  }
  const expectedReasons = resolveSemanticReasonsV1(
    value.recordedVerdict as ChangeAuthorizationVerdictV1 | null,
    value.currentVerdict as ChangeAuthorizationVerdictV1 | null,
  );
  if (JSON.stringify(value.reasons) !== JSON.stringify(expectedReasons)) {
    return "semantic.reasons does not follow from currentVerdict";
  }
  const recordedReasonCodes = value.recordedReasonCodes as ChangeAuthorizationReasonCodeV1[];
  if (JSON.stringify(recordedReasonCodes) !== JSON.stringify(canonicalizeChangeAuthorizationReasons(recordedReasonCodes))) {
    return "semantic.recordedReasonCodes must be unique and canonically ordered";
  }
  const recordedDecisionIssue = checkDecisionReasonCodes(
    value.recordedVerdict as ChangeAuthorizationVerdictV1 | null,
    recordedReasonCodes,
    "semantic.recordedReasonCodes",
  );
  if (recordedDecisionIssue !== undefined) return recordedDecisionIssue;
  const currentReasonCodes = value.currentReasonCodes as ChangeAuthorizationReasonCodeV1[];
  if (JSON.stringify(currentReasonCodes) !== JSON.stringify(canonicalizeChangeAuthorizationReasons(currentReasonCodes))) {
    return "semantic.currentReasonCodes must be unique and canonically ordered";
  }
  const currentDecisionIssue = checkDecisionReasonCodes(
    value.currentVerdict as ChangeAuthorizationVerdictV1 | null,
    currentReasonCodes,
    "semantic.currentReasonCodes",
  );
  if (currentDecisionIssue !== undefined) return currentDecisionIssue;
  return undefined;
}

function checkDecisionReasonCodes(
  verdict: ChangeAuthorizationVerdictV1 | null,
  reasonCodes: readonly ChangeAuthorizationReasonCodeV1[],
  label: string,
): string | undefined {
  if (verdict === null) {
    return reasonCodes.length === 0 ? undefined : `${label} must be empty when its verdict is null`;
  }
  if (reasonCodes.length === 0) return `${label} must be non-empty when its verdict is present`;
  if (verdict === "ALLOW") {
    return reasonCodes.length === 1 && reasonCodes[0] === "POLICY_SATISFIED"
      ? undefined
      : `${label} must be exactly POLICY_SATISFIED for ALLOW`;
  }
  return reasonCodes.includes("POLICY_SATISFIED")
    ? `${label} cannot contain POLICY_SATISFIED for ${verdict}`
    : undefined;
}
