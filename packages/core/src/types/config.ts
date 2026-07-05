/** Persisted project configuration (.semctx/config.json). Boundary-validated by Zod. */

export type BlockingCondition =
  | "invariant_touched_without_test"
  | "critical_contract_changed_without_test"
  | "contract_changed_without_test"
  | "contradiction_unresolved"
  | "security_surface_without_verification";

/**
 * Severity tier of a rule (see docs/concepts/verify-diff.md):
 *   - strict   → BLOCK: an invariant or a *critical* contract changed without a proving test.
 *   - advisory → WARN : an exported contract changed without a direct test, or an unresolved
 *                       contradiction is touched.
 * Optional on disk for backward compatibility; when absent it is derived from `severity`
 * (block → strict, warn → advisory) via `tierOf`.
 */
export type SeverityTier = "strict" | "advisory";

export interface BlockingRule {
  id: string;
  description: string;
  when: BlockingCondition;
  severity: "warn" | "block";
  tier?: SeverityTier;
}

/**
 * Semantic Layer policy (Plane B). Optional and additive: when absent, `resolveSemanticPolicy`
 * (in `@semantic-context/semantic-engine`) applies these defaults. Governs how the authored
 * semantic model composes with `verify diff` in `change verify`.
 */
export interface SemanticPolicyConfig {
  /** Master switch for the semantic layer's verdict contribution. */
  enabled: boolean;
  /** Invariant tags that make a preserved-but-unproven invariant a BLOCK, not a WARN. */
  criticalInvariantTags: string[];
  /** Verdict weight of an open, non-critical unknown on an active change. */
  openUnknownSeverity: "warn" | "block";
  /** Verdict weight of an active change that relies on a superseded decision. */
  supersededDecisionSeverity: "warn" | "block";
  /** When true, an active change that declares it preserves an invariant must carry proof. */
  requireProofForActiveChange: boolean;
}

export interface SemctxConfig {
  version: number;
  repositoryRoot: string;
  include: string[];
  exclude: string[];
  docsDirs: string[];
  migrationsDirs: string[];
  testGlobs: string[];
  /** Optional semantic candidate provider. "none" keeps the tool fully local. */
  semanticProvider: "none" | "cocoindex";
  blockingRules: BlockingRule[];
  /** Optional Semantic Layer policy (Plane B). Absent = defaults. */
  semantic?: SemanticPolicyConfig;
}
