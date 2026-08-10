# Codex integration: semantic reconstruction control plane

The `semctx-control` Codex plugin combines two surfaces:

- a skill that tells the agent when and how to use semctx without overstating certainty;
- a local stdio MCP server that exposes deterministic repository, semantic, and control-plane tools.

The ordered lifecycle in the host-neutral workflow is generated from the strict
`AgentWorkflowContractV1`. The resulting body is byte-identical to Claude's after stripping the
generated `host-cli-ladder` region (#40), so Codex and Claude Code use the same stage order, tool
surfaces, write effects, verdict semantics and completion gate. Shell CLI resolution ladders are
host-generated (Codex: global `semctx` only). Host-specific installation, approval and guard
behaviour remains separate.

The plugin does not add an executor. It helps Codex trace intent, compile a shadow-first plan, and
prove a change; Codex still edits code with its normal tools and runs the repository's real tests.

```text
user request
  -> Codex skill chooses an evidence workflow
  -> semctx MCP reads the active repository
  -> Plane A: observed graph and diff impact
  -> Plane B: authored goals, invariants, evidence, unknowns
  -> Plane C: L0-L6 trace and fail-closed migration plan
  -> Codex edits only when the user requested writes
  -> semctx verdict + runtime tests close the proof loop
```

## Install or update

Requirements: Codex CLI with plugin support and Bun 1.3 or newer. The plugin contains its own MCP
runtime and a bundled CLI (`dist/semctx.js`); no global package link is required for agent use.

```powershell
bunx semctx@latest install --host codex
```

Run it from a target repository to install/update the plugin and prepare that repository together,
or add `--skip-setup` for a machine-only refresh. The command is idempotent, migrates the legacy
`semctx-control@personal` and interim `semctx-control@semctx` registrations to
`semctx-control@semctx-stable`, and refuses to overwrite an unrelated marketplace. A migration
installs and verifies the replacement before removing a legacy registration, so a failed
replacement leaves the working plugin intact. Normal updates follow the release-managed `stable`
branch.
On Windows, an already-running task can hold the old cache open, in two distinct ways. When a
*legacy* registration cannot be removed, `semctx install` marks that cleanup as deferred — after the
stable replacement is verified — and retries it automatically in a hidden background helper. When
`codex plugin add` itself converges and then fails to archive the entry it replaces (`failed to back
up plugin cache entry … os error 5`), the install re-reads the host and accepts the update only once
**all** of the following hold: the expected plugin is installed, enabled and at the expected
version; the versioned cache entry Codex executes exists and its manifest declares that version;
and `semctx-mcp.js`, `semctx-shared.js` and `semctx.js` are regular, non-empty files whose SHA-256
match the approved marketplace snapshot. Anything unproven, any error that is not exactly
`os error 5` / `os error 32`, and any non-Windows host all keep the install failing closed.

Three locations are distinct and must not be conflated:

| state | where | what it means |
| --- | --- | --- |
| snapshot | `<codexHome>/.tmp/marketplaces/<marketplace>/plugins/<plugin>` | what `plugin list` reports as `source.path`; the approved source |
| installed cache | `<codexHome>/plugins/cache/<marketplace>/<plugin>/<version>` | what Codex actually executes |
| loaded | in-process | the version a running task started with |

**Installed is not loaded.** A verified install describes what the *next* task will resolve. A task
already running keeps the plugin version it started with, so its cache stays mapped — legitimately —
until you open a new task. Codex does not remove the superseded entry on its own: `semctx install`
schedules a detached helper that retires **only** the version observed before the update, and only
once nothing maps it. The helper renames the directory first, so a still-loaded cache is left
byte-for-byte intact rather than half-deleted, and it aborts outright if the expected version ever
stops being present or selected by Codex. It re-reads `codex plugin list --json` before and after
the rename so a version reselected during the retry window is preserved. The report lists every
outstanding obligation under `deferrals`, each with
whether a retry was actually scheduled.

Manual install from a clone remains available:

```powershell
codex plugin marketplace add .
codex plugin add semctx-control@semctx-stable
```

Codex launches the committed `dist/semctx-mcp.js` bundle from the plugin cache through Bun. Because
Codex does not currently expose the active workspace root to a plugin-launched MCP process, the
shared skill passes the absolute `repositoryRoot` on every tool call. The server then targets that
repository instead of the plugin cache. Read-only Plane C tools are auto-approved from their MCP
annotations; authored-state writes retain Codex's approval prompt.

The plugin ships `dist/semctx.js` (the full CLI) next to the MCP bundle for release lockstep with
the MCP runtime. Codex does not substitute a plugin-root placeholder into skill content and the
agent's shell runs in the user's repository, not in the plugin package root — so the control skill
generated for this host documents only a global install (no Claude-only placeholder). Shell
fallbacks:

```text
semctx setup
semctx verify diff --base origin/main
```

The bundled CLI is still worth running by absolute path when you know it (`bun
/path/to/plugin/dist/semctx.js …`), since it is guaranteed to match the MCP runtime's release.
See #40: host-generated skill ladders keep the shared workflow contract host-neutral.

If semctx was previously registered directly in `~/.codex/config.toml`, remove that legacy entry
after the plugin is installed to avoid duplicate server definitions:

```powershell
codex mcp remove semctx
```

Start a new Codex task after installation. Plugins and their MCP tools are resolved when a task is
created; an already-running task does not hot-load the new surface.

## How Codex uses it

The skill is eligible for implicit use on migrations, architecture reconstruction, non-trivial
refactors, invariant-preservation work, and verification in a semctx-enabled repository. It can also
be invoked explicitly as `$semctx-control`.

For a generic demonstration, it identifies the project's most critical functional path from
repository evidence, reconstructs its contracts and invariants, and selects a weakness only when it
can prove one. Otherwise it reports the leading risk and missing proof instead of inventing work.

Before substantial edits, the shared skill frames the highest broken contract from
L6 strategy/constraints down through product intent, invariants, capabilities, boundaries and
symbols to L0 sealed observed hunks. It records why the next higher level is healthy, why a
lower-level patch would only move the symptom, and the smallest check able to falsify the
diagnosis. Missing semantic links remain unknowns; neither `STALE` nor `UNSEALED` triggers an
automatic reindex or reseal. For a diagnosis-only task, write-conditioned stages stay inactive and
unavailable verdicts are reported as `not run` or `not applicable`.

Typical tool sequence:

Before relying on a global `semctx` shell fallback, call `semctx_cli_compatibility`. A mismatch is
an offline advisory: report its `reason` and `upgradeCommand`, keep using the MCP surface, and never
install or upgrade automatically.

1. Use normal Git/code search to find the implementation surface.
2. Frame the top-down diagnosis and record `HIGHEST_BROKEN_LEVEL`, `WHY_NOT_HIGHER`,
   `WHY_NOT_LOWER`, and `PROOF_PLAN` before substantial edits.
3. Call `semctx_index_health`; preserve binding, index freshness, coverage, candidate outcomes, workspace
   diagnostics, and reasons as separate fields. Do not use a current freshness verdict as proof of
   complete analysis.
4. Resume an exact Control Handoff v2 hash with `semctx_control_resume` when one exists. Use
   `semctx_resume` only for legacy Plane-B Handoff v1 intent; otherwise inspect or slice existing
   authored intent with `semctx_semantic_inspect` or `semctx_semantic_slice`.
5. Call `semctx_control_status`; keep its control-freshness verdict separate from index health and
   continue high-risk control work only for `FRESH` or `DIRTY_KNOWN`.
6. Call `semctx_control_trace` to connect a repository or semantic coordinate to L0-L6 intent.
7. Record the returned status, seal hash, and any current/indexed mismatch as explicit facts.
8. Call `semctx_control_plan` only with an explicit target architecture. A missing target produces
   `BLOCKED`; the agent must not invent one.
9. For a user-authorized code change, open or update a proof-carrying change contract.
10. After editing, call `semctx_verify_change`, run the selected runtime checks, and then call
   `semctx_change_verify` when a change contract exists.
11. For a manual machine-validated Plane C handoff, call `semctx_control_handoff` with the
    `PlanningBundleV1` and a requested current-state proof boundary, then resume that exact capsule
    with `semctx_control_resume`. This pointer is never execution history. The older
    `semctx_handoff` / `semctx_resume` pair remains the separate Plane-B Handoff v1 compatibility
    surface.

Every call includes the absolute `repositoryRoot`. Each target repository must first be prepared
once with `semctx setup`; inspect and verify fail closed and never initialize or index implicitly.

For a read-only request, the skill forbids mutating change-contract and handoff tools. For a write
request, Plane-B tools may version authored intent under `.semctx/semantic/`; Control Handoff v2
writes only a content-addressed record under ignored `.semctx/working/handoffs/v2/`. None of these
tools modifies application code.

## MCP-only lifecycle foundation

Codex and Claude Code expose the same strict lifecycle policy and report through
`semctx_control_agent_lifecycle`. Agents must invoke it explicitly at four points:

1. `before_implementation_write` before the first eligible L2+ implementation write;
2. `after_repository_edits` after edits, to fold caller-observed touched coordinate ids;
3. `before_completion` before claiming completion;
4. `before_compaction` before compaction or owner transfer.

The request carries `requiredAltitude`. Pre-write L0-L1 is `NO_OP`; L2-L6 checks the policy's
required stage ids. `NO_OP` means no stage-presence obligation applies, `RECORDED` means all
required stage ids were recorded, and `INCOMPLETE` means required ids are missing. These verdicts
evaluate neither stage outcomes nor admissibility. The report also distinguishes a non-Semctx
`non_semctx` no-op from an explicit `semctx_unready` repository.

Touched coordinates in this lifecycle checkpoint are `caller_observed_advisory`. Their fold is
`stateless_caller_reinjected_unbound`: the caller must reinject prior ids, and Semctx persists or
binds none of them to a task, session, diff, commit, or handoff. The tool is read-only and
source-non-collecting; `shadow` mode blocks nothing and grants no execution authority.

The separate manual `semctx_control_handoff` / `semctx_control_resume` pair implements Control
Handoff v2. Its progress pointer requests a proof-bearing boundary from the current repository
state; it never records execution history. The capsule lists explicit zero-obligation planner
labels in `descriptiveRefinementStepIds`, never counts them complete, and lets the next transition
skip only those labels. Empty legacy steps fail closed. Canonical migration obligations stay
load-bearing and remain `UNPROVEN` when sealed evidence cannot derive or otherwise satisfy them.
For an edit-only step, the exact sealed observed hunk SHA-256 node is a valid L0 current focus.
Exact-hash resume re-runs reconciliation and returns no stale capsule. A non-Semctx repository is a
write-free `NO_OP`. This manual surface is shadow-only, non-blocking, grants
`executionAuthority: "none"`, does not make the lifecycle checkpoint stateful, and does not prove
that Codex invoked it before compaction.

There are no automatic lifecycle hooks for Codex. Persisted or measured telemetry and enforcement
remain open.

## Decision semantics

- `PASS` says the deterministic diff policy found no blocking condition. It does not replace tests.
- `WARN` says the change needs attention but the configured static policy does not block it.
- `BLOCK`, `BLOCKED`, and `STALE` prevent a completion claim.
- `PARTIAL` must remain partial until the missing evidence is actually obtained.
- `READY` is a planning state, never execution authority for a cutover or legacy deletion.
- Index binding, index freshness, and analysis coverage are separately reported fields. Coverage is
  `complete`, `partial`, or `insufficient`; none of those fields replaces control freshness or
  task-relative authority.
- A `ControlFreshnessSeal` is a local input attestation, not an authenticity signature.
  `semctx_control_status` owns the `FRESH` / `DIRTY_KNOWN` / `STALE` / `UNSEALED` verdict, and Codex
  preserves its reasons and current/indexed evidence verbatim.
- Global control freshness is not the post-edit handoff validation basis. Normal edits may produce
  `STALE / WORKING_DIFF_MISMATCH`; Control Handoff v2 uses a fresh task-bound reconciliation and
  preserves its `REALIZED`, `VIOLATED`, or `UNPROVEN` result without upgrading it or granting
  execution authority.

The control plane stays fail-closed: missing target architecture, unresolved unknowns, stale links,
or insufficient deletion proof remain explicit blockers instead of being filled in by the model.

## Update or uninstall

The supported update path is the same idempotent command:

```powershell
bunx semctx@latest install --host codex --skip-setup
```

To remove the integration completely:

```powershell
codex plugin remove semctx-control@semctx-stable
codex plugin marketplace remove semctx-stable
```
