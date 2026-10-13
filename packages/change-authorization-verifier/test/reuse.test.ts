import { describe, expect, it } from "bun:test";
import { runInNewContext } from "node:vm";
import { evaluateChangeAuthorizationV1 } from "@semantic-context/control-engine";
import { evaluateChangeAuthorizationReuseV1 } from "../src/index";
import { verifyChangeAuthorizationCapsuleV1 } from "../src/verify";
import { baseEvaluationInput, passingAssertionInput, record } from "./fixtures";

function fixture() {
  const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput());
  return {
    request: {
      schemaVersion: 1 as const,
      capsule,
      expectedAuthorityDescriptorDigest: capsule.authorityDescriptor.descriptorDigest,
      verifiedAt: "2026-08-01T10:00:01.001Z",
    },
    policy: { maxAgeMs: 1000, authorityContextId: "deployment.production" },
    state: {
      schemaVersion: 1 as const,
      authorityContextId: "deployment.production",
      authorityDescriptorDigest: capsule.authorityDescriptor.descriptorDigest,
      consumedCapsuleIds: [] as readonly string[],
    },
  };
}

describe("evaluateChangeAuthorizationReuseV1", () => {
  it.each([
    ["2026-08-01T10:00:00.0009Z", "2026-08-01T10:00:00.0008Z"],
    ["2026-08-01T12:00:00.000900+0200", "2026-08-01T05:00:00.00089999999999999999-0500"],
  ])("rejects a clock before sealing at full fractional precision: %s / %s", (evaluatedAt, verifiedAt) => {
    const { request, policy, state } = fixture();
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput({ evaluatedAt }));
    const current = { ...request, capsule, verifiedAt };
    expect(() => evaluateChangeAuthorizationReuseV1(current, { ...policy, maxAgeMs: 0 }, state))
      .toThrow("change authorization verification request failed its public schema");
    expect(() => verifyChangeAuthorizationCapsuleV1(current))
      .toThrow("change authorization verification request failed its public schema");
    expect(state.consumedCapsuleIds).toEqual([]);
  });

  it("snapshots dense ordinary consumption arrays from another realm", () => {
    const { request, policy, state } = fixture();
    request.verifiedAt = request.capsule.evaluatedAt;
    const consumedCapsuleIds = runInNewContext('["previous"]') as string[];
    const report = evaluateChangeAuthorizationReuseV1(request, policy, { ...state, consumedCapsuleIds });
    expect(report.result).toBe("ACCEPTED");
    expect(report.nextState.consumedCapsuleIds).toEqual(["previous", request.capsule.capsuleId]);
    expect(consumedCapsuleIds).toEqual(["previous"]);
    const consumed = runInNewContext("JSON.parse(input)", { input: JSON.stringify([request.capsule.capsuleId]) }) as string[];
    expect(evaluateChangeAuthorizationReuseV1(request, policy, { ...state, consumedCapsuleIds: consumed }).reasonCode)
      .toBe("CAPSULE_ALREADY_CONSUMED");
  });

  it.each([
    ["2026-08-01T10:00:00.000Z", "2026-08-01T10:00:01.0009Z", 1000, "CAPSULE_EXPIRED"],
    ["2026-08-01T10:00:00.0009Z", "2026-08-01T10:00:01.0009000Z", 1000, "CAPSULE_REUSABLE"],
    ["2026-08-01T10:00:00.0009Z", "2026-08-01T10:00:01.0008Z", 1000, "CAPSULE_REUSABLE"],
    ["2026-08-01T10:00:00.0009Z", "2026-08-01T10:00:01.00091Z", 1000, "CAPSULE_EXPIRED"],
    ["2026-08-01T10:00:00Z", "2026-08-01T10:00:00.00099999999999999999Z", 1, "CAPSULE_REUSABLE"],
    ["2026-08-01T10:00:00.00010000000000000000Z", "2026-08-01T10:00:01.00010000000000000001Z", 1000, "CAPSULE_EXPIRED"],
    ["2026-08-01T12:00:00.0009+02:00", "2026-08-01T05:00:01.000900-05:00", 1000, "CAPSULE_REUSABLE"],
    ["2026-08-01T12:00:00.0009+02:00", "2026-08-01T05:00:01.00091-05:00", 1000, "CAPSULE_EXPIRED"],
    ["2026-08-01T12:00:00.0009+0200", "2026-08-01T05:00:01.000900-0500", 1000, "CAPSULE_REUSABLE"],
    ["2026-08-01T12:00:00.0009+0200", "2026-08-01T05:00:01.00091-0500", 1000, "CAPSULE_EXPIRED"],
    ["2026-08-01T10:00:00Z", "2026-08-01T12:00:00.000000+02:00", 0, "CAPSULE_REUSABLE"],
    ["2026-08-01T10:00:00Z", "2026-08-01T12:00:00.0000001+02:00", 0, "CAPSULE_EXPIRED"],
    ["2026-08-01T10:00:00.9999Z", "2026-08-01T10:00:01.0000Z", 1, "CAPSULE_REUSABLE"],
  ] as const)("preserves fractional age precision from %s to %s at %i ms", (evaluatedAt, verifiedAt, maxAgeMs, reasonCode) => {
    const { request, policy, state } = fixture();
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput({ evaluatedAt }));
    const current = { ...request, capsule, verifiedAt };
    const report = evaluateChangeAuthorizationReuseV1(current, { ...policy, maxAgeMs }, state);
    expect(report.verification.result).toBe("PASSED");
    expect(report.reasonCode).toBe(reasonCode);
    expect(report.result).toBe(reasonCode === "CAPSULE_REUSABLE" ? "ACCEPTED" : "REFUSED");
    expect(report.nextState.consumedCapsuleIds).toEqual(reasonCode === "CAPSULE_REUSABLE" ? [capsule.capsuleId] : []);
    expect(state.consumedCapsuleIds).toEqual([]);
    expect(report.executionAuthority).toBe("none");
    expect(verifyChangeAuthorizationCapsuleV1(current).result).toBe("PASSED");
  });

  it("refuses a capsule older than the explicit maximum even when offline verification passes", () => {
    const { request, policy, state } = fixture();
    const report = evaluateChangeAuthorizationReuseV1(request, policy, state);
    expect(report.verification.result).toBe("PASSED");
    expect(report.result).toBe("REFUSED");
    expect(report.reasonCode).toBe("CAPSULE_EXPIRED");
    expect(report.nextState).toEqual(state);
  });
  it("records a fresh capsule once and refuses the next consumption without mutating prior state", () => {
    const { request, policy, state } = fixture();
    request.verifiedAt = "2026-08-01T10:00:01.000Z";
    const first = evaluateChangeAuthorizationReuseV1(request, policy, state);
    expect(first.result).toBe("ACCEPTED");
    expect(first.nextState.consumedCapsuleIds).toEqual([request.capsule.capsuleId]);
    expect(state.consumedCapsuleIds).toEqual([]);
    const second = evaluateChangeAuthorizationReuseV1(request, policy, first.nextState);
    expect(second.result).toBe("REFUSED");
    expect(second.reasonCode).toBe("CAPSULE_ALREADY_CONSUMED");
    expect(second.nextState).toEqual(first.nextState);
  });

  it("refuses consumption state from another authority context", () => {
    const { request, policy, state } = fixture();
    request.verifiedAt = request.capsule.evaluatedAt;
    const report = evaluateChangeAuthorizationReuseV1(request, policy, { ...state, authorityContextId: "other" });
    expect(report.reasonCode).toBe("AUTHORITY_CONTEXT_MISMATCH");
    expect(report.result).toBe("REFUSED");
  });

  it("rejects malformed policy and missing consumption state rather than disabling the check", () => {
    const { request, policy, state } = fixture();
    for (const maxAgeMs of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => evaluateChangeAuthorizationReuseV1(request, { ...policy, maxAgeMs }, state))
        .toThrow("invalid change authorization reuse policy");
    }
    expect(() => evaluateChangeAuthorizationReuseV1(request, { ...policy, authorityContextId: "" }, state))
      .toThrow("invalid change authorization reuse policy");
    expect(() => evaluateChangeAuthorizationReuseV1(request, policy, undefined as never))
      .toThrow("invalid change authorization consumption state");
  });

  it("does not consume a malformed capsule", () => {
    const { request, policy, state } = fixture();
    const report = evaluateChangeAuthorizationReuseV1({ ...request, capsule: {} }, policy, state);
    expect(report.result).toBe("REFUSED");
    expect(report.reasonCode).toBe("CAPSULE_VERIFICATION_NOT_PASSED");
    expect(report.nextState).toEqual(state);
  });

  it("is deterministic and leaves offline stateless replay available after consumption", () => {
    const { request, policy, state } = fixture();
    request.verifiedAt = request.capsule.evaluatedAt;
    Object.freeze(state.consumedCapsuleIds);
    Object.freeze(state);
    const first = evaluateChangeAuthorizationReuseV1(request, policy, state);
    expect(evaluateChangeAuthorizationReuseV1(request, policy, state)).toEqual(first);
    expect(evaluateChangeAuthorizationReuseV1(request, policy, first.nextState).result).toBe("REFUSED");
    expect(verifyChangeAuthorizationCapsuleV1(request).result).toBe("PASSED");
    expect(first.executionAuthority).toBe("none");
  });

  it("uses capsule identity rather than its hash to prevent consumption after resealing", () => {
    const { request, policy, state } = fixture();
    request.verifiedAt = request.capsule.evaluatedAt;
    const first = evaluateChangeAuthorizationReuseV1(request, policy, state);
    const resealed = evaluateChangeAuthorizationV1(baseEvaluationInput({ evaluatedAt: "2026-08-01T10:00:01.000Z" }));
    expect(resealed.capsuleHash).not.toBe(request.capsule.capsuleHash);
    const report = evaluateChangeAuthorizationReuseV1({ ...request, capsule: resealed, verifiedAt: resealed.evaluatedAt }, policy, first.nextState);
    expect(report.reasonCode).toBe("CAPSULE_ALREADY_CONSUMED");
  });

  it("refuses an authority pin differing from the state's externally pinned authority", () => {
    const { request, policy, state } = fixture();
    request.verifiedAt = request.capsule.evaluatedAt;
    for (const expectedAuthorityDescriptorDigest of [null, `sha256:${"0".repeat(64)}` as const]) {
      const report = evaluateChangeAuthorizationReuseV1({ ...request, expectedAuthorityDescriptorDigest }, policy, state);
      expect(report.result).toBe("REFUSED");
      expect(report.reasonCode).toBe("AUTHORITY_CONTEXT_MISMATCH");
      expect(report.nextState).toEqual(state);
    }
  });

  it("never consumes DENY or REQUIRE_EVIDENCE decisions", () => {
    for (const basisRecord of [record("VIOLATED"), record("UNPROVEN")]) {
      const { request, policy, state } = fixture();
      const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput({ basisRecord }));
      const report = evaluateChangeAuthorizationReuseV1({ ...request, capsule, verifiedAt: capsule.evaluatedAt }, policy, state);
      expect(report.result).toBe("REFUSED");
      expect(report.reasonCode).toBe("CAPSULE_VERIFICATION_NOT_PASSED");
      expect(report.nextState).toEqual(state);
    }
  });

  it("rejects a missing clock, a malformed clock and a clock before sealing", () => {
    const { request, policy, state } = fixture();
    for (const verifiedAt of [undefined, "not-a-date", "2026-08-01T09:59:59.999Z"]) {
      expect(() => evaluateChangeAuthorizationReuseV1({ ...request, verifiedAt } as typeof request, policy, state))
        .toThrow("change authorization verification request failed its public schema");
    }
  });

  it("accepts the same instant with zero maximum age and compares explicit timezone offsets", () => {
    const { request, policy, state } = fixture();
    const atSealing = evaluateChangeAuthorizationReuseV1({ ...request, verifiedAt: "2026-08-01T12:00:00.000+02:00" }, { ...policy, maxAgeMs: 0 }, state);
    expect(atSealing.result).toBe("ACCEPTED");
    expect(evaluateChangeAuthorizationReuseV1({ ...request, verifiedAt: "2026-08-01T12:00:00.001+02:00" }, { ...policy, maxAgeMs: 0 }, state).reasonCode).toBe("CAPSULE_EXPIRED");
  });

  it("scopes consumption to the explicit authority context", () => {
    const { request, policy, state } = fixture();
    request.verifiedAt = request.capsule.evaluatedAt;
    const first = evaluateChangeAuthorizationReuseV1(request, policy, state);
    const otherContext = { ...state, authorityContextId: "deployment.staging" };
    const otherPolicy = { ...policy, authorityContextId: "deployment.staging" };
    expect(evaluateChangeAuthorizationReuseV1(request, otherPolicy, otherContext).result).toBe("ACCEPTED");
    expect(evaluateChangeAuthorizationReuseV1(request, otherPolicy, first.nextState).result).toBe("REFUSED");
  });

  it("rejects corrupt or incomplete consumption state", () => {
    const { request, policy, state } = fixture();
    const invalidStates = [
      null,
      {},
      { ...state, schemaVersion: 2 },
      { ...state, authorityContextId: " " },
      { ...state, authorityDescriptorDigest: "broken" },
      { ...state, consumedCapsuleIds: undefined },
      { ...state, consumedCapsuleIds: [""] },
      { ...state, consumedCapsuleIds: ["same", "same"] },
      { ...state, consumedCapsuleIds: Array<string>(1) },
    ];
    for (const invalidState of invalidStates) {
      expect(() => evaluateChangeAuthorizationReuseV1(request, policy, invalidState as typeof state))
        .toThrow("invalid change authorization consumption state");
    }
  });

  it("refuses evidence expiry even while the capsule itself is younger than the maximum age", () => {
    const { request, policy, state } = fixture();
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput({
      assertions: [passingAssertionInput({ expiresAt: "2026-08-01T10:00:00.500Z" })],
    }));
    const report = evaluateChangeAuthorizationReuseV1({ ...request, capsule, verifiedAt: "2026-08-01T10:00:00.501Z" }, policy, state);
    expect(report.reasonCode).toBe("CAPSULE_VERIFICATION_NOT_PASSED");
    expect(report.verification.semantic.currentVerdict).toBe("REQUIRE_EVIDENCE");
    expect(report.nextState).toEqual(state);
  });

  it("refuses a capsule whose hash has been corrupted", () => {
    const { request, policy, state } = fixture();
    const report = evaluateChangeAuthorizationReuseV1({ ...request, capsule: { ...request.capsule, capsuleHash: `sha256:${"0".repeat(64)}` } }, policy, state);
    expect(report.result).toBe("REFUSED");
    expect(report.verification.integrity.result).toBe("INVALID");
    expect(report.nextState).toEqual(state);
  });

  it("returns reusable consumption state for every canonical capsule identity, including whitespace", () => {
    const { request, policy, state } = fixture();
    const capsule = evaluateChangeAuthorizationV1(baseEvaluationInput({ capsuleId: " " }));
    const current = { ...request, capsule, verifiedAt: capsule.evaluatedAt };
    const first = evaluateChangeAuthorizationReuseV1(current, policy, state);
    expect(first.result).toBe("ACCEPTED");
    expect(evaluateChangeAuthorizationReuseV1(current, policy, first.nextState).reasonCode).toBe("CAPSULE_ALREADY_CONSUMED");
  });

  it("refuses a malformed timezone offset rather than comparing an invalid instant", () => {
    const { request, policy, state } = fixture();
    expect(() => evaluateChangeAuthorizationReuseV1({ ...request, verifiedAt: "2026-08-01T10:00:01.001+24:00" }, policy, state))
      .toThrow("change authorization verification request failed its public schema");
  });

  it("rejects executable policy and request accessors instead of reading different values", () => {
    const { request, policy, state } = fixture();
    let reads = 0;
    const executablePolicy = { ...policy, get maxAgeMs() { return ++reads < 3 ? 1000 : NaN; } };
    expect(() => evaluateChangeAuthorizationReuseV1(request, executablePolicy, state))
      .toThrow("invalid change authorization reuse policy");
    const executableRequest = { ...request, get capsule() { return request.capsule; } };
    expect(() => evaluateChangeAuthorizationReuseV1(executableRequest, policy, state))
      .toThrow("change authorization verification request failed its public schema");
  });

  it("rejects executable consumption history that overrides membership checks", () => {
    const { request, policy, state } = fixture();
    const consumedCapsuleIds = [request.capsule.capsuleId];
    consumedCapsuleIds.includes = () => false;
    expect(() => evaluateChangeAuthorizationReuseV1({ ...request, verifiedAt: request.capsule.evaluatedAt }, policy, { ...state, consumedCapsuleIds }))
      .toThrow("invalid change authorization consumption state");
  });

  it("rejects consumption history with inherited executable membership checks", () => {
    const { request, policy, state } = fixture();
    class ForgedHistory extends Array<string> {
      override includes(): boolean { return false; }
    }
    const consumedCapsuleIds = new ForgedHistory(request.capsule.capsuleId);
    expect(() => evaluateChangeAuthorizationReuseV1({ ...request, verifiedAt: request.capsule.evaluatedAt }, policy, { ...state, consumedCapsuleIds }))
      .toThrow("invalid change authorization consumption state");
  });

});
