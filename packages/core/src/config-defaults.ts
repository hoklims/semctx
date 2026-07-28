import type {
  SemctxConfigV1,
  SemctxConfigV2,
  BlockingRule,
  SeverityTier,
} from "./types/config";

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
export function createDefaultConfig(repositoryRoot: string): SemctxConfigV1 {
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

/** Explicit opt-in configuration for deterministic include/exclude selection and polyglot analysis. */
export function createGlobSelectionConfig(repositoryRoot: string): SemctxConfigV2 {
  const legacy = createDefaultConfig(repositoryRoot);
  return {
    ...legacy,
    version: 2,
    selectionMode: "globs-v1",
    include: [
      "src/**/*.{ts,tsx,mts,cts,py}",
      "packages/*/src/**/*.{ts,tsx,mts,cts,py}",
      "apps/*/src/**/*.{ts,tsx,mts,cts,py}",
      "test/**/*.{ts,tsx,mts,cts,py}",
      "tests/**/*.{ts,tsx,mts,cts,py}",
      "docs/**/*.{md,mdx}",
      "migrations/**/*.{sql,ts,py}",
    ],
    testGlobs: [
      "**/*.{test,spec}.{ts,tsx,mts,cts}",
      "test/**/*.{ts,tsx,mts,cts,py}",
      "tests/**/*.{ts,tsx,mts,cts,py}",
      "**/test_*.py",
      "**/*_test.py",
    ],
    languages: {
      typescript: "on",
      python: "on",
      markdown: "on",
      sql: "on",
    },
  };
}
