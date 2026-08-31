import { describe, expect, it } from "bun:test";
import { evaluateChangeAuthorizationV1 } from "@semantic-context/control-engine";
import { computeChangeAuthorizationVerificationReportV1Hash } from "../src/canonical";
import { ChangeAuthorizationVerificationReportV1Schema } from "../src/schemas";
import type { ChangeAuthorizationVerificationReportV1 } from "../src/types";
import { verifyChangeAuthorizationCapsuleV1 } from "../src/verify";
import { baseEvaluationInput } from "./fixtures";

/** Reseals a tampered report so its `reportHash` matches its own (forged) content byte-exactly. */
function reseal(
  report: ChangeAuthorizationVerificationReportV1,
  patch: Partial<ChangeAuthorizationVerificationReportV1>,
): ChangeAuthorizationVerificationReportV1 {
  const patched = { ...report, ...patch };
  const { reportHash: _ignored, ...withoutHash } = patched;
  return { ...withoutHash, reportHash: computeChangeAuthorizationVerificationReportV1Hash(withoutHash) };
}

function genuinePassedReport(): ChangeAuthorizationVerificationReportV1 {
  const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
  return verifyChangeAuthorizationCapsuleV1({
    schemaVersion: 1,
    capsule,
    expectedAuthorityDescriptorDigest: capsule.authorityDescriptor.descriptorDigest,
    verifiedAt: capsule.evaluatedAt,
  });
}

