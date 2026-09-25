# CLI reference

`semctx <command> [options]`. In this repository the CLI is `bun apps/cli/src/index.ts`; once
published it is `bunx semctx`. Global options: `--root <path>` (repository root,
default cwd), `--json` (machine output where supported).

## `install`

Install or update Semctx for detected coding-agent hosts and prepare the current Git repository:

```text
semctx install [--host auto|codex|claude|all] [--skip-setup] [--dry-run] [--json]
```

The default `auto` mode configures every detected Codex/Claude host and ignores hosts that are not
installed. Explicitly requested missing hosts fail honestly. Codex installations using the legacy
`personal` or interim `semctx` marketplace names are migrated to `semctx-stable`; Claude's legacy
`semctx` marketplace is migrated the same way. A different marketplace already named
`semctx-stable` is never overwritten. Fresh registrations track the release-managed `stable`
branch, which advances only after the matching npm package is public. Every completed install is
re-read to prove the expected plugin version is installed and enabled. Claude installs use user
scope, and legacy cleanup is explicitly limited to that scope.
When Windows reports that an active Codex task has locked the legacy plugin cache, the replacement
must already be verified before cleanup is deferred. The report remains successful, marks the
cleanup steps `deferred`, and a detached helper retries only those legacy removals in the background.
Other cleanup errors remain blocking.

`codex plugin add` can also converge and still exit non-zero: it writes the new payload first, then
fails to archive the entry it replaces because a live task still maps it (`failed to back up plugin
cache entry … os error 5`). The install re-reads the host and accepts that outcome **only** when the
expected plugin is installed, enabled and at the expected version, **and** the versioned cache entry
Codex executes (`<codexHome>/plugins/cache/<marketplace>/<plugin>/<version>`, distinct from the
marketplace snapshot reported as `source.path`) declares that version and holds four regular,
non-empty runtime bundles whose SHA-256 match that snapshot. It then reports success with
`cleanupDeferred: true` and `restartRequired: true`, and schedules a detached helper that retires
only the version observed before the update. The helper re-reads Codex before and after its atomic
rename and aborts unless the expected version remains installed, enabled and selected.

The override is bounded to Windows and to the exact codes `os error 5` and `os error 32` — `os error
50`, `os error 320` and arbitrary permission failures are not eligible. Unproven convergence
(missing, disabled, wrong-version, incomplete cache, or a digest that diverges from the snapshot),
an unlocatable cache root, and a malformed plugin list all remain blocking, and nothing is ever
scheduled against a cache that could not be proven.

Unless `--skip-setup` is set, the command resolves `git rev-parse --show-toplevel` and runs the
idempotent `setup` pipeline at that repository root, even when invoked from a nested directory.
Outside a Git repository it installs the machine plugins but writes no workspace state and reports
the exact follow-up command. `--dry-run` performs only read-only host and Git probes.

The JSON report contains `ok`, CLI `version`, selected mode, per-host steps/status, workspace
status, and restart/recovery actions. Exit 0 means at least one requested or auto-detected host is
ready and the workspace step did not fail.

A successful report describes the **installed** version, which is what the next task will resolve —
not the version a session already running has loaded. `restartRequired` marks that gap. When work is
left for later, `cleanupDeferred` is the boolean synthesis and `deferrals` lists each obligation
(`kind`, `detail`, and whether a background retry was `scheduled`); several can coexist.

A host whose CLI rejects the initial marketplace/plugin inventory query with a recognized
command-parser diagnostic (for example `error: unexpected argument 'marketplace' found`) fails with
the additive `interfaceUnsupported: true`, and the recovery step names the host CLI upgrade instead
of the generic "resolve the command error" message. `--dry-run` performs the same read-only
inventory probe up front, so a plan can already be known-failed; the recovery step never recommends
blindly re-running without `--dry-run` when a requested host or the workspace step has already
failed or conflicted.

## `setup`

Idempotently create or preserve configuration and authored semantic files, index the repository,
and validate the resulting model in one command.

| option | description |
| --- | --- |
| `--polyglot` | for a new workspace, write config v2 with `globs-v1` selection and TypeScript/Python/Markdown/SQL modes; refuses to overwrite an existing v1 config |
| `--workers auto\|1..8` | select the same asynchronous TypeScript worker path as `index`; default `1`, while `auto` remains an explicit opt-in using up to two workers on large repositories |

The plugin MCP `semctx_setup` keeps the synchronous single-program analyzer because its public
input contract has no worker-selection field. The CLI is the supported setup surface for explicit
worker selection.

## `init`

Create `.semctx/` (SQLite db + config) and install the non-destructive `.gitignore` policy that keeps
authored `.semctx/semantic/` files versioned while excluding local runtime state. Never touches
application code.

| option | description |
| --- | --- |
| `--polyglot` | explicitly create config v2 with `globs-v1` selection and TypeScript/Python/Markdown/SQL modes |
| `--preset github-claude` | preview-first bootstrap (config, CI workflow, Claude note) |
| `--dry-run` | with `--preset`: preview only, write nothing |
| `--force` | with `--preset`: overwrite existing files |
| `--with-github-action` / `--with-claude-code` / `--with-devcontainer` | preset extras |

## `index`

