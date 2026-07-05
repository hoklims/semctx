/** Resolve the Semantic Layer policy from `SemctxConfig`, applying defaults when the block is absent. */

import type { SemctxConfig, SemanticPolicyConfig } from "@semantic-context/core";

export const DEFAULT_SEMANTIC_POLICY: SemanticPolicyConfig = {
  enabled: true,
  criticalInvariantTags: ["critical", "security"],
  openUnknownSeverity: "warn",
  supersededDecisionSeverity: "warn",
  requireProofForActiveChange: true,
};

export function resolveSemanticPolicy(config: SemctxConfig): SemanticPolicyConfig {
  const provided = config.semantic;
  if (provided === undefined) return DEFAULT_SEMANTIC_POLICY;
  return { ...DEFAULT_SEMANTIC_POLICY, ...provided };
}
