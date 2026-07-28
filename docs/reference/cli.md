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

Unless `--skip-setup` is set, the command resolves `git rev-parse --show-toplevel` and runs the
idempotent `setup` pipeline at that repository root, even when invoked from a nested directory.
Outside a Git repository it installs the machine plugins but writes no workspace state and reports
the exact follow-up command. `--dry-run` performs only read-only host and Git probes.

The JSON report contains `ok`, CLI `version`, selected mode, per-host steps/status, workspace
status, and restart/recovery actions. Exit 0 means at least one requested or auto-detected host is
ready and the workspace step did not fail.

## `setup`

Idempotently create or preserve configuration and authored semantic files, index the repository,
and validate the resulting model in one command.

| option | description |
| --- | --- |
| `--polyglot` | for a new workspace, write config v2 with `globs-v1` selection and TypeScript/Python/Markdown/SQL modes; refuses to overwrite an existing v1 config |

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

## `verify diff`

Analyse a git range (or the current diff) for impact and violations.

| option | default | description |
| --- | --- | --- |
| `--base <ref>` | — | compare against `<ref>` using the real merge-base (required for CI ranges) |
| `--head <ref>` | `HEAD` | head ref to analyse |
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

With config v2, verification first checks index health for each selected changed path. Missing,
disabled, unsupported, failed, stale, or invalidly bound analysis adds a blocking
`analysis_scope_incomplete` finding. Analyzed Python with partial negative-evidence capability adds
a warning and an explicit unknown instead of a green negative impact or test-coverage conclusion.
Config v1 retains the legacy verification path.

**Git ranges**: `--base` computes `git merge-base <base> <head>` and diffs `mergeBase..head`.
The base must exist locally — semctx never fetches implicitly. In CI, check out with
`fetch-depth: 0`.

**JSON report** (`--format json`, `schemaVersion 1`): `verdict`, `base`, `head`, `mergeBase`,
`range`, `changedFiles`, `changedSymbols`, `impactedContracts`, `impactedInvariants`,
`recommendedTests`, `contradictions`, `unknowns`, `findings` (each with `tier`, `severity`,
`locations`), `summary { blockCount, warnCount }`. Additive-only within a major `schemaVersion`.

## `inspect symbol|capability <query>`

Inspect the graph around a symbol or capability: matched nodes, related claims, relations,
contradictions, files to read. `--json` for machine output.

## `doctor`

Workspace health check.

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

The equivalent MCP tools are `semctx_control_target_propose`, `semctx_control_bind_scope`,
`semctx_control_plan_change` and `semctx_control_reconcile_diff`. `semctx_control_frame_task`
remains a wider compatibility framing surface. They validate the same schemas, call the same
application services and serialize successful results to the same canonical bytes.

## Experimental

`task create` and `context prepare` (the `task → ContextPack` retriever) and `bench` remain in the
CLI but are **experimental** and are not a code-search replacement (ADR 0005).