describe("ChangeAuthorizationVerificationReportV1Schema — validates the report, not only its shape", () => {
  it("accepts a genuine, self-consistent report", () => {
    const report = genuinePassedReport();
    expect(report.result).toBe("PASSED");
    expect(ChangeAuthorizationVerificationReportV1Schema.safeParse(report).success).toBe(true);
  });

  it("rejects a report whose reportHash does not recompute, with every other field untouched", () => {
    const report = genuinePassedReport();
    const tampered: ChangeAuthorizationVerificationReportV1 = {
      ...report,
      reportHash: `sha256:${"9".repeat(64)}` as const,
    };
    const parsed = ChangeAuthorizationVerificationReportV1Schema.safeParse(tampered);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("reportHash");
    }
  });

  it("rejects a resealed report whose top-level result contradicts its own integrity/authority/semantic sections", () => {
    const report = genuinePassedReport();
    // Sections are still genuinely PASSED-shaped (integrity VALID, authority MATCHED, semantic
    // ALLOW); only the top-level verdict is forged. Resealing proves this is not caught by the
    // hash check alone — it needs the cross-section precedence check.
    const forged = reseal(report, { result: "FAILED" });
    const parsed = ChangeAuthorizationVerificationReportV1Schema.safeParse(forged);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("result does not follow");
    }
  });

  it("rejects a resealed report whose reasonCodes are not the canonical union of its own sections' reasons", () => {
    const report = genuinePassedReport();
    const forged = reseal(report, { reasonCodes: ["EXPECTED_AUTHORITY_DIGEST_ABSENT"] });
    const parsed = ChangeAuthorizationVerificationReportV1Schema.safeParse(forged);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("reasonCodes is not the canonical union");
    }
  });

  it("rejects a resealed report whose integrity section result contradicts its own reasons", () => {
    const report = genuinePassedReport();
    const forged = reseal(report, {
      integrity: { schemaVersion: 1, result: "INVALID", reasons: [] },
    });
    const parsed = ChangeAuthorizationVerificationReportV1Schema.safeParse(forged);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("integrity.result and integrity.reasons must agree");
    }
  });

  it("rejects a resealed report whose authority result does not follow from its own declared digests", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    const mismatched = verifyChangeAuthorizationCapsuleV1({
      schemaVersion: 1,
      capsule,
      expectedAuthorityDescriptorDigest: `sha256:${"9".repeat(64)}` as const,
      verifiedAt: capsule.evaluatedAt,
    });
    expect(mismatched.authority.result).toBe("MISMATCHED");
    // The declared digests still genuinely diverge; only the section's own verdict is forged back
    // to MATCHED with its MISMATCHED reason still attached — an internally inconsistent claim.
    const forged = reseal(mismatched, {
      authority: { ...mismatched.authority, result: "MATCHED" },
    });
    const parsed = ChangeAuthorizationVerificationReportV1Schema.safeParse(forged);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("authority.result does not follow");
    }
  });

  it("rejects a resealed report whose semantic reasons do not follow from its own currentVerdict", () => {
    const report = genuinePassedReport();
    expect(report.semantic.currentVerdict).toBe("ALLOW");
    const forged = reseal(report, {
      semantic: { ...report.semantic, reasons: ["CURRENT_DECISION_DENY"] },
    });
    const parsed = ChangeAuthorizationVerificationReportV1Schema.safeParse(forged);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("semantic.reasons does not follow");
    }
  });

  it("rejects a resealed PASSED report that omits the current semantic replay", () => {
    const report = genuinePassedReport();
    const forged = reseal(report, {
      semantic: {
        ...report.semantic,
        currentVerdict: null,
        currentReasonCodes: [],
      },
    });
    const parsed = ChangeAuthorizationVerificationReportV1Schema.safeParse(forged);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("capsule material availability");
    }
  });

  it("rejects a resealed report whose semantic replay uses a different verifiedAt", () => {
    const report = genuinePassedReport();
    const forged = reseal(report, {
      semantic: {
        ...report.semantic,
        currentEvaluatedAt: "2026-12-01T00:00:00.000Z",
      },
    });
    const parsed = ChangeAuthorizationVerificationReportV1Schema.safeParse(forged);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("verifiedAt must equal semantic.currentEvaluatedAt");
    }
  });

  it("rejects a resealed report whose recorded evaluation is later than its current replay", () => {
    const report = genuinePassedReport();
    const forged = reseal(report, {
      semantic: {
        ...report.semantic,
        recordedEvaluatedAt: "2026-12-01T00:00:00.000Z",
      },
    });
    const parsed = ChangeAuthorizationVerificationReportV1Schema.safeParse(forged);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain(
        "semantic.currentEvaluatedAt must not precede semantic.recordedEvaluatedAt",
      );
    }
  });

  it("accepts the closed absent-capsule state emitted for structurally invalid input", () => {
    const report = verifyChangeAuthorizationCapsuleV1({
      schemaVersion: 1,
      capsule: {},
      expectedAuthorityDescriptorDigest: null,
      verifiedAt: "2026-08-01T10:00:00.000Z",
    });

    expect(report.result).toBe("FAILED");
    expect(report.integrity.reasons).toEqual(["CAPSULE_SCHEMA_INVALID"]);
    expect(report.subjectChangeId).toBeNull();
    expect(report.semantic.currentVerdict).toBeNull();
    expect(ChangeAuthorizationVerificationReportV1Schema.safeParse(report).success).toBe(true);
  });

  it("rejects resealed reports that mix absent-capsule markers with parsed capsule material", () => {
    const report = genuinePassedReport();
    const forged = reseal(report, {
      integrity: { schemaVersion: 1, result: "INVALID", reasons: ["CAPSULE_SCHEMA_INVALID"] },
      result: "FAILED",
      reasonCodes: ["CAPSULE_SCHEMA_INVALID"],
    });
    const parsed = ChangeAuthorizationVerificationReportV1Schema.safeParse(forged);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("CAPSULE_SCHEMA_INVALID cannot accompany parsed capsule material");
    }
  });

  it("rejects a resealed ALLOW replay that retains failure reason codes", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    const stale = verifyChangeAuthorizationCapsuleV1({
      schemaVersion: 1,
      capsule,
      expectedAuthorityDescriptorDigest: capsule.authorityDescriptor.descriptorDigest,
      verifiedAt: "2026-10-01T10:00:00.000Z",
    });
    expect(stale.semantic.currentVerdict).toBe("REQUIRE_EVIDENCE");
    const forged = reseal(stale, {
      semantic: {
        ...stale.semantic,
        currentVerdict: "ALLOW",
        reasons: [],
      },
      result: "PASSED",
      reasonCodes: ["VERIFICATION_PASSED"],
    });

    const parsed = ChangeAuthorizationVerificationReportV1Schema.safeParse(forged);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("must be exactly POLICY_SATISFIED for ALLOW");
    }
  });
});
