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

| field | current behavior |
| --- | --- |
| `include` | Accepted, validated, and persisted, but **not applied by current discovery**. Changing these globs does not change which files are discovered. |
| `exclude` | Applied to each normalized repository-relative file path as a plain substring after removing every `*`; it is not glob matching. Built-in ignored path segments are also excluded (below). |
| `docsDirs` | Accepted and persisted, but not applied by current discovery. Every `.md` and `.mdx` file that survives exclusion is classified as a document. |
| `migrationsDirs` | Used for role classification, not selection. A TypeScript file whose relative path starts with one of these values is classified as a migration; every `.sql` file is a migration regardless of this field. |
| `testGlobs` | Accepted and persisted, but not applied by current discovery. TypeScript tests are currently recognized by fixed filename, directory, and test-import heuristics. |
| `semanticProvider` | `none` (fully local) or `cocoindex` (optional candidate provider, ADR 0004). |
| `blockingRules` | the verdict rules (below). |

## Current discovery behavior

Discovery currently walks the whole repository rather than the paths named by `include`. The same is
true of the TypeScript file count shown by `semctx setup`. The `include` values written by `semctx
init` or the layout-aware `semctx setup` defaults are therefore configuration only; they do not
filter analysis today.

The walker never follows symbolic links and always skips directories whose path segment is one of
`node_modules`, `.git`, `.semctx`, `dist`, `build`, `coverage`, `.turbo`, or `.next`. After the walk,
each configured `exclude` value has all `*` characters removed and the remaining text is matched
with `relativePath.includes(...)`. This means, for example, that `vendor` excludes any discovered
file whose relative path contains `vendor`; other glob syntax has no special meaning. An empty or
all-`*` value matches every path.

After exclusion, discovery admits only TypeScript-family files (`.ts`, `.tsx`, `.mts`, `.cts`),
Markdown (`.md`, `.mdx`), and SQL (`.sql`). TypeScript-family files feed the current TypeScript
analyzer; Markdown and SQL are classified as documents and migrations. Adding globs for another
language does not install or enable an analyzer, establish capability, or make that language
supported.

## Future multi-language design

[Issue #57](https://github.com/hoklims/semctx/issues/57) is an RFC only. It does not change current
configuration, discovery, CLI output, or language support, and it does not prescribe a concrete
adapter API. Implementation is split into later work:

- [#58 — F1 provisional Plane A foundation](https://github.com/hoklims/semctx/issues/58) will
  separate language-neutral assembly from TypeScript extraction while preserving current
  TypeScript output. Its internal seam remains provisional.
- [#59 — F2 selection migration](https://github.com/hoklims/semctx/issues/59) will define real
  `include`/`exclude` selection semantics with an explicit compatibility migration; existing
  configurations must not silently shrink their graphs.
- [#60 — F3 workspaces and index health](https://github.com/hoklims/semctx/issues/60) will add
  manifest-evidenced workspace semantics and separate coverage/health reporting through versioned
  migrations.
- [#61 — F4 second-language vertical](https://github.com/hoklims/semctx/issues/61) will add and
  validate the first real second-language analyzer against the conformance corpus. Until that work
  lands, semctx does not claim shipped polyglot Plane A support.

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
