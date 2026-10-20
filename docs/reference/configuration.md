# Configuration reference

Configuration lives at `.semctx/config.json` (created by `semctx init` / `semctx setup`). It holds
**shareable project policy** only (`include`, `exclude`, blocking rules, …). The file is validated
at load time and is intended to be committed.

Machine location is never part of the policy file: every CLI/MCP call supplies the absolute
repository root, and `loadConfig` injects that root into the runtime config. A legacy on-disk
`repositoryRoot` field is still accepted when present but is **ignored** and **not rewritten**.

`semctx` updates `.gitignore` so that `.semctx/config.json` and `.semctx/semantic/` are tracked while
local state (`.semctx/semctx.db`, context packs, working files) stays ignored.

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
| `repositoryRoot` | **Not required.** If present (legacy absolute path or `"."`), ignored at load. Runtime root comes from the CLI `--root` / MCP `repositoryRoot` argument. |
| `include` | Accepted, validated, and persisted, but **not applied by current discovery**. Changing these globs does not change which files are discovered. |
| `exclude` | Applied to each normalized repository-relative file path as a plain substring after removing every `*`; it is not glob matching. Built-in ignored path segments are also excluded (below). |
| `docsDirs` | Accepted and persisted, but not applied by current discovery. Every `.md` and `.mdx` file that survives exclusion is classified as a document. |
| `migrationsDirs` | Contributes path-prefix role classification, not file selection. TypeScript-family files under a path segment exactly named `migration` or `migrations` are also classified as migrations. Every `.sql` file is classified as a migration regardless of this field. |
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
all-`*` value matches every path. A directory that discovery cannot read fails with `IO_ERROR`,
unless an `exclude` value is contained in its path followed by `/`: every file below it is then
excluded, so discovery skips it.

After exclusion, discovery admits only TypeScript-family files (`.ts`, `.tsx`, `.mts`, `.cts`),
Markdown (`.md`, `.mdx`), and SQL (`.sql`). TypeScript-family files feed the current TypeScript
analyzer; Markdown is classified as a document, while SQL is classified as a migration. Adding
globs for another language does not install or enable an analyzer, establish capability, or make
that language supported.

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
| `rust` | Optional conditional navigation for explicitly trusted Rust repositories. Requires `languages.rust: "on"`; see the [bounded Rust candidate](rust-indexing.md) for the pinned binary, toolchain, target, feature and deadline fields. |
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
7. Fail with `IO_ERROR` on a directory that cannot be read or searched, unless an `exclude` glob
   of the form `<prefix>/**` has a `<prefix>` matching it: every path below it is excluded, so
   discovery skips it (for example `**/.pnpm-store/**` for a package store owned by another user).
   The `public-monorepo-static-v1` profile keeps failing closed.

`include` and `exclude` use Bun glob syntax in v2. They are not interpreted with the legacy
substring matcher. Changing them intentionally changes the selected path set and its bound
analysis-input identity.

### Workspace configuration inheritance

TypeScript and JavaScript analysis read the nearest `tsconfig.json`, including what it `extends`.
A package specifier such as `"extends": "@scope/config/tsconfig/base.json"` normally resolves
through the package manager's installed link. When a checkout lacks that link, semctx follows the
link pnpm, Bun or Yarn would create, from repository manifests only:

- the dependent directory is the workspace root or a declared member (`pnpm-workspace.yaml`
  `packages`, otherwise `package.json` `workspaces`, including `!` exclusions); an enclosing
  `pnpm-workspace.yaml` governs even a member that declares its own `workspaces`, and one without
  a valid `packages` list declares no member; a pattern
  reaching outside the workspace root or into a nested Git worktree or repository adds no member;
