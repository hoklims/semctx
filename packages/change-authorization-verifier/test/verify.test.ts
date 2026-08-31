import { describe, expect, it } from "bun:test";
import * as controlModel from "@semantic-context/control-model";
import type { ChangeAuthorizationCapsuleV1 } from "@semantic-context/control-model";
import { evaluateChangeAuthorizationV1 } from "@semantic-context/control-engine";
import {
  ChangeAuthorizationVerificationReportV1Schema,
  ChangeAuthorizationVerificationRequestV1Schema,
} from "../src/schemas";
import { verifyChangeAuthorizationCapsuleV1 } from "../src/verify";
import type { ChangeAuthorizationVerificationRequestV1 } from "../src/types";
import { baseEvaluationInput, passingAssertionInput, provider, record } from "./fixtures";

function requestFor(
  capsule: ChangeAuthorizationCapsuleV1,
  overrides: Partial<ChangeAuthorizationVerificationRequestV1> = {},
): ChangeAuthorizationVerificationRequestV1 {
  return {
    schemaVersion: 1,
    capsule,
    expectedAuthorityDescriptorDigest: capsule.authorityDescriptor.descriptorDigest,
    verifiedAt: capsule.evaluatedAt,
    ...overrides,
  };
}

function expectValidReportShape(report: ReturnType<typeof verifyChangeAuthorizationCapsuleV1>): void {
  expect(ChangeAuthorizationVerificationReportV1Schema.safeParse(report).success).toBe(true);
  expect(report.executionAuthority).toBe("none");
  expect(report.enforcementMode).toBe("shadow");
  expect(report.blockingEnabled).toBe(false);
  expect(report.authorizationEffect).toBe("advisory_verification");
}

