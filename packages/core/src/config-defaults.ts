import type { SemctxConfig, BlockingRule, SeverityTier } from "./types/config";

/** The tier of a rule; derived from severity when not explicitly set (block → strict, warn → advisory). */
export function tierOf(rule: BlockingRule): SeverityTier {
  return rule.tier ?? (rule.severity === "block" ? "strict" : "advisory");
}

export const DEFAULT_BLOCKING_RULES: BlockingRule[] = [
  // --- strict tier → BLOCK: an invariant or a critical contract changed without a proving test.
  {
    id: "invariant-needs-test",
    description: "A change touching an invariant-constrained symbol must be covered by a test.",
    when: "invariant_touched_without_test",
    severity: "block",
    tier: "strict",
  },
  {
    id: "critical-contract-needs-test",
    description:
      "A change to a critical exported contract (tagged `critical`/`security`) must be covered by a test.",
    when: "critical_contract_changed_without_test",
    severity: "block",
    tier: "strict",
  },
  {
    id: "security-needs-verification",
    description: "A security-surface change needs an explicit verification.",
    when: "security_surface_without_verification",
    severity: "block",
    tier: "strict",
  },
  // --- advisory tier → WARN: exported contract without a direct test, or a touched contradiction.
  {
    id: "contract-needs-test",
    description: "A change to an exported contract should be covered by a contract test.",
    when: "contract_changed_without_test",
    severity: "warn",
    tier: "advisory",
  },
  {
    id: "contradiction-unresolved",
    description: "An unresolved contradiction in touched sources should be surfaced.",
    when: "contradiction_unresolved",
    severity: "warn",
    tier: "advisory",
  },
];

/** Pure default configuration for a repository. No filesystem access. */
export function createDefaultConfig(repositoryRoot: string): SemctxConfig {
  return {
    version: 1,
    repositoryRoot,
    include: ["src/**/*.ts"],
    exclude: ["node_modules", "dist", ".semctx", ".git", "coverage"],
    docsDirs: ["docs"],
    migrationsDirs: ["migrations"],
    testGlobs: ["**/*.test.ts", "**/*.spec.ts", "test/**/*.ts"],
    semanticProvider: "none",
    blockingRules: DEFAULT_BLOCKING_RULES,
  };
}
