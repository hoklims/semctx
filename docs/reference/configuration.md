# Configuration reference

Configuration lives at `.semctx/config.json` (created by `semctx init`). It is validated at load
time; the on-disk `repositoryRoot` is always overridden with the actual root at runtime, so the
file is portable.

There are two configuration versions. Version 1 preserves historical discovery byte-for-byte.
Version 2 is an explicit opt-in to deterministic glob selection and per-language analysis modes.
Loading a v1 file never silently upgrades it or applies its previously informational `include`
field.

## Version 1: legacy discovery

This is a valid minimal v1 file. `semctx init` writes the default blocking rules instead of the
empty list shown here.

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
  "blockingRules": []
}
```

| field | v1 behavior |
| --- | --- |
| `include` | Accepted, validated, and persisted, but **not applied by current discovery**. Changing these globs does not change which files are discovered. |
| `exclude` | Applied to each normalized repository-relative file path as a plain substring after removing every `*`; it is not glob matching. Built-in ignored path segments are also excluded (below). |
| `docsDirs` | Accepted and persisted, but not applied by current discovery. Every `.md` and `.mdx` file that survives exclusion is classified as a document. |
| `migrationsDirs` | Used for role classification, not selection. A TypeScript file whose relative path starts with one of these values is classified as a migration; every `.sql` file is a migration regardless of this field. |
| `testGlobs` | Accepted and persisted, but not applied by current discovery. TypeScript tests are currently recognized by fixed filename, directory, and test-import heuristics. |
| `semanticProvider` | `none` (fully local) or `cocoindex` (optional candidate provider, ADR 0004). |
| `blockingRules` | the verdict rules (below). |

### Legacy discovery behavior

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

## Version 2: `globs-v1` selection

Create a new v2 workspace explicitly:

```powershell
semctx init --polyglot
```

`semctx setup --polyglot` writes the same v2 form only when the workspace has no existing config.
It refuses to overwrite an existing v1 config. Migrate an existing file deliberately instead of
assuming that the old `include` values describe its historical graph.

The v2 selection fields are shown below. This remains a valid config with an empty rule list;
`semctx init --polyglot` writes the default blocking rules instead.

```json
{
  "version": 2,
  "repositoryRoot": ".",
  "selectionMode": "globs-v1",
  "include": [
    "src/**/*.{ts,tsx,mts,cts,py}",
    "packages/*/src/**/*.{ts,tsx,mts,cts,py}",
    "apps/*/src/**/*.{ts,tsx,mts,cts,py}",
    "test/**/*.{ts,tsx,mts,cts,py}",
    "tests/**/*.{ts,tsx,mts,cts,py}",
    "docs/**/*.{md,mdx}",
    "migrations/**/*.{sql,ts,py}"
  ],
  "exclude": ["node_modules", "dist", ".semctx", ".git", "coverage"],
  "docsDirs": ["docs"],
  "migrationsDirs": ["migrations"],
  "testGlobs": [
    "**/*.{test,spec}.{ts,tsx,mts,cts}",
    "test/**/*.{ts,tsx,mts,cts,py}",
    "tests/**/*.{ts,tsx,mts,cts,py}",
    "**/test_*.py",
    "**/*_test.py"
  ],
  "languages": {
    "typescript": "on",
    "python": "on",
    "markdown": "on",
    "sql": "on"
  },
  "semanticProvider": "none",
  "blockingRules": []
}
```

| field | v2 behavior |
| --- | --- |
| `selectionMode` | Required literal `globs-v1`. |
| `include` | Applied as repository-relative Bun globs. An empty array selects no files. |
| `exclude` | Applied as repository-relative Bun globs after inclusion; exclude wins. |
| `languages` | Maps a language name to `on` or `off`. A selected language with no registered mode/producer is unsupported. |
| `docsDirs` | Persisted but not used for selection or classification; selected `.md`/`.mdx` files are documents. |
| `migrationsDirs` | Used for TypeScript role classification; selected `.sql` files are always migrations. It does not reclassify Python. |
| `testGlobs` | Persisted but not applied. TypeScript uses `.test`/`.spec`, test-directory, and test-import heuristics; Python uses `test_*.py`, `*_test.py`, and test directories. |
| `semanticProvider` | `none` or the optional `cocoindex` candidate provider; it does not grant Plane-A authority. |
| `blockingRules` | Configured verdict rules. The v2 analysis-health preflight adds `analysis_scope_incomplete` independently, as described in the CLI reference. |

Version 2 selection has these rules:

1. Normalize every candidate to a repository-relative path with `/` separators.
2. Select a path only when at least one `include` glob matches.
3. Apply `exclude` globs after inclusion; exclusion wins.
4. Treat an empty `include` array as an explicit empty selection.
5. Record candidates in deterministic normalized-path order.
6. Never follow symbolic links. Built-in ignored directory segments still apply.

`include` and `exclude` use Bun glob syntax in v2. They are not interpreted with the legacy
substring matcher. Changing them intentionally changes the selected path set and its bound
analysis-input identity.

### Language modes

Each v2 `languages` entry is either `on` or `off`.

| state | selection result | analysis result |
| --- | --- | --- |
| selected and `on` | `selected` | a producer must finish as `analyzed` or `failed` |
| selected and `off` | `selected` | `disabled` |
| selected with no registered language mode or producer | `selected` | `unsupported` |
| include miss or exclude match | `excluded` | `not_applicable` |

Selection is not capability. A selected Python file, for example, can still be disabled,
unsupported, partially analyzed, or failed. These outcomes remain separate from source freshness
and task-relative authority.

The first non-TypeScript vertical is deliberately bounded to Python syntax through 3.12. It emits
local module, class, function, static-import, explicit-marker, precise source-range, and uniquely
resolved selected-module import facts. It does not infer calls, unmarked contracts, test coverage,
or negative completeness. See
[Multi-language Plane A runtime](../architecture/multilanguage-plane-a-runtime.md) and
[ADR 0011](../adr/0011-lezer-python-for-first-plane-a-vertical.md).

The Plane-A assembly and workspace projection used by this runtime remain private and provisional.
`IndexHealthReportV1` is an additive versioned read-only report, but this branch does not freeze a
public language-adapter API.

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
