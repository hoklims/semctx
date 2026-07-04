# Configuration reference

Configuration lives at `.semctx/config.json` (created by `semctx init`). It is validated at load
time; the on-disk `repositoryRoot` is always overridden with the actual root at runtime, so the
file is portable.

```json
{
  "version": 1,
  "repositoryRoot": ".",
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", ".semctx", ".git", "coverage"],
  "docsDirs": ["docs"],
  "migrationsDirs": ["migrations"],
  "testGlobs": ["**/*.test.ts", "**/*.spec.ts", "test/**/*.ts"],
  "semanticProvider": "none",
  "blockingRules": [ /* see below */ ]
}
```

| field | meaning |
| --- | --- |
| `include` | globs of TypeScript sources to analyse. Monorepo: `["packages/*/src/**/*.ts"]`. |
| `exclude` | directories to skip. |
| `docsDirs` / `migrationsDirs` | where docs and SQL migrations live. |
| `testGlobs` | how tests are recognised (drives `tested_by`/`covers` edges). |
| `semanticProvider` | `none` (fully local) or `cocoindex` (optional candidate provider, ADR 0004). |
| `blockingRules` | the verdict rules (below). |

## Blocking rules and severity tiers

Each rule maps a **condition** to a **severity** and a **tier**:

```json
{
  "id": "invariant-needs-test",
  "description": "A change touching an invariant-constrained symbol must be covered by a test.",
  "when": "invariant_touched_without_test",
  "severity": "block",
  "tier": "strict"
}
```

| condition (`when`) | default severity / tier |
| --- | --- |
| `invariant_touched_without_test` | block / strict |
| `critical_contract_changed_without_test` | block / strict |
| `security_surface_without_verification` | block / strict |
| `contract_changed_without_test` | warn / advisory |
| `contradiction_unresolved` | warn / advisory |

- **strict** tier → `BLOCK` (fails a `--fail-on block` gate). Meant to be rare and actionable.
- **advisory** tier → `WARN` (never fails by default).
- `tier` is optional; when absent it is derived from `severity` (`block → strict`,
  `warn → advisory`).
- A contract is **critical** only when its symbol is tagged `critical` or `security` (marker /
  tag-driven — never inferred).

To relax a rule, change its `severity` to `warn` (or remove it). To make advisory findings block
in CI, run `verify diff --fail-on warn` instead of editing the rules.

## Guarded-mode files (Claude Code)

- `.semctx/guard.json` — `{ "enabled": true }` opts a project into the guarded hook. Absent or
  `{ "enabled": false }` = advisory (default).
- `.semctx/verification-state.json` — written by `verify diff --record`; git-ignored, atomic.
- `SEMCTX_GUARD=off` (env) strictly disables enforcement regardless of `guard.json`.
