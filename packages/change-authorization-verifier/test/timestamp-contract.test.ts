import { describe, expect, it } from "bun:test";
import { evaluateChangeAuthorizationV1 } from "@semantic-context/control-engine";
import { ChangeAuthorizationVerificationRequestV1Schema } from "../src/schemas";
import { verifyChangeAuthorizationCapsuleV1 } from "../src/verify";
import { baseEvaluationInput } from "./fixtures";

/**
 * One strict timestamp contract, shared with control-model (`ChangeAuthorizationTimestampV1Schema`)
 * and with MCP (via `mcpSchema`): no calendar-impossible instant is ever evaluated as real.
 */
const IMPOSSIBLE_TIMESTAMPS = [
  "2026-02-30T12:00:00Z",
  "2026-01-01T24:00:00Z",
] as const;

describe("verifiedAt is calendar-validated, not merely shape-validated", () => {
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
