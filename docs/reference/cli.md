# CLI reference

`semctx <command> [options]`. In this repository the CLI is `bun apps/cli/src/index.ts`; once
published it is `bunx semctx`. Global options: `--root <path>` (repository root,
default cwd), `--json` (machine output where supported).

## `init`

Create `.semctx/` (SQLite db + config) and install the non-destructive `.gitignore` policy that keeps
authored `.semctx/semantic/` files versioned while excluding local runtime state. Never touches
application code.

| option | description |
| --- | --- |
| `--preset github-claude` | preview-first bootstrap (config, CI workflow, Claude note) |
| `--dry-run` | with `--preset`: preview only, write nothing |
| `--force` | with `--preset`: overwrite existing files |
| `--with-github-action` / `--with-claude-code` / `--with-devcontainer` | preset extras |

## `index`

Analyse the repository into the deterministic graph and atomically capture its control index
snapshot. `--json` prints counts plus the versioned `freshnessSeal`; text output prints its hash.

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

The equivalent MCP tools are `semctx_control_plan_change` and
`semctx_control_reconcile_diff`. They validate the same schemas, call the same application
services and serialize successful results to the same canonical bytes.

## Experimental

`task create` and `context prepare` (the `task → ContextPack` retriever) and `bench` remain in the
CLI but are **experimental** and are not a code-search replacement (ADR 0005).