Analyse the repository into the deterministic graph and atomically capture its control index
snapshot. `--json` prints counts plus the versioned `freshnessSeal`; text output prints its hash.

```text
semctx index [--json] [--workers auto|1..8] [--record]
```

`--record` recovers a stale `.semctx/verification-state.json` baseline in one command: it rebuilds
the index, computes a fresh working-tree verification, checks that source, index, and semantic
inputs stayed stable across the whole operation, and atomically records the actual PASS/WARN/BLOCK
verdict. Plain `index` never touches recorded evidence, even when the current baseline is stale —
it only repairs the index binding, so `semctx status`/`verify` can still see the stale baseline and
name it. `--record` refuses non-ignored untracked files and tracked bytes hidden from the analysed
diff, the same way `verify diff --record` does. `--json` adds a `verification: { recorded: true,
report }` field carrying the same versioned `verify diff` report (ADR 0008); exit is 3 for a
recorded `BLOCK`, otherwise 0. If verification or recording fails after a successful rebuild, the
old evidence file is left byte-identical and the error names the partial outcome
(`indexRebuilt: true`, `evidenceRecorded: false`).

The default is `--workers 1`: current portable benchmarks prove deterministic equivalence but do
not justify imposing extra compiler heaps on every repository. `--workers auto` stays single-core
below 1,000 selected TypeScript files. Above that threshold it uses at most two Bun workers on
platforms where the current evidence supports the memory trade-off. It remains single-core on
macOS because the exact Apple Silicon CI fixture currently shows both higher wall time and retained
RSS with multiple Workers. Explicit counts from 2 through 8 remain available for repository-specific
experiments; `auto` is not a blanket speed claim.
Repositories containing global scripts, triple-slash directives, parse
errors, or global/module augmentations conservatively use the original single-program analyzer.
Selected roots linked by canonically resolved module edges stay in the same component, including
links through repository-local source files loaded by TypeScript but excluded from emission.
External files and every `node_modules` segment are excluded from this connectivity graph, so a
shared dependency cannot join otherwise independent roots. When every selected source belongs to
one component, Semctx stays single-core and reports that reason explicitly.
Use `--workers 1` for a forced single-core comparison. Parallelism is operational telemetry in the
command output; it is not part of the graph or freshness seal.

## `index-health`

Read the shared versioned Plane-A binding, freshness, coverage, candidate, capability, workspace,
and reason report without writing repository state.

```text
semctx index-health [--json]
```

The report keeps `freshness` and `coverage` separate. Coverage is `complete`, `partial`, or
`insufficient`; it never upgrades the nested control-freshness verdict. Exit 0 requires a valid
binding, high-risk-capable freshness, and complete coverage. Partial coverage exits 2. Invalid or
absent binding, freshness that cannot run high-risk control, or insufficient coverage exits 3.

## `migrate config`

