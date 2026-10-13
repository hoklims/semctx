import {
  canonicalizeChangeAuthorizationValueV1,
  ChangeAuthorizationCapsuleV1Schema,
  Sha256HashSchema,
  type Sha256Hash,
} from "@semantic-context/control-model";
import type {
  ChangeAuthorizationVerificationReportV1,
  ChangeAuthorizationVerificationRequestV1,
} from "./types";
import { verifyChangeAuthorizationCapsuleV1 } from "./verify";
import { compareTimestampAgeV1 } from "./schemas";

export interface ChangeAuthorizationReusePolicyV1 {
  maxAgeMs: number;
  authorityContextId: string;
}

export interface ChangeAuthorizationConsumptionStateV1 {
  schemaVersion: 1;
  authorityContextId: string;
  authorityDescriptorDigest: Sha256Hash;
  consumedCapsuleIds: readonly string[];
}

export type ChangeAuthorizationReuseReasonV1 =
  | "CAPSULE_REUSABLE"
  | "CAPSULE_EXPIRED"
  | "CAPSULE_ALREADY_CONSUMED"
  | "AUTHORITY_CONTEXT_MISMATCH"
  | "CAPSULE_VERIFICATION_NOT_PASSED";

export interface ChangeAuthorizationReuseReportV1 {
  schemaVersion: 1;
  kind: "change_authorization_reuse_report";
  executionAuthority: "none";
  result: "ACCEPTED" | "REFUSED";
  reasonCode: ChangeAuthorizationReuseReasonV1;
  verification: ChangeAuthorizationVerificationReportV1;
  nextState: ChangeAuthorizationConsumptionStateV1;
}

export function evaluateChangeAuthorizationReuseV1(
  inputRequest: ChangeAuthorizationVerificationRequestV1,
  inputPolicy: ChangeAuthorizationReusePolicyV1,
  inputState: ChangeAuthorizationConsumptionStateV1,
): ChangeAuthorizationReuseReportV1 {
  const request = snapshotJsonInput(inputRequest, "change authorization verification request failed its public schema");
  const policy = snapshotJsonInput(inputPolicy, "invalid change authorization reuse policy");
  const state = snapshotJsonInput(inputState, "invalid change authorization consumption state");
  assertPolicy(policy);
  assertConsumptionState(state);
  const verification = verifyChangeAuthorizationCapsuleV1(request);
  const capsule = ChangeAuthorizationCapsuleV1Schema.safeParse(request.capsule);
  const report = (reasonCode: ChangeAuthorizationReuseReasonV1): ChangeAuthorizationReuseReportV1 => ({
    schemaVersion: 1,
    kind: "change_authorization_reuse_report",
    executionAuthority: "none",
    result: reasonCode === "CAPSULE_REUSABLE" ? "ACCEPTED" : "REFUSED",
    reasonCode,
    verification,
    nextState: reasonCode === "CAPSULE_REUSABLE" && capsule.success
      ? { ...state, consumedCapsuleIds: [...state.consumedCapsuleIds, capsule.data.capsuleId] }
      : state,
  });

  if (policy.authorityContextId !== state.authorityContextId
    || request.expectedAuthorityDescriptorDigest !== state.authorityDescriptorDigest) {
    return report("AUTHORITY_CONTEXT_MISMATCH");
  }
  if (verification.result !== "PASSED" || !capsule.success) {
    return report("CAPSULE_VERIFICATION_NOT_PASSED");
  }
  if (compareTimestampAgeV1(request.verifiedAt, capsule.data.evaluatedAt, policy.maxAgeMs) > 0) {
    return report("CAPSULE_EXPIRED");
  }
  if (state.consumedCapsuleIds.includes(capsule.data.capsuleId)) {
    return report("CAPSULE_ALREADY_CONSUMED");
  }
  return report("CAPSULE_REUSABLE");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertPolicy(policy: ChangeAuthorizationReusePolicyV1): void {
  if (policy === null || typeof policy !== "object"
    || !Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs < 0
    || !isNonEmptyString(policy.authorityContextId)) {
    throw new Error("invalid change authorization reuse policy");
  }
}

function assertConsumptionState(state: ChangeAuthorizationConsumptionStateV1): void {
  if (state === null || typeof state !== "object" || state.schemaVersion !== 1
    || !isNonEmptyString(state.authorityContextId)
    || !Sha256HashSchema.safeParse(state.authorityDescriptorDigest).success
    || !Array.isArray(state.consumedCapsuleIds)
    || !state.consumedCapsuleIds.every((id) => typeof id === "string" && id.length > 0)
    || new Set(state.consumedCapsuleIds).size !== state.consumedCapsuleIds.length) {
    throw new Error("invalid change authorization consumption state");
  }
}

function snapshotJsonInput<T>(value: T, errorMessage: string): T {
  try {
    return canonicalizeChangeAuthorizationValueV1(value) as T;
  } catch {
    throw new Error(errorMessage);
  }
}