describe("verifyChangeAuthorizationCapsuleV1", () => {
  it("PASSES a genuine ALLOW capsule verified against its own pinned authority digest at the same instant", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    expect(capsule.verdict).toBe("ALLOW");
    const report = verifyChangeAuthorizationCapsuleV1(requestFor(capsule));
    expectValidReportShape(report);
    expect(report.result).toBe("PASSED");
    expect(report.reasonCodes).toEqual(["VERIFICATION_PASSED"]);
    expect(report.integrity.result).toBe("VALID");
    expect(report.authority.result).toBe("MATCHED");
    expect(report.semantic.currentVerdict).toBe("ALLOW");
    expect(report.subjectChangeId).toBe(capsule.subject.changeId);
    expect(report.capsuleHash).toBe(capsule.capsuleHash);
  });

  it("is deterministic: identical requests always produce the same reportHash", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    const first = verifyChangeAuthorizationCapsuleV1(requestFor(capsule));
    const second = verifyChangeAuthorizationCapsuleV1(requestFor(capsule));
    expect(first.reportHash).toBe(second.reportHash);
  });

  it("returns REQUIRE_EVIDENCE, not an implicit PASS, when the caller holds no external authority pin", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    const report = verifyChangeAuthorizationCapsuleV1(
      requestFor(capsule, { expectedAuthorityDescriptorDigest: null }),
    );
    expectValidReportShape(report);
    expect(report.result).toBe("REQUIRE_EVIDENCE");
    expect(report.authority.result).toBe("UNKNOWN");
    expect(report.reasonCodes).toContain("EXPECTED_AUTHORITY_DIGEST_ABSENT");
  });

  it("FAILS when the expected authority digest diverges, even though the capsule is internally and historically valid", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    const report = verifyChangeAuthorizationCapsuleV1(requestFor(capsule, {
      expectedAuthorityDescriptorDigest: `sha256:${"9".repeat(64)}` as const,
    }));
    expectValidReportShape(report);
    expect(report.result).toBe("FAILED");
    expect(report.integrity.result).toBe("VALID");
    expect(report.authority.result).toBe("MISMATCHED");
    expect(report.reasonCodes).toContain("EXPECTED_AUTHORITY_DIGEST_MISMATCH");
  });

  it("ceilings at REQUIRE_EVIDENCE when the basis reconciliation is UNPROVEN", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput({ basisRecord: record("UNPROVEN") }));
    expect(capsule.verdict).toBe("REQUIRE_EVIDENCE");
    const report = verifyChangeAuthorizationCapsuleV1(requestFor(capsule));
    expectValidReportShape(report);
    expect(report.result).toBe("REQUIRE_EVIDENCE");
    expect(report.semantic.currentVerdict).toBe("REQUIRE_EVIDENCE");
    expect(report.reasonCodes).toContain("CURRENT_DECISION_REQUIRE_EVIDENCE");
  });

  it("FAILS when the basis reconciliation is VIOLATED, regardless of satisfied rules", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput({ basisRecord: record("VIOLATED") }));
    expect(capsule.verdict).toBe("DENY");
    const report = verifyChangeAuthorizationCapsuleV1(requestFor(capsule));
    expectValidReportShape(report);
    expect(report.result).toBe("FAILED");
    expect(report.semantic.currentVerdict).toBe("DENY");
    expect(report.reasonCodes).toContain("CURRENT_DECISION_DENY");
  });

  it("FAILS a capsule that fails schema validation, and reports no subject/capsule identity", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    const corrupted = { ...capsule, capsuleHash: `sha256:${"9".repeat(64)}` as const };
    const report = verifyChangeAuthorizationCapsuleV1(requestFor(corrupted as ChangeAuthorizationCapsuleV1, {
      expectedAuthorityDescriptorDigest: capsule.authorityDescriptor.descriptorDigest,
    }));
    expectValidReportShape(report);
    expect(report.result).toBe("FAILED");
    expect(report.integrity.result).toBe("INVALID");
    expect(report.integrity.reasons).toEqual(["CAPSULE_SCHEMA_INVALID"]);
    expect(report.subjectChangeId).toBeNull();
    expect(report.subjectHash).toBeNull();
    expect(report.capsuleHash).toBeNull();
  });

  it("catches a hand-forged capsule that claims a DEGRADED-provider assertion as satisfied, even though every hash is internally self-consistent", () => {
    const allow = evaluateChangeAuthorizationV1(baseEvaluationInput());
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

    expect(controlModel.ChangeAuthorizationCapsuleV1Schema.safeParse(resealed).success).toBe(true);
    expect(resealed.verdict).toBe("ALLOW");

    const report = verifyChangeAuthorizationCapsuleV1(requestFor(resealed, {
      expectedAuthorityDescriptorDigest: resealed.authorityDescriptor.descriptorDigest,
    }));
    expectValidReportShape(report);
    expect(report.result).toBe("FAILED");
    expect(report.integrity.result).toBe("INVALID");
    expect(report.integrity.reasons).toContain("POLICY_EVALUATION_REDERIVATION_MISMATCH");
  });

  it("degrades ALLOW to REQUIRE_EVIDENCE when evidence expires strictly between capsule.evaluatedAt and request.verifiedAt", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput({
      assertions: [passingAssertionInput({ expiresAt: "2026-08-15T00:00:00.000Z" })],
    }));
    expect(capsule.verdict).toBe("ALLOW");

    const stillFresh = verifyChangeAuthorizationCapsuleV1(requestFor(capsule, { verifiedAt: "2026-08-14T00:00:00.000Z" }));
    expect(stillFresh.result).toBe("PASSED");
    expect(stillFresh.integrity.result).toBe("VALID");

    const nowStale = verifyChangeAuthorizationCapsuleV1(requestFor(capsule, { verifiedAt: "2026-09-01T00:00:00.000Z" }));
    expectValidReportShape(nowStale);
    expect(nowStale.result).toBe("REQUIRE_EVIDENCE");
    // The historical record itself is untouched: the capsule was honestly ALLOW when it was sealed.
    expect(nowStale.integrity.result).toBe("VALID");
    expect(nowStale.semantic.recordedVerdict).toBe("ALLOW");
    expect(nowStale.semantic.currentVerdict).toBe("REQUIRE_EVIDENCE");
    expect(nowStale.semantic.currentReasonCodes).toContain("REQUIRED_EVIDENCE_EXPIRED");
    expect(nowStale.reasonCodes).toContain("CURRENT_DECISION_REQUIRE_EVIDENCE");
  });

  it("rejects verifiedAt before capsule.evaluatedAt instead of promoting an expired recorded decision", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput({
      evaluatedAt: "2026-10-01T10:00:00.000Z",
    }));
    expect(capsule.verdict).toBe("REQUIRE_EVIDENCE");
    expect(capsule.reasonCodes).toContain("REQUIRED_EVIDENCE_EXPIRED");

    const request = requestFor(capsule, { verifiedAt: "2026-08-14T00:00:00.000Z" });
    expect(ChangeAuthorizationVerificationRequestV1Schema.safeParse(request).success).toBe(false);
    expect(() => verifyChangeAuthorizationCapsuleV1(request)).toThrow(
      "verifiedAt must not precede capsule.evaluatedAt",
    );
  });

  it("never promotes a historically REQUIRE_EVIDENCE capsule when future-dated evidence becomes current", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput({
      assertions: [passingAssertionInput({ observedAt: "2026-08-15T00:00:00.000Z" })],
    }));
    expect(capsule.verdict).toBe("REQUIRE_EVIDENCE");

    const report = verifyChangeAuthorizationCapsuleV1(requestFor(capsule, {
      verifiedAt: "2026-08-16T00:00:00.000Z",
    }));
    expectValidReportShape(report);
    expect(report.semantic.recordedVerdict).toBe("REQUIRE_EVIDENCE");
    expect(report.semantic.currentVerdict).toBe("ALLOW");
    expect(report.result).toBe("REQUIRE_EVIDENCE");
    expect(report.reasonCodes).toContain("RECORDED_DECISION_REQUIRE_EVIDENCE");
  });

  it("degrades when a sealed provider snapshot expires, with the provider-specific reason", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput({
      providers: [provider({ expiresAt: "2026-08-15T00:00:00.000Z" })],
    }));
    expect(capsule.verdict).toBe("ALLOW");

    const report = verifyChangeAuthorizationCapsuleV1(requestFor(capsule, {
      verifiedAt: "2026-08-16T00:00:00.000Z",
    }));
    expectValidReportShape(report);
    expect(report.result).toBe("REQUIRE_EVIDENCE");
    expect(report.semantic.currentVerdict).toBe("REQUIRE_EVIDENCE");
    expect(report.semantic.currentReasonCodes).toContain("SOURCE_SEAL_STALE");
  });

  it("throws on a malformed request envelope instead of producing a report", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    expect(() => verifyChangeAuthorizationCapsuleV1({
      schemaVersion: 1,
      capsule,
      expectedAuthorityDescriptorDigest: capsule.authorityDescriptor.descriptorDigest,
      verifiedAt: "not-a-timestamp",
    })).toThrow();
  });

  it("accepts a well-formed request envelope through the public request schema", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    const request = requestFor(capsule);
    expect(ChangeAuthorizationVerificationRequestV1Schema.safeParse(request).success).toBe(true);
  });
});