- it declares the package in `dependencies`, `devDependencies` or `optionalDependencies` (a peer
  dependency may stay uninstalled) with a `workspace:` range (`workspace:*`, `workspace:^`, or a semver
  range such as `workspace:^1.0.0` that the member's `version` satisfies), not an alias or a path;
- exactly one workspace package, the root or a member, carries that name.

An installed package keeps precedence, whether it sits in the dependent's own `node_modules` or is
hoisted above it, even when it lacks the requested file. The declaration is searched upward
without crossing the analyzed repository root or a `.git` marker, and a member outside the
repository is never linked. Members are derived once per analysis pass, so a later pass observes
added, removed or renamed members. Otherwise the configuration error is still reported, for
example `SOURCE_CONFIGURATION_INVALID:6053`. Analysis of retained compiler snapshots
(`public-monorepo-static-v1`) is unchanged and still reads only the inputs it captured.

### Path aliases in TypeScript

In a version 1 or version 2 configuration, a non-relative import written in a selected file of a
TypeScript-only graph is resolved through the `paths` and `baseUrl` of the nearest
`tsconfig.json` of that file, including what it `extends`. An import such as
`"@scope/pkg/feat/handler.js"` mapped by `"@scope/pkg/*": ["./src/*"]` then produces the same
dependency, call and test-link edges as the relative import of that file. A `.js` specifier
reaches its `.ts` source and several `paths` targets are tried in order, as in `tsc`. Only
`paths` and `baseUrl` are taken from the configuration. `module`, `moduleResolution` and every
other option stay at the analyzer's Bundler defaults.

The mapping only adds a repository module. A specifier it does not add one for keeps the
resolution it had before, with the usage mode (`import`, `require`, `.cts`) the compiler applies
to it: one no mapping governs, one that resolves to an installed package, and one that resolves to
nothing the mapping can reach, such as a package hoisted into a `node_modules` above the analyzed
root. A configuration whose selected files are governed by neither `paths` nor `baseUrl` leaves
the extraction byte-identical.

- Only imports written in a selected file are mapped. A file the compiler loads through an alias
  without it being selected keeps the historical resolution for its own specifiers, and its
  configuration is not an input of the analysis. Select it to have its imports mapped.
- A mapped target outside the analyzed repository, or behind a link that leaves it, is not read
  and produces no edge. A repository file reached through an alias is held to the confinement of
  the relative import that would reach it: a relative import or `/// <reference>` of that file
  that leaves the repository is refused with `IMPORT_OUTSIDE_REPOSITORY` or
  `REFERENCE_OUTSIDE_REPOSITORY`, and nothing outside the repository is read. A specifier is
  classified as TypeScript classifies it: a name that begins with a dot but is not `./` or `../`
  is bare and mapped, and an absolute path outside the repository is refused like a relative one.
- A file created at a higher-priority target of a `paths` entry that is not selected, for example
  a git-ignored `gen/` directory, is not part of the analysis input identity. It changes the edge
  but does not make the index stale: rebuild after generating it.
- A specifier that does not resolve produces no edge and is not reported as unresolved. The
  absence of an edge is not evidence that no dependency exists. `export ... from` and `import()`
  produce no dependency edge in this graph, aliased or relative.
- The configuration files read are those of the selected files and are part of the analysis input
  identity, so editing `paths`, `baseUrl` or an inherited configuration makes the index stale
  until it is rebuilt.
- Version 1 configurations resolve aliases the same way. Their analysis input identity binds the
  configuration files read, but only while some selected file is governed by `paths` or `baseUrl`:
  a version 1 repository whose configuration declares neither keeps its extraction and its
  identity unchanged, and one that declares them is stale once after upgrading until it is
  rebuilt. Version 1 still does not inspect `module` or `moduleResolution`. JavaScript-enabled graphs
  already apply the complete nearest configuration.
- `package.json` `imports` that target source files resolve as before. Entries of `imports` or
  `exports` that target build output (`./dist/...`) stay unresolved in a checkout that is not
  built: reaching their sources needs `outDir` and `rootDir`, which this resolution does not
  take from the configuration.

Setup's optional `scope.proposedIncludes` contains at most 20 exact observed TypeScript/Python
paths missed by v2 includes while their language is enabled. Add only the desired entries to
`include` explicitly, then rerun setup. Existing configuration, including empty or restricted
includes, is preserved byte-for-byte by the diagnostic. It does not propose explicit excludes,
disabled/unsupported/failed candidates or refused links. Glob punctuation, control characters,
nonrelative paths and paths over 240 UTF-8 bytes are withheld rather than escaped or widened;
`unproposableIncludeMisses` counts eligible misses without a safe exact representation, while
`proposedIncludesOmitted` counts safe entries beyond the output cap. Applying a proposal still
preserves exclude precedence, language modes and existing link/import boundary checks.

## Config migration (v1 to v2)

`semctx migrate config` (ADR 0028) is the deliberate path from an existing v1 file to an explicit
v2 proposal — not `semctx init --polyglot`, which only writes a fresh v2 file where none exists.
See the [CLI reference](cli.md#migrate-config) for the command itself. In outline:

```powershell
semctx migrate config --proposal .semctx/v2-proposal.json
semctx migrate config --proposal .semctx/v2-proposal.json --apply --plan <sha256>
semctx migrate config --restore <run-id>
```

- The proposal must be a complete, schema-valid v2 file under the repository, outside
  `config.json` and `.semctx/config-migrations/`. Only `version`, `include`, `exclude`,
  `selectionMode` and `languages` may differ from the current v1 file; any other change —
  including to a field this version of `semctx` does not recognize — is refused.
- Planning is read-only: it shows the discovery-selection diff (added/removed/unchanged paths),
  the authored `.sem` inventory, and the verification-state presence/digest, plus a plan digest
  that binds all of it.
- `--apply` recomputes that plan under a cooperative lock and refuses if the supplied digest no
  longer matches (`STALE_PLAN`), or if an earlier run has not been restored yet
  (`RECOVERY_REQUIRED`). It keeps an exact backup of the prior `config.json` bytes.
- `--restore <run-id>` undoes one run, including one interrupted by a crash: it is driven by
  comparing current `config.json` bytes to the run's recorded before/after values, never by
  guessing from partial state. A run already restored never overwrites a later value.
- Apply and restore re-inventory authored `.sem` files and `verification-state.json` around the
  `config.json` replacement and refuse on observed drift, naming the run to restore if one was
  published. They never roll those files back.
- This command never re-indexes, never re-stamps verification, and never touches authored `.sem`
  files: after applying or restoring, rebuild the index and re-run verification explicitly.

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
`IndexHealthReportV1` remains the complete CLI `index-health --json` report. The shared
`IndexHealthReportV2` is a bounded summary with opt-in detail pages: MCP uses V2 by default, and the
CLI exposes it through `--summary --json` or `--section … --json`. See the
[index-health reference](cli.md#index-health) for sections, cursors, output limits, and client
migration. Neither report freezes a public language-adapter API.

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

`analysis_scope_incomplete` and `index_binding_stale` are raised by verification preflights over the
whole analysis rather than by a rule over impacted nodes; they are not configurable here and always
report as `block` / `strict`.

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
  `{ "enabled": false }` = advisory (default). Optional `"hooks": "project-managed"` declares that
  the repository's own Git hook chain (Lefthook, husky) carries the content proof by running
  `semctx verify hook pre-commit` / `pre-push` as its last job (ADR 0029); the guard then stops
  requiring a sample-only hooks directory. Any other `hooks` value is ignored: enforcement stays on
  with the default sample-only rule, so a typo never relaxes anything.
- `.semctx/verification-state.json` — written by `verify diff --record`, `index --record` and
  `verify hook pre-commit`; git-ignored, atomic.
- `SEMCTX_GUARD=off` (env) strictly disables enforcement regardless of `guard.json`.

## Shadow lifecycle hook files (Codex and Claude Code)

- `.semctx/working/agent-lifecycle/<sha256>.ndjson` — one append-only ledger per session and
  repository, written by the hook. It holds canonical `AgentWorkflowStageIdV1` values — the observed
  stages, plus the set named by the last advisory so the next end of turn stays silent unless
  something changed — and nothing else; the file name is a digest, so the host session id is never
  stored. Git-ignored
  by the existing `.semctx/*` rule and capped at 64 retained ledgers. Deleting one is safe for the
  repository but not free for the advisory: the session's earlier observations are gone, so the
  next end of turn reports the stages it can still see and names the rest missing. That is the
  same reason the cap evicts by age and never the ledger being written.
- `SEMCTX_LIFECYCLE=off` (env) strictly disables the observer. The hook is advisory and cannot
  block, so it is on by default; the switch exists because local enforcement, advisory
  included, must stay disableable without deleting `hooks/hooks.json` and losing the unrelated
  commit/push guard.
