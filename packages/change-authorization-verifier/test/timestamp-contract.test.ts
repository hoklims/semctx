import { describe, expect, it } from "bun:test";
import { evaluateChangeAuthorizationV1 } from "@semantic-context/control-engine";
import { ChangeAuthorizationVerificationRequestV1Schema } from "../src/schemas";
import { verifyChangeAuthorizationCapsuleV1 } from "../src/verify";
import { baseEvaluationInput, passingAssertionInput, provider } from "./fixtures";

/**
 * One strict timestamp contract, shared with control-model (`ChangeAuthorizationTimestampV1Schema`)
 * and with MCP (via `mcpSchema`): no calendar-impossible instant is ever evaluated as real.
 */
const IMPOSSIBLE_TIMESTAMPS = [
  "2026-02-30T12:00:00Z",
  "2026-01-01T24:00:00Z",
  "2026-08-01T10:00:00.000+24:00",
  "2026-08-01T10:00:00.000+99:00",
  "2026-08-01T10:00:00.000+01:99",
  "2026-08-01T10:00:00.000+2400",
] as const;

describe("verifiedAt is calendar-validated, not merely shape-validated", () => {
  for (const source of ["assertion", "provider"] as const) {
    it.each([
      ["expiresAt", "2026-08-01T10:00:00.0008Z", "2026-08-01T10:00:00.0009Z"],
      ["observedAt", "2026-08-01T10:00:00.0009Z", "2026-08-01T10:00:00.0008Z"],
    ] as const)(`preserves genuine producer and independent replay parity for fractional ${source} %s`, (field, timestamp, evaluatedAt) => {
      const overrides = { [field]: timestamp };
      const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput({
        evaluatedAt,
        ...(source === "assertion" ? { assertions: [passingAssertionInput(overrides)] } : { providers: [provider(overrides)] }),
      }));
      const report = verifyChangeAuthorizationCapsuleV1({
        schemaVersion: 1,
        capsule,
        expectedAuthorityDescriptorDigest: capsule.authorityDescriptor.descriptorDigest,
        verifiedAt: evaluatedAt,
      });
      expect(report.integrity.result).toBe("VALID");
      expect(report.integrity.reasons).not.toContain("POLICY_EVALUATION_REDERIVATION_MISMATCH");
      expect(capsule.verdict).toBe("REQUIRE_EVIDENCE");
      expect(report.semantic.currentVerdict).toBe(capsule.verdict);
    });
  }

  for (const impossible of IMPOSSIBLE_TIMESTAMPS) {
    it(`rejects ${impossible} as an envelope error, never an evaluated instant`, () => {
      const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
      const request = {
        schemaVersion: 1 as const,
        capsule,
        expectedAuthorityDescriptorDigest: capsule.authorityDescriptor.descriptorDigest,
        verifiedAt: impossible,
      };
      const parsed = ChangeAuthorizationVerificationRequestV1Schema.safeParse(request);
      expect(parsed.success).toBe(false);

      expect(() => verifyChangeAuthorizationCapsuleV1(request)).toThrow();
    });
  }

  it("still accepts a genuine calendar-valid leap day", () => {
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
    const request = {
      schemaVersion: 1 as const,
      capsule,
      expectedAuthorityDescriptorDigest: capsule.authorityDescriptor.descriptorDigest,
      verifiedAt: "2028-02-29T00:00:00Z",
    };
    expect(ChangeAuthorizationVerificationRequestV1Schema.safeParse(request).success).toBe(true);
  });
});
