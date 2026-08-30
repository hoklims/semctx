import { canonicalizeEvidenceRefs, sha256HashUtf8 } from "./hashing";
import { compareCodeUnits } from "./ordering";
import type { Sha256Hash } from "./types";
import {
  CHANGE_AUTHORIZATION_PREDICATE_TYPE_V1,
  CHANGE_AUTHORIZATION_REASON_ORDER,
  type ChangeAuthorizationAssertionV1,
  type ChangeAuthorizationAuthorityDescriptorV1,
  type ChangeAuthorizationCapsuleV1,
  type ChangeAuthorizationClaimV1,
  type ChangeAuthorizationEvidenceBundleV1,
  type ChangeAuthorizationEvidenceUniverseV1,
  type ChangeAuthorizationInTotoStatementV1,
  type ChangeAuthorizationPolicyEvaluationV1,
  type ChangeAuthorizationPolicyRuleV1,
  type ChangeAuthorizationReasonCodeV1,
  type ChangeAuthorizationSubjectV1,
} from "./change-authorization-types";

const SUBJECT_DOMAIN = "SEMCTX_CHANGE_AUTHORIZATION_SUBJECT_V1\0";
const EVIDENCE_DOMAIN = "SEMCTX_CHANGE_AUTHORIZATION_EVIDENCE_V1\0";
const EVIDENCE_BUNDLE_DOMAIN = "SEMCTX_CHANGE_AUTHORIZATION_EVIDENCE_BUNDLE_V1\0";
const POLICY_EVALUATION_DOMAIN = "SEMCTX_CHANGE_AUTHORIZATION_POLICY_EVALUATION_V1\0";
const CAPSULE_DOMAIN = "SEMCTX_CHANGE_AUTHORIZATION_CAPSULE_V1\0";
const CLAIM_DOMAIN = "SEMCTX_CHANGE_AUTHORIZATION_CLAIM_V1\0";
const POLICY_RULE_SET_DOMAIN = "SEMCTX_CHANGE_AUTHORIZATION_POLICY_RULE_SET_V1\0";
const TRUST_ROOT_SET_DOMAIN = "SEMCTX_CHANGE_AUTHORIZATION_TRUST_ROOT_SET_V1\0";
const AUTHORITY_DESCRIPTOR_DOMAIN = "SEMCTX_CHANGE_AUTHORIZATION_AUTHORITY_DESCRIPTOR_V1\0";
const EVIDENCE_UNIVERSE_DOMAIN = "SEMCTX_CHANGE_AUTHORIZATION_EVIDENCE_UNIVERSE_V1\0";

/**
 * RFC 8785 (JCS) canonicalization for the change-authorization contract. Kept distinct from
 * `serializeControlReport`, which only sorts object keys and preserves JS number formatting
 * without rejecting non-finite values or normalizing negative zero.
 */
export function canonicalizeChangeAuthorizationValueV1(value: unknown): unknown {
  return canonicalizeJcs(value);
}

export function serializeChangeAuthorizationJcsV1(value: unknown): string {
  return serializeCanonicalJcs(canonicalizeJcs(value));
}

/** True when `value` can be losslessly round-tripped through JCS canonicalization. */
export function isChangeAuthorizationJcsSafeV1(value: unknown): boolean {
  try {
    canonicalizeJcs(value);
    return true;
  } catch {
    return false;
  }
}

export function changeAuthorizationDomainHashV1(domain: string, value: unknown): Sha256Hash {
  return sha256HashUtf8(`${domain}${serializeChangeAuthorizationJcsV1(value)}`);
}

/** True when `value` contains a high or low UTF-16 surrogate with no matching counterpart (invalid I-JSON). */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalizeJcs(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) throw new Error("JCS cannot encode a string with an unpaired UTF-16 surrogate");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS cannot encode a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new Error("JCS cannot encode a sparse array");
      }
    }
    for (const key of ownKeys) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
        throw new Error("JCS cannot encode an array with non-index properties");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new Error("JCS cannot encode an array accessor or non-enumerable element");
      }
    }
    return value.map(canonicalizeJcs);
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("JCS can encode only plain JSON objects");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new Error("JCS cannot encode symbol properties");
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new Error("JCS cannot encode accessors or non-enumerable properties");
      }
      if (descriptor.value === undefined) throw new Error("JCS cannot encode undefined");
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key]) => {
          if (hasLoneSurrogate(key)) throw new Error("JCS cannot encode a property name with an unpaired UTF-16 surrogate");
          return key;
        })
        .sort(compareCodeUnits)
        .map((key) => [key, canonicalizeJcs((value as Record<string, unknown>)[key])]),
    );
  }
  throw new Error(`JCS cannot encode a ${typeof value} value`);
}

