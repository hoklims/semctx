/**
 * Runtime project configuration after `loadConfig`.
 * On disk (`.semctx/config.json`) this is policy-only: `repositoryRoot` is never persisted and is
 * always injected from the call/CLI root at load time (see #82).
 */

export type BlockingCondition =
  | "invariant_touched_without_test"
  | "critical_contract_changed_without_test"
  | "contract_changed_without_test"
  | "contradiction_unresolved"
  | "security_surface_without_verification"
  | "analysis_scope_incomplete"
  | "index_binding_stale";

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

interface SemctxConfigBase {
  /**
   * Canonical absolute repository root for this process. Runtime-only: never written to
   * `.semctx/config.json` (call parameter / CLI `--root` is the source of truth).
   */
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

/** Compatibility configuration: `include` remains informational and discovery keeps legacy behavior. */
export interface SemctxConfigV1 extends SemctxConfigBase {
  version: 1;
}

export type LanguageAnalysisMode = "on" | "off";

/**
 * Explicit source-selection migration. Version 2 is opt-in because applying `include` can
 * intentionally shrink the selected source set and therefore changes Plane-A fingerprints.
 */
export interface SemctxConfigV2 extends SemctxConfigBase {
  version: 2;
  selectionMode: "globs-v1";
  /** Language analysis is explicit. A selected language absent from this registry is unsupported. */
  languages: Record<string, LanguageAnalysisMode>;
}

export type SemctxConfig = SemctxConfigV1 | SemctxConfigV2;
