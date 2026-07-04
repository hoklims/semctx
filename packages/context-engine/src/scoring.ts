/**
 * Deterministic scoring primitives.
 *
 * These are the ONLY place raw numbers are assigned to a verification status. They are
 * documented constants, not magic: authority, freshness and verification strength are
 * derived here and nowhere else, so the whole ranking is auditable from one file.
 *
 * Numbers never decide selection alone (ADR 0003): gates run first in the priority
 * engine. These values only order the sources that already survived the gates.
 */
import type { VerificationStatus } from "@semantic-context/core";

/** Base authority by how the claim is verified. Strong verification => high authority. */
export const AUTHORITY_BY_STATUS: Record<VerificationStatus, number> = {
  statically_verified: 0.95,
  runtime_verified: 0.9,
  tested: 0.85,
  documented: 0.6,
  inferred: 0.4,
  unverified: 0.25,
  contradicted: 0.15,
  deprecated: 0.1,
};

/** How strongly the status proves the claim (used as a distinct ranking component). */
export const VERIFICATION_STRENGTH: Record<VerificationStatus, number> = {
  statically_verified: 1.0,
  runtime_verified: 0.95,
  tested: 0.85,
  documented: 0.5,
  inferred: 0.3,
  unverified: 0.15,
  contradicted: 0.1,
  deprecated: 0.05,
};

/** Freshness heuristic. Deprecated/contradicted are stale by definition. */
export const FRESHNESS_BY_STATUS: Record<VerificationStatus, number> = {
  statically_verified: 0.9,
  runtime_verified: 0.9,
  tested: 0.85,
  documented: 0.7,
  inferred: 0.6,
  unverified: 0.5,
  contradicted: 0.1,
  deprecated: 0.05,
};

export function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Confidence: a bounded blend of authority, freshness and corroboration.
 * corroboration = distinct evidence source kinds / 3 (code + test + doc = fully corroborated).
 */
export function computeConfidence(authority: number, freshness: number, distinctSourceKinds: number): number {
  const corroboration = clamp01(distinctSourceKinds / 3);
  return clamp01(0.5 * authority + 0.3 * freshness + 0.2 * corroboration);
}

/** Ranking weights. Documented and summing to 1 before the contradiction penalty. */
export const WEIGHTS = {
  roleMatch: 0.25,
  authority: 0.25,
  graphReachability: 0.15,
  verificationStrength: 0.2,
  freshness: 0.15,
} as const;

export function roleMatchScore(preferredIndex: number, preferredCount: number): number {
  if (preferredIndex < 0) return 0.3; // not a preferred kind for this question
  if (preferredCount <= 1) return 1;
  // First preferred kind = 1.0, decaying gently for later ones, floor 0.7.
  return clamp01(1 - (preferredIndex / preferredCount) * 0.3);
}

/** Graph reachability by hop distance from a task entrypoint (closer => higher). */
export function reachabilityScore(hopDistance: number | undefined): number {
  if (hopDistance === undefined) return 0; // unreachable
  if (hopDistance <= 0) return 1;
  return clamp01(1 / (1 + hopDistance));
}