function serializeCanonicalJcs(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalJcs).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort(compareCodeUnits)
      .map((key) => `${JSON.stringify(key)}:${serializeCanonicalJcs(object[key])}`)
      .join(",")}}`;
  }
  throw new Error(`JCS cannot serialize a ${typeof value} value`);
}

export function canonicalizeChangeAuthorizationReasons(
  reasons: readonly ChangeAuthorizationReasonCodeV1[],
): readonly ChangeAuthorizationReasonCodeV1[] {
  return [...new Set(reasons)].sort(
    (left, right) =>
      CHANGE_AUTHORIZATION_REASON_ORDER.indexOf(left) - CHANGE_AUTHORIZATION_REASON_ORDER.indexOf(right),
  );
}

export function computeChangeAuthorizationSubjectV1Hash(
  value: Omit<ChangeAuthorizationSubjectV1, "subjectHash"> & { subjectHash?: Sha256Hash },
): Sha256Hash {
  const { subjectHash: _hash, ...payload } = normalizeChangeAuthorizationSubjectV1(
    value as ChangeAuthorizationSubjectV1,
  );
  return changeAuthorizationDomainHashV1(SUBJECT_DOMAIN, payload);
}

export function normalizeChangeAuthorizationSubjectV1(
  value: ChangeAuthorizationSubjectV1,
): ChangeAuthorizationSubjectV1 {
  return {
    ...value,
    parentIntentIds: sortedUnique(value.parentIntentIds),
    nonGoals: sortedUnique(value.nonGoals),
    expectedBehaviorDelta: sortedUnique(value.expectedBehaviorDelta),
    touchedCoordinateIds: sortedUnique(value.touchedCoordinateIds),
  };
}

export function computeChangeAuthorizationClaimV1Hash(
  value: Omit<ChangeAuthorizationClaimV1, "claimHash"> & { claimHash?: Sha256Hash },
): Sha256Hash {
  const { claimHash: _hash, ...payload } = value;
  return changeAuthorizationDomainHashV1(CLAIM_DOMAIN, payload);
}

export function computeChangeAuthorizationAssertionV1Hash(
  value: Omit<ChangeAuthorizationAssertionV1, "assertionHash"> & { assertionHash?: Sha256Hash },
): Sha256Hash {
  const { assertionHash: _hash, ...payload } = normalizeChangeAuthorizationAssertionV1(
    value as ChangeAuthorizationAssertionV1,
  );
  return changeAuthorizationDomainHashV1(EVIDENCE_DOMAIN, payload);
}

export function normalizeChangeAuthorizationAssertionV1(
  value: ChangeAuthorizationAssertionV1,
): ChangeAuthorizationAssertionV1 {
  return {
    ...value,
    scope: { ...value.scope, coordinateIds: sortedUnique(value.scope.coordinateIds) },
    artifacts: canonicalizeEvidenceRefs(value.artifacts),
    dependsOnAssertionHashes: sortedUnique(value.dependsOnAssertionHashes),
    contradicts: sortedUnique(value.contradicts),
  };
}

export function computeChangeAuthorizationEvidenceBundleV1Hash(
  value: Omit<ChangeAuthorizationEvidenceBundleV1, "bundleHash"> & { bundleHash?: Sha256Hash },
): Sha256Hash {
  const { bundleHash: _hash, ...payload } = value;
  return changeAuthorizationDomainHashV1(EVIDENCE_BUNDLE_DOMAIN, {
    ...payload,
    assertionHashes: sortedUnique(payload.assertionHashes),
  });
}

export function computeChangeAuthorizationEvidenceUniverseV1Hash(
  value: Omit<ChangeAuthorizationEvidenceUniverseV1, "universeHash"> & { universeHash?: Sha256Hash },
): Sha256Hash {
  const { universeHash: _hash, ...payload } = value;
  return changeAuthorizationDomainHashV1(EVIDENCE_UNIVERSE_DOMAIN, {
    ...payload,
    assertionHashes: sortedUnique(payload.assertionHashes),
    bundleHashes: sortedUnique(payload.bundleHashes),
  });
}

export function computeChangeAuthorizationPolicyRuleSetV1Hash(
  rules: readonly (Omit<ChangeAuthorizationPolicyRuleV1, "scopeCoordinateIds"> & {
    scopeCoordinateIds?: readonly string[];
  })[],
): Sha256Hash {
  const normalized = rules.map(({ scopeCoordinateIds, requiredCapability, ...rule }) => ({
    ...rule,
    ...(scopeCoordinateIds === undefined ? {} : { scopeCoordinateIds }),
    ...(requiredCapability === undefined ? {} : { requiredCapability }),
  }));
  const sorted = normalized.sort((left, right) => compareCodeUnits(left.ruleId, right.ruleId));
  return changeAuthorizationDomainHashV1(POLICY_RULE_SET_DOMAIN, sorted);
}

export function computeChangeAuthorizationTrustRootSetV1Hash(
  trustRootIds: readonly string[],
): Sha256Hash {
  return changeAuthorizationDomainHashV1(TRUST_ROOT_SET_DOMAIN, sortedUnique(trustRootIds));
}

export function computeChangeAuthorizationAuthorityDescriptorV1Hash(
  value: Omit<ChangeAuthorizationAuthorityDescriptorV1, "descriptorDigest"> & { descriptorDigest?: Sha256Hash },
): Sha256Hash {
  const { descriptorDigest: _hash, ...payload } = value;
  return changeAuthorizationDomainHashV1(AUTHORITY_DESCRIPTOR_DOMAIN, {
    ...payload,
    trustRootIds: sortedUnique(payload.trustRootIds),
  });
}

export function computeChangeAuthorizationPolicyEvaluationV1Hash(
  value: Omit<ChangeAuthorizationPolicyEvaluationV1, "evaluationHash"> & { evaluationHash?: Sha256Hash },
): Sha256Hash {
  const { evaluationHash: _hash, ...payload } = value;
  return changeAuthorizationDomainHashV1(POLICY_EVALUATION_DOMAIN, {
    ...payload,
    reasonCodes: canonicalizeChangeAuthorizationReasons(payload.reasonCodes),
    contributingAssertionHashes: sortedUnique(payload.contributingAssertionHashes),
  });
}

export function computeChangeAuthorizationCapsuleV1Hash(
  value: Omit<ChangeAuthorizationCapsuleV1, "capsuleHash"> & { capsuleHash?: Sha256Hash },
): Sha256Hash {
  const { capsuleHash: _hash, ...payload } = value;
  return changeAuthorizationDomainHashV1(CAPSULE_DOMAIN, {
    ...payload,
    providers: [...payload.providers].sort((a, b) => compareCodeUnits(a.providerId, b.providerId)),
    claims: [...payload.claims].sort((a, b) => compareCodeUnits(a.claimHash, b.claimHash)),
    assertions: payload.assertions
      .map(normalizeChangeAuthorizationAssertionV1)
      .sort((a, b) => compareCodeUnits(a.assertionHash, b.assertionHash)),
    evidenceBundles: [...payload.evidenceBundles].sort((a, b) => compareCodeUnits(a.bundleHash, b.bundleHash)),
    policyRules: [...payload.policyRules].sort((a, b) => compareCodeUnits(a.ruleId, b.ruleId)),
    policyEvaluations: [...payload.policyEvaluations]
      .sort((a, b) => compareCodeUnits(a.evaluationHash, b.evaluationHash)),
    reasonCodes: canonicalizeChangeAuthorizationReasons(payload.reasonCodes),
  });
}

export function buildChangeAuthorizationInTotoStatementV1(
  capsule: ChangeAuthorizationCapsuleV1,
): ChangeAuthorizationInTotoStatementV1 {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{
      name: capsule.subject.changeId,
      digest: { sha256: capsule.subject.subjectHash.slice("sha256:".length) },
    }],
    predicateType: CHANGE_AUTHORIZATION_PREDICATE_TYPE_V1,
    predicate: capsule,
  };
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareCodeUnits);
}
