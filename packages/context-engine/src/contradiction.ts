import { compareIds } from "@semantic-context/core";
import type { Claim } from "@semantic-context/core";

export interface ContradictionReport {
  /** Non-normative claims (deprecated or contradicted). Shown, never treated as truth. */
  contradictions: Claim[];
  /** Claim ids that must not pass the priority engine's contradiction gate. */
  contradictedClaimIds: Set<string>;
}

const NON_NORMATIVE = new Set(["deprecated", "contradicted"]);

/**
 * Identify contradictions. A claim is non-normative when its verification status is
 * `deprecated` or `contradicted`. These are surfaced in the pack as contradictions so an
 * agent sees them explicitly, but they are barred from becoming authoritative.
 */
export function detectContradictions(claims: readonly Claim[]): ContradictionReport {
  const contradictions: Claim[] = [];
  const contradictedClaimIds = new Set<string>();
  for (const claim of claims) {
    if (NON_NORMATIVE.has(claim.verificationStatus)) {
      contradictions.push(claim);
      contradictedClaimIds.add(claim.id);
    }
  }
  contradictions.sort((a, b) => b.confidence - a.confidence || compareIds(a.id, b.id));
  return { contradictions, contradictedClaimIds };
}