Explicit, CLI-only v1 -> v2 configuration migration (ADR 0028). Dry by default; every write is
gated behind an exact plan digest or an explicit run id. See the
[configuration reference](configuration.md#config-migration-v1-to-v2) for the field-level policy
this command enforces.

```text
semctx migrate config --proposal <repository-relative-json> [--format text|json]
semctx migrate config --proposal <repository-relative-json> --apply --plan <sha256> [--format text|json]
semctx migrate config --restore <run-id> [--format text|json]
```

`--proposal` and `--restore` are mutually exclusive. `--plan` is required with `--apply` and
invalid without it; `--dry-run` (the default) cannot be combined with `--apply` or `--restore`.
Ambiguous input exits 2 before any service call: a repeated option (the shared parser would keep
only its last value), a value given to `--apply` or `--dry-run` (`--apply=false`, `--apply <digest>`),
or a bare `--format`. The versioned JSON report (`kind: "config_migration_report"`) carries
`operation` (`plan`/`apply`/`restore`), `status` (`PLANNED`/`APPLIED`/`RESTORED`/`REFUSED`), a
nullable `planDigest` and `runId`, the plan details on a successful plan/apply, a `reasons` array,
and `requiredActions`:

| reason | meaning |
| --- | --- |
| `INVALID_INPUT` | the current config, the proposal file or the plan digest is missing, unreadable, or fails schema validation |
| `POLICY_CHANGE_REJECTED` | the proposal changes a field other than `version`/`include`/`exclude`/`selectionMode`/`languages` |
| `STALE_PLAN` | the repository changed since the supplied plan digest was computed, or authored `.sem` / `verification-state.json` changed while the apply ran |
| `ACTIVE_MIGRATION` | another process holds the cooperative migration lock right now |
| `RECOVERY_REQUIRED` | a published run is not yet restored; `runId` names it |
| `INVALID_ARTIFACT` | a run id, manifest or stored before/after bytes failed validation, or an authored `.sem` / `verification-state.json` entry could not be read |
| `DIVERGENT_CONFIG` | current `config.json` matches neither the run's recorded before nor after bytes |

| required action | what to run |
| --- | --- |
| `RESTORE_RUN` | `semctx migrate config --restore <runId>` with the report's `runId` |
| `REBUILD_INDEX` | `semctx index`; an index built under the other config never becomes current |
| `RERUN_VERIFICATION` | the existing verification flow (for example `semctx index --record`); earlier proof is not restamped |

A refused report carries a `runId` only for a published run that still requires restoration
(`RECOVERY_REQUIRED` or `DIVERGENT_CONFIG`); that run may already have replaced `config.json`. Only
a refused plan is write-free: an apply or restore takes the lock, which may create
`.semctx/config-migrations/coordinator.db`. A genuine I/O failure after a run is published stays an
error, not a refusal; its details carry `recoveryRunId` and `recoveryCommand`.

Apply and restore re-inventory authored `.sem` files and `verification-state.json` before and after
replacing `config.json` and refuse on any observed change. Restore compares with what it observed
at its own start, so later legitimate edits are never rolled back. These are observations for a
trusted, quiescent worktree, not a guarantee against concurrent writers.

Exit 0 on `PLANNED`/`APPLIED`/`RESTORED`; 1 on `REFUSED` or an I/O failure; 2 on a usage error.
This command never opens the index store, never re-indexes, and never rewrites authored `.sem`
files or `verification-state.json` — it only inventories them.

## `verify diff`

Analyse a git range (or the current diff) for impact and violations.

| option | default | description |
| --- | --- | --- |
| `--base <ref>` | — | compare against `<ref>` using the real merge-base (required for CI ranges) |
| `--head <ref>` | `HEAD` | head ref to analyse; with `--from-file`, the commit the supplied diff's post-image belongs to (no default) |
| `--staged` | — | analyse the staged diff (no `--base`) |
| `--from-file <f>` | — | analyse a unified diff file (no `--base`) |
| `--format text\|json\|github` | `text` | output format; `json` is the versioned contract (ADR 0008) |
| `--fail-on block\|warn\|none` | `block` | exit non-zero on this verdict or worse |
| `--strict` | — | legacy alias for `--fail-on warn` |
| `--output <path>` | — | write the JSON report atomically |
| `--record` | — | record `.semctx/verification-state.json` for the guarded hook |
| `--dry-run` | — | show the resolved range + config; no analysis, no writes |

**Exit codes**: `PASS` → 0; `WARN` → 0 (unless `--fail-on warn`); `BLOCK` → non-zero (unless
`--fail-on none`).

Every verification, at either config version, first proves the index is bound to the exact source it
is analysing. Impacted nodes join line ranges frozen at indexing time with hunks measured against
the analysed diff, so a binding that is absent, unreadable, or bound to another repository root,
graph, store schema or commit adds a blocking `index_binding_stale` finding naming the reason;
`verify diff --base A --head B` blocks the same way when `B` is not the indexed commit, even with
`A` still checked out. A working tree that moved since indexing is not a break — that delta is what
`verify diff` measures — and neither is authored Plane-B state, which leaves every line range
intact. Re-run `semctx index` to repair a broken binding.

Refs are resolved to object ids once, before any hunk is measured, and every subsequent `merge-base`
and `diff` uses those ids: a branch moved while the analysis runs cannot re-attribute the hunks to
another commit. A `--head` that Git cannot resolve is an error, never a silently dropped anchor.

A diff semctx did not compute carries no provenance of its own, and no flag can supply one.
`--from-file`, and diff text handed to the MCP `semctx_verify_change` / `semctx_change_verify`
tools, block with `SOURCE_IDENTITY_ABSENT` and never compose into `VERIFIED`.

`--head <ref>` alongside `--from-file` states *attribution*, not provenance: it says which commit the
caller believes the post-image belongs to. Semctx resolves that ref — an unresolvable one is still an
error, and one that is not the indexed commit is still named `ANALYZED_COMMIT_MISMATCH` — but
resolving a ref shows nothing about where the supplied bytes came from, since any post-image can be
handed over next to any commit. An attributed external diff therefore blocks with
`SOURCE_IDENTITY_UNPROVEN` and stays diagnostic. Its JSON `head` records the exact resolved OID for
audit; anonymous external diffs retain the `(from-file)` or `(provided)` placeholder. Only the Git-backed kinds (`working tree`,
`--staged`, `--base`/`--head`) carry proven provenance, because semctx computes those hunks itself
against the resolved object id. To gate on a change, verify it where it lives rather than describing
it in a file.

With config v2, verification then checks index health for each selected changed path. Missing,
disabled, unsupported, failed, stale, or invalidly bound analysis adds a blocking
`analysis_scope_incomplete` finding. Analyzed Python with partial negative-evidence capability adds
a warning and an explicit unknown instead of a green negative impact or test-coverage conclusion.
Config v1 retains the legacy verification path.

An authored reference naming a target the repository does not contain is recorded with the index
that observed it and reported as an explicit unknown by every later verification, so the gap
survives indexing, persistence and a fresh read instead of scrolling past once.

**Git ranges**: `--base` computes `git merge-base <base> <head>` and diffs `mergeBase..head`.
The base must exist locally — semctx never fetches implicitly. In CI, check out with
`fetch-depth: 0`.

**JSON report** (`--format json`, `schemaVersion 1`): `verdict`, `base`, `head`, `mergeBase`,
`range`, `changedFiles`, `changedSymbols`, `impactedContracts`, `impactedInvariants`,
`recommendedTests`, `contradictions`, `unknowns`, `findings` (each with `tier`, `severity`,
`locations`), `summary { blockCount, warnCount }`. Additive-only within a major `schemaVersion`.

## `impact diff`

Report what a change can affect, through which link, and where the modeled reach stops — without
deciding anything about proof. The JSON output is the versioned `ChangeImpact` contract
([reference](change-impact.md), [ADR 0030](../adr/0030-change-impact-contract.md)).

| option | default | description |
| --- | --- | --- |
| `--base <ref>` | — | analyse `merge-base(<ref>, head)..head` (the index must be at `head`) |
| `--head <ref>` | `HEAD` | head ref to analyse |
| `--staged` | — | analyse the staged diff (exclusive with `--base`) |
| `--surfaces <file>` | — | explicit surface map (JSON); surfaces are never inferred |
| `--format text\|json` | `text` | output format; `json` is the versioned contract |
| `--output <path>` | — | write the JSON report atomically |

**Exit codes**: 0 whenever a report is produced — a broken index binding or an incomplete reach is
reported in the document (`analysis.binding`, `unresolved`), not as a failure; 1 on invalid input
(`--from-file`, `--base` with `--staged`, an unreadable or invalid surface map); 2 on an unknown
subcommand.

The index is joined on the diff side whose line coordinates it provably carries, file by file when
it was built on a dirty tree. When no side can be proven, every index-derived field is `null`.

## `verify hook`

```text
semctx verify hook pre-commit|pre-push [--root <path>]
```

Content proof as the **last** job of a project-managed Git hook chain (ADR 0029). It is the
counterpart of the Claude Code guard for repositories that keep a Lefthook/husky chain and declare
`"hooks": "project-managed"` in `.semctx/guard.json`; see
[`claude-code-guarded-mode.md`](../integrations/claude-code-guarded-mode.md). Text output only; the
contract is the exit code.

`pre-commit` runs after the last writer (formatter, restager) and observes the index Git is about to
record. It refuses a partial index — unstaged edits, or non-ignored untracked files, exactly as
`--record` does — before any analysis. When the recorded baseline already covers that exact tree
with a non-`BLOCK` verdict it exits 0 without analysis. Otherwise (no record, unreadable or legacy
record, drifted tree, or a `BLOCK` record) it records a new working-tree verification under the same
stability and refusal rules as `verify diff --record` and exits by verdict.

`pre-push` never records. It reads the `<local ref> <local oid> <remote ref> <remote oid>` lines Git
writes to the hook's stdin and requires the tree of every pushed commit to equal the recorded
`repositoryStateHash`; without ref lines (a manual run) it checks `HEAD`. A post-commit
working-tree verification would analyze an empty diff, which is why this hook only compares.

**Exit codes**: 0 — covered by a non-`BLOCK` record (pre-commit: or one was just recorded);
3 — `BLOCK` (pre-commit aborts the commit; pre-push: the matching record is `BLOCK`);
1 — refused: `PARTIAL_INDEX`, `NO_PROOF`, `PROOF_UNREADABLE`, `REF_DELETION`, `UNPROVEN_REF`, or the
`--record` refusals for untracked or hidden tracked bytes.

## `inspect symbol|capability <query>`

Inspect the graph around a symbol or capability: matched nodes, related claims, relations,
contradictions, files to read. `--json` for machine output.

## `doctor`

Workspace health check plus an offline compatibility advisory for the global `semctx` executable.
The probe resolves the executable locally, runs only `semctx --version` with a bounded timeout, and
compares it with the running package version using exact pre-1.0 lockstep. It never contacts a
registry or installs anything.

`doctor --json` includes a top-level `cliCompatibility` object with `found`, `path`, `version`,
`requiredVersion`, `compatible`, `reason`, and the explicit manual `upgradeCommand`. A missing,
stale, malformed, failed, or timed-out global CLI remains advisory: it is not added to `checks`,
does not change `healthy`, and does not change the exit code determined by workspace health.

Agents can request the same path-free advisory through `semctx_cli_compatibility`. The MCP result
omits the local executable path and does not block MCP-only workflows. A global CLI running its
own `doctor` knows only its own package version and therefore cannot prove plugin parity; use the
MCP preflight or a plugin-bundled CLI for that comparison.

## `plugin-status`

Report where the Semctx plugins actually stand on this machine, without changing anything.

```text
semctx plugin-status [--host auto|codex|claude|all] [--attest] [--json]
```

| option | default | description |
| --- | --- | --- |
| `--host` | `auto` | `auto` inspects what is installed and omits an absent host; naming a host (or `all`) keeps its absence in the answer as `UNKNOWN` |
| `--attest` | off | ask the canonical public repository what `stable` is right now; the only step that leaves the machine, non-mutating, deadline-bounded and acceptance-capped |

Five states are reported and never conflated: the repository checkout, the public `stable`
release, each host's marketplace snapshot, the versioned cache each host executes, and the version
a running session loaded. Per host the report carries the configured source and ref, the snapshot
commit, the installed version and path, and `updateAvailable`.

**Merging `main` does not update an installed plugin.** `main` is the development branch; plugins
are delivered only through the release-managed `stable` channel, and `repository.conveysDelivery`
is always `false`.

Version strings are never taken as proof on their own, because `main` and `stable` can carry the
same SemVer at different commits. Both the marketplace snapshot and executed cache are compared by
**SHA-256 of every runtime bundle** against an immutable witness from the attested release commit.
This prevents a mutable snapshot and cache from jointly impersonating stable.
`installed.contentMatchesSnapshot` and `installed.contentMatchesPublicRelease` expose the two
distinct comparisons and are `null` whenever either claim is unproven.

Host-reported paths are accepted only when they are local and canonically resolve inside that host's own home.
A UNC or device path is refused as `HOST_PATH_REJECTED` before any filesystem call, because reading
one would be network egress from a read-only local diagnostic. Symlink and Windows-junction escapes,
including nested plugin or bundle paths, are rejected before their payload is read.

`verdict` and `delivery` are separate dimensions and neither upgrades the other. `delivery` answers
whether the executed cache is the public `stable` release; `verdict` additionally requires a proven
session. `UP_TO_DATE` is impossible unless the installed cache matches the public release. Because
no supported host exposes the plugin version a running session loaded, `session.status` is
`unknown` with the host's activation action rather than inferred from the cache — so a fresh cache
never proves an already-open session is running it.

`publicRelease.authority` types the provenance: `attested-release`, `local-mirror`, `absent`, or
`unrecognised`. Only `attested-release` can license `UP_TO_DATE`, and an authority this build does
not recognise fails closed with `PUBLIC_RELEASE_AUTHORITY_UNKNOWN`.

The default probe makes no network call. It reports the already-fetched `refs/remotes/origin/stable`
commit and version when `origin` is provably `hoklims/semctx`, but that `local-mirror` remains
informational: it cannot prove no newer public release exists, so it never licenses `UP_TO_DATE`.
A partial clone is refused there rather than allowed to answer a local read with a promisor fetch,
and replacement objects are ignored.

`--attest` closes that gap against a canonical authority — `https://github.com/hoklims/semctx.git`,
a constant of the build, not your `origin`. It runs in a throwaway repository outside your project,
with the ambient Git configuration removed, so no `url.*.insteadOf` rewrite, forged object,
replacement ref or promisor can decide what the public release is. One shallow fetch brings a
single commit into that scratch store; it has a deadline but no transfer-byte ceiling, and the
completed store is capped before any witness is accepted. The version and every per-host bundle
digest are read from those immutable objects and the store is deleted. **It therefore works from any project** — yours
does not have to be a semctx clone, and none of its objects are consulted. Offline, timed-out or
malformed attestation degrades to `absent`, never to the mirror.

Each host is proven against its *own* plugin in that release, and the two payloads must agree: a
release whose Codex and Claude bundles differ is not one artifact and fails closed with
`PUBLIC_RELEASE_HOST_ARTIFACTS_DIVERGED`.

Every probe carries a deterministic time and output budget, applied while it runs and across stdout
and stderr alike, so a flooding host is stopped at the ceiling rather than buffered whole. A probe
that exceeds either is refused whole rather than parsed as a prefix, yielding the stable reasons
`HOST_QUERY_TIMEOUT` or `HOST_OUTPUT_TOO_LARGE`, so the verdict never depends on how much output
arrived first. Local manifests and bundles are likewise refused on their size before they are read.
Any requested but missing host, failed query, malformed JSON, unreadable cache, or unattested
release yields an explicit `UNKNOWN` with no install or update command attached — though the
activation step stays visible, because how a running session picks up what is already on disk does
not become unknown just because the release could not be attested.

Since schema `2` (HOK-585), `marketplace.configured` is `boolean | null`: `false` only when a
successfully read, empty inventory proves the marketplace is not configured, and `null` whenever the
inventory itself is unavailable — the host was not detected, the query failed, timed out, returned
oversized or malformed output, or its CLI does not support the inventory command at all.
`installed.enabled` follows the same rule: a host that reports no boolean for it is `null`, not an
optimistic `false`. A recognized command-parser rejection on the marketplace or plugin inventory
query (for example `error: unexpected argument 'marketplace' found`) — as opposed to an ordinary
failure, timeout, or malformed result, which keep their existing distinct reasons — reports
`detected: true`, `HOST_INTERFACE_UNSUPPORTED`, `UNKNOWN`, and no convergence command.

Exit status follows `delivery`, the dimension a caller can act on: 0 for `UP_TO_DATE`, 2 for
`UPDATE_AVAILABLE`, 3 for `UNKNOWN`.

The command never installs, updates, upgrades, removes, enables or promotes anything and never
advances `stable`. Semctx itself writes neither the inspected project nor host trees, but the
official host inventory commands it invokes may keep host-owned process bookkeeping (Claude
currently records `.in_use` markers). Its two modes differ in exactly one respect: **by default it
performs no network operation at all** — host inventory queries and local reads only — while
**`--attest` fetches** the canonical public release into a throwaway store outside your project and
deletes it afterwards. That transfer is real, and it happens only when you ask for it by name.

## `status`

Evaluate the persisted control index snapshot against the current repository without writing state.

```text
semctx status [--json]
```

Returns `FRESH` when all inputs match and the sealed diff is empty, `DIRTY_KNOWN` when the current
non-empty diff exactly matches the sealed diff, `STALE` on any current/indexed mismatch, and
`UNSEALED` when required snapshot, Git, or store evidence is unavailable. Exit code 0 means
`FRESH`/`DIRTY_KNOWN`; exit code 3 means `STALE`/`UNSEALED`; usage errors remain 2 and unexpected
evaluation failures remain 1.

An authored semantic model that no longer projects into Plane C is also reported as a verdict rather
than an error: `SEMANTIC_MODEL_INVALID` for error-severity diagnostics or duplicate ids, and
`SEMANTIC_LIFECYCLE_INVALID` for error-severity lifecycle findings. Both are `UNSEALED` and exit 3.
Run `semctx semantic check` to see the individual findings behind the reason code.

## `control target-propose`

Create one immutable, agent-authored target architecture proposal:

```text
semctx control target-propose --input <proposal.json> [--json]
```

The strict input contains only:

```json
{
  "schemaVersion": 1,
  "targetId": "target.checkout",
  "revision": 1,
  "statement": "Split checkout from catalog",
  "elements": [],
  "relations": [],
  "preservedInvariantIds": []
}
```

Semctx requires a `FRESH` control state and derives `baseCommit` and `sourceGraphSeal` from it.
`authorshipOrigin` is fixed to `agent`; callers cannot provide those three fields or select Git
refs. The command creates
`.semctx/semantic/targets/<targetId>/r<revision>.target.json` without overwriting an existing
revision.

The returned `target_architecture_proposal` is `certifying: false`, carries
`executionAuthority: "none"` and remains hypothetical. It does not review or accept the target.
The equivalent MCP tool is `semctx_control_target_propose`.

## `control bind-scope`

Resolve explicit repository bindings into a diagnostic `TaskEnvelope`, before any plan exists.

```text
semctx control bind-scope <change-id> --task-id <task-id> [--input <bindings.json>] [--json]
```

`--input` carries scope-binding inputs only: candidate anchors, explicit discoveries and authored
link resolutions. Framing advisories, target selection, expectations and `rollbackDescription` are
rejected by the strict schema. The file is optional; with no file, binding runs from persisted Plane
A/B links alone. Candidate anchors remain advisory, while only authored links and explicit
discoveries with evidence can become load-bearing bindings.

The returned envelope is byte-identical to the one `control plan-change` embeds for the same
inputs. The report is `certifying: false` and carries `executionAuthority: "none"`; it never writes,
indexes, reviews a target, or accepts caller-selected Git refs.

`control frame-task` retains its previous framing and target-selection inputs for compatibility.
For binding-only inputs it returns byte-identical output to `bind-scope`; new host adapters should
use the focused primitive.

## `control authority`

Report the authority a change requires at a given abstraction altitude.

```text
semctx control authority [--altitude 0..6] [--json]
```

`--altitude` defaults to `0`. L0-L1 are `autonomous`, L2 is `constrained`, L3 is `reviewed_plan`,
and L4-L6 require `human_authority`; obligations accumulate as the regime tightens. The report is
bound to the repository's current freshness verdict, and an autonomous write needs both an
`autonomous` regime and a preflight that admits high-risk control.

**Exit codes**: 0 when an autonomous write is admitted; 3 when it is not — mirroring `status`, a
verdict was produced and the gate is closed. The command grants no execution authority and never
writes to `.semctx`.

## `control trace`

Traverse the read-only Plane C coordinate graph from a plane-qualified id.

```text
semctx control trace <repo:...|semantic:...> [--to 0..6] [--direction lift|lower]
  [--max-depth <n>] [--max-results <n>] [--json]
```

`lift` only returns paths ending at a higher requested level; `lower` does the inverse. Results are
bounded, deterministic and evidence-backed. Unsupported/unmapped inputs remain explicit.
Repository links use the same resolver as `semantic check`: file links bind through indexed file
paths, missing links retain the same stale reason, and resolved claim/evidence links are reported as
non-coordinate support artifacts rather than dangling coordinates.
JSON results include the local `freshnessSeal` and evaluated `freshnessStatus`. Trace exits 3 before
traversal when the status is `STALE` or `UNSEALED`.

## `control plan`

Compare the current read-only architecture with an explicit target and compile a shadow-first plan.

```text
semctx control plan <change-id> [--target <snapshot.json>] [--delta <delta.json>] [--json]
```

Without `--target`, the command succeeds as a diagnostic but reports
`BLOCKED / target_architecture_missing`; it never invents a target. A supplied delta is checked
against the computed current/target delta. Neither control command creates or updates `.semctx`.
Plan JSON carries the same freshness seal and status as trace JSON. Unsafe input returns a normal
`BLOCKED / control_inputs_stale|control_inputs_unsealed` report with no steps.

That normal blocked report applies when the persisted control snapshot is structurally valid and
its freshness is `STALE` or `UNSEALED`. A structurally invalid or unbound persisted snapshot is a
store-integrity failure instead: `control status` and query envelopes still expose
`UNSEALED / INDEX_SNAPSHOT_INVALID`, while `control plan` and `control trace` fail before planning or
traversal. Re-index to rebuild the bound snapshot.

## `control plan-change`

Compile one versioned pre-edit planning bundle from a persisted TaskFrame, an authored
ChangeContract and explicit Plane-A bindings.

```text
semctx control plan-change <change-id> --task-id <task-id> --input <planner.json> [--json]
```

The strict planner object supplies the advisory classification overrides, candidate anchors,
authored-link resolutions or explicit discoveries, optional target selection, semantic/repository
edit expectations, rollback, tests and proof evidence. The CLI owns `schemaVersion`, `taskFrameId`
and `changeId`; the input file must not redefine them.

Planning binds the current committed `HEAD`, control index, semantic model and working-diff
baseline. Text-derived anchors never become repository scope by themselves: an authoritative
file, symbol or coordinate requires explicit discovery or an authored link with binding evidence.
The result is canonical `PlanningBundleV1` JSON containing `TaskEnvelopeV1` and
`SemanticChangeSetV1`; every layer carries `executionAuthority: "none"`. The command does not edit,
schedule or apply code.

## `control reconcile-diff`

Reconcile the actual current worktree against one previously compiled planning bundle.

```text
semctx control reconcile-diff <input.json> [--json]
```

The input is exactly `{ "schemaVersion": 1, "planningBundle": ... }`. The command chooses no Git
range: it observes the planning commit, current `HEAD` and current worktree itself, and rejects
caller-selected `--base`, `--head` or equivalent refs. It emits the canonical
`ReconcileDiffReportV1` with one terminal status:

| status | meaning |
| --- | --- |
| `REFUSED` | Schema/hash, commit, target revision, source seal, index, attestation or mid-capture stability is unsafe. |
| `VIOLATED` | The diff escapes scope, drifts an invariant, introduces undeclared lifted impact, misses a required edit, contains an unplanned coordinate or fails an accepted target. |
| `UNPROVEN` | No violation is established, but baseline, observation, refinement, round trip, concrete edit or required evidence is incomplete. |
| `REALIZED` | Every required planned edit and load-bearing proof is satisfied. |

Status precedence is `REFUSED → VIOLATED → UNPROVEN → REALIZED`; reason codes use the shared
canonical order. Exit code 0 means `REALIZED`; every other valid reconciliation result exits 3.
Advisory diagnostics never upgrade the result.

## `control handoff`

Capture one machine-validated Control Handoff v2 capsule for the current task and worktree:

```text
semctx control handoff <input.json> [--json]
```

The strict input contains the complete `PlanningBundleV1` emitted by `control plan-change` and only
a requested current-state progress pointer. The following is a schema sketch, not a standalone
input file:

```text
{
  "schemaVersion": 2,
  "planningBundle": <complete PlanningBundleV1>,
  "progress": {
    "state": "not_started",
    "currentCoordinateId": "semantic:goal.example"
  }
}
```

To request a current-state proof boundary, `progress` uses `state: "step_completed"` and adds a
`completedRefinementStepId` that names a proof-bearing step. This never asserts that the host
executed the step. Semctx re-evaluates the current worktree and accepts the boundary only when every
proof-bearing step through it has its required edits, required outputs and round trips, and
step-specific evidence satisfied. For an edit-only step, `currentCoordinateId` may be the exact
sealed observed hunk SHA-256 node at L0.

The caller does not supply `currentAbstractionLevel`, completion receipts, seals, observed diff,
touched coordinates, proofs, `descriptiveRefinementStepIds`, or `nextValidTransition`. Explicit
zero-obligation planner labels appear in `descriptiveRefinementStepIds`; they are never counted as
completed, and the next transition may skip only those labels. An empty legacy step without the
explicit completion-evidence field is `legacy_ambiguous` and fails closed. Canonical migration
proof obligations remain load-bearing. When sealed evidence cannot derive or otherwise satisfy one,
reconciliation stays `UNPROVEN` and cannot promote that step into completed progress.

`CAPTURED` returns the canonical capsule and writes its canonical record under ignored local state,
`.semctx/working/handoffs/v2/<hash>.json`. The record is keyed by `capsuleHash`; the canonical
capsule contains no timestamp, absolute path, source bytes, host/session id, or free-form note. It
is shadow-only, non-blocking, source-non-collecting, and carries `executionAuthority: "none"`.
A repository without Semctx returns a write-free `NO_OP`. Invalid/unready input, incomplete or
mismatched progress, refused reconciliation, capture drift, or invalid existing record returns
`REFUSED` with `capsule: null`.

Exit code 3 means `REFUSED`; `CAPTURED` and `NO_OP` exit 0. Schema and usage errors remain CLI
errors rather than typed capture results.

## `control resume-handoff`

Resume exactly one Control Handoff v2 capsule by its canonical hash:

```text
semctx control resume-handoff <capsule-hash> [--json]
```

Resume loads the content-addressed record, re-runs current reconciliation from the stored request,
rebuilds the capsule, and requires the same hash. It never returns stale stored facts. Changed HEAD,
working diff, seals, repository identity, record bytes, or rebuilt content returns `REFUSED` with
`capsule: null`. A missing v2 record returns `EMPTY`; `LEGACY_HANDOFF_ONLY` distinguishes a
repository that has only the separate Plane-B Handoff v1 record. Non-Semctx remains a write-free
`NO_OP`.

Exit code 3 means `REFUSED`; `RESUMED`, `EMPTY`, and `NO_OP` exit 0. Normal post-edit changes may
make `semctx status` report `STALE / WORKING_DIFF_MISMATCH`; resume validation comes from the fresh,
task-bound reconciliation. It neither upgrades that global freshness verdict nor grants execution
authority.

## `control handoff explain`

Explain one intact Control Handoff v2 capsule without rewriting it or granting any authority (ADR
0027):

```text
semctx control handoff explain --hash <sha256> [--json]
```

The report projects the capsule's historical objective, declared decisions/non-goals, expected and
observed changes, risks, missing evidence and next checks, each with a source artifact hash and
field/coordinate, plus a dependency-by-dependency current-applicability comparison
(`APPLICABLE` / `STALE` / `UNKNOWN`, never a favorable upgrade of a losing or unreadable
dependency). Every report fixes `executionAuthority: "none"`, `enforcementMode: "shadow"`,
`blockingEnabled: false`, `sourceContentCollected: false`, and `gateAdmission: "NOT_EVALUATED"`; the
report's `captureTime` is excluded from its `reportHash` and from CLI/MCP fact parity.

Handoff v2 carries no separate worktree binding, so `worktree_identity` is always reported
`UNKNOWN / DEPENDENCY_UNVERIFIED`, even when the repository identity matches exactly. Missing
producer/configuration/environment/policy/expiry evidence dimensions are reported
`UNKNOWN / DEPENDENCY_MISSING`, never backfilled from current values. An unreadable or wrong-repository
capsule, an unsupported schema version, or a serialized report that cannot fit its 64 KiB budget
without dropping mandatory stale/unknown/missing-evidence/next-check content returns a typed refusal
with no trusted historical projection.

Exit code 2 means a typed refusal (`ARTIFACT_MISSING`, `ARTIFACT_INVALID`, `UNSUPPORTED_VERSION`,
`WRONG_REPOSITORY`, or `BUDGET_EXCEEDED`); `EXPLAINED` exits 0 even when dependencies are stale or
unknown, because explanation itself succeeded.

These commands are additive. The legacy Plane-B `semantic handoff` / `semantic resume` and MCP
`semctx_handoff` / `semctx_resume` retain their version-1 compatibility contract and files.

The equivalent MCP tools are `semctx_control_target_propose`, `semctx_control_bind_scope`,
`semctx_control_plan_change`, `semctx_control_reconcile_diff`, `semctx_control_handoff`, and
`semctx_control_resume`. `semctx_control_frame_task` remains a wider compatibility framing surface.
They validate the same schemas, call the same application services and serialize successful results
to the same canonical bytes. MCP capture is idempotent and non-destructive but writes ignored local
state; MCP resume is read-only and idempotent.

## Local feedback and support reports

These commands are optional and local. They do not upload data, open an issue, enable telemetry,
or change verification policy.

Preview a privacy-safe support report:

```text
semctx support
semctx support --output support-report.json
```

The command always prints the version-1 JSON payload. Without `--output`, it writes nothing. With
`--output`, it creates a new file containing exactly the printed payload and refuses an existing
file or symbolic link. The report contains only tool/runtime versions, platform/architecture, and
bounded workspace/index statuses and reason codes. Missing diagnostics stay `unknown`; raw errors,
paths, Git data, configuration, environment variables, and stack traces are excluded.

Record voluntary feedback against one finding from an existing JSON `verify diff` report:

```text
semctx feedback record --report verify.json --finding 0 --outcome useful
semctx feedback record --report verify.json --finding 0 --outcome suspected-error --reason false-positive --note "local context"
semctx feedback list
semctx feedback show <record-id>
semctx feedback update <record-id> --outcome unclear
semctx feedback remove <record-id>
semctx feedback export
semctx feedback export --output feedback-aggregate.json
```

`list` and `show` display private local records. Records live only in
`.semctx/feedback/records.json`; an absent read creates no file, and removal targets one exact ID.
Relative `--report` and `--output` file paths resolve from the calling directory, independently
of the repository selected by `--root`.
Recording the same answer twice is idempotent. A different answer is rejected until the explicit
`update` command is used. A malformed store is preserved for manual inspection or removal.

`feedback export` prints only aggregate counts, coded outcomes/reasons, and known standard rule
names. It excludes notes, custom rule text, findings, report/source identities, and paths. Review
private records after about 30 days and remove obsolete entries explicitly; Semctx runs no cleanup
daemon.

An interrupted writer can leave `.semctx/feedback/records.json.lock`. The lock normally records
its local PID and start time. Wait for any active feedback write to finish. If the recorded process
is gone, first ensure no other feedback write is running, then remove only this lock and retry.
An empty or malformed lock needs the same manual inspection. Keep `records.json` intact; the store
is atomically replaced, and any leftover `records.json.<pid>.<uuid>.tmp` is an uncommitted attempt.
Semctx never guesses that a writer is dead or reclaims a lock automatically, since concurrent
reclamation could admit two writers and lose an update. PID metadata is a diagnostic, not proof
of ownership or liveness.

## Experimental

`task create` and `context prepare` (the `task → ContextPack` retriever) and `bench` remain in the
CLI but are **experimental** and are not a code-search replacement (ADR 0005).
