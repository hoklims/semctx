# Claude Code integration: semctx control workflow

The Claude Code plugin (`plugins/claude-code`) now ships the same `semctx-control` workflow contract
as the Codex plugin. Both hosts use the same `semctx-mcp` server and the same proof semantics; only
host integration differs. Claude Code additionally provides an opt-in commit/push guard.

```text
user request
  -> shared semctx-control skill chooses a read or write lane
  -> normal search and Git establish repository facts
  -> Plane A: observed graph and diff impact
  -> Plane B: authored goals, invariants, evidence and unknowns
  -> Plane C: bounded L0-L6 trace and fail-closed migration plan
  -> host edits only inside the user's write authority
  -> semctx verdicts + runtime tests close the proof loop
```

## Install or update

Requirements: Claude Code with plugin support, Bun 1.4 or newer, and Node for the optional guard
hook. The marketplace plugin contains its own MCP runtime; no clone-time link is required.

```powershell
bunx semctx@latest install --host claude
```

Run it from a target repository to install/update the plugin and prepare that repository together,
or add `--skip-setup` for a machine-only refresh. The command is idempotent, migrates the legacy
`semctx@semctx` registration, and refuses to overwrite an unrelated marketplace. Fresh
registrations follow the release-managed `stable` branch, marketplace refreshes retain the
last-known cache if Git fails, and the final installed version and enabled state are verified
before success is reported. Installation and legacy cleanup are limited to user scope; project
and local marketplace declarations are never removed.

Manual install from a clone remains available:

```powershell
claude plugin marketplace add ./
claude plugin install semctx@semctx-stable --scope user
```

Claude Code launches the committed `dist/semctx-mcp.js` entry from its plugin cache through Bun;
the MCP and CLI entries share the fixed root `dist/semctx-shared.js` runtime chunk. The plugin never
reaches back into the source checkout and does not depend on a globally linked
`semctx-mcp`. Every tool call carries the absolute `${CLAUDE_PROJECT_DIR}` as `repositoryRoot`;
missing or relative roots are rejected.

The same plugin snapshot ships `dist/semctx.js` (the full CLI). Agent sessions should prefer that
binary for shell fallbacks and guarded-mode verify so CLI and MCP stay on the same release:

```text
bun "<plugin-root>/dist/semctx.js" setup
bun "<plugin-root>/dist/semctx.js" verify diff --record
```

The agent never has to find `<plugin-root>` itself. Claude Code substitutes the
`${CLAUDE_PLUGIN_ROOT}` placeholder into the plugin's skills when they are loaded, and the guard
hook prints an already-resolved absolute path when it blocks. The variable is exported to hook and
MCP processes only — it is **not** present in the agent's shell, so an unexpanded
`CLAUDE_PLUGIN_ROOT` reference in a command silently resolves to nothing.

A global `semctx` (`bun install -g semctx@latest`) remains the channel for CI and non-plugin shells:

```text
semctx setup
```

After installation or update during an active session, run `/reload-plugins`. Restart Claude Code
only if the reload reports an error or the plugin remains unavailable. Then initialise each target
repository once with either form.

Five states are distinct and must not be conflated:

| state | where | what it means |
| --- | --- | --- |
| repository | your checkout of `main` | the source you develop in; never what a host executes |
| public release | the `stable` branch, advanced by the tag workflow | the only channel a host installs from |
| snapshot | `~/.claude/plugins/marketplaces/<marketplace>` | the approved marketplace source |
| installed cache | `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>` | what `plugin list` reports as `installPath`; what Claude Code executes |
| loaded | in-session | the version the running session started with |

**Merging `main` does not update an installed plugin.** `main` is the development branch and no
host tracks it; `stable` is the public release channel, and it moves only when the tag workflow
advances it after npm publication. A checkout can therefore sit ahead of `stable` at the *same*
version number.

**Installed is not loaded.** A verified install describes what the *next* session resolves; a
session already open keeps the version it started with until `/reload-plugins` succeeds. Claude
exposes no loaded-plugin version, so `semctx plugin-status` reports that state as `unknown` with
the reload step rather than inferring it from the cache. That command never mutates plugin delivery
state (Claude may maintain its own `.in_use` process markers while answering inventory queries) and
compares immutable bundle digests as well as commits rather than trusting version strings. Its
local `origin/stable` mirror is informational; run `semctx plugin-status --attest` to ask the
canonical public repository instead — a non-mutating, deadline-bounded and acceptance-capped lookup that runs outside your project
and cannot be redirected by local Git configuration — and without that attestation the aggregate
stays `UNKNOWN` rather than claiming a false green.

Inspect and verify tools fail closed with `CONFIG_NOT_FOUND` or `REPO_NOT_INDEXED`; they never run
setup or mutate readiness implicitly.

If semctx was previously registered directly in the user MCP configuration, remove that legacy
entry after installing the plugin to avoid two servers exposing the same tools:

```powershell
claude mcp remove semctx -s user
```

For a machine-only update:

```powershell
bunx semctx@latest install --host claude --skip-setup
```

## Shared skills

- `semctx-control`: the complete Plane A/B/C workflow. Its ordered lifecycle is generated from the
  strict `AgentWorkflowContractV1`; the host-neutral body is byte-identical to the Codex skill
  after stripping the generated `host-cli-ladder` region (Claude keeps the plugin-CLI placeholder
  rung; #40).
- `semctx-semantic`: a focused Plane B compatibility workflow for change contracts and handoffs.
- `semctx-verify`: a focused Plane A compatibility workflow for diff verification.

Use `semctx-control` for non-trivial changes, architecture reconstruction, migrations, invariant
preservation, or a generic project demonstration.

## MCP tools

| plane | tools | role |
| --- | --- | --- |
| Host | `semctx_cli_compatibility` | offline advisory comparing the plugin/MCP runtime with the global CLI; never installs or blocks MCP-only work |
| A | `semctx_index_health`, `semctx_inspect`, `semctx_verify_change` | index binding, freshness, and coverage; observed graph, impact, recommended tests, `PASS/WARN/BLOCK` |
| B | `semctx_semantic_check`, `semctx_semantic_slice`, `semctx_semantic_inspect`, `semctx_change_open`, `semctx_change_update`, `semctx_change_verify`, `semctx_handoff`, `semctx_resume` | authored intent, lifecycle integrity, proof-carrying contracts and rehydration |
| C | `semctx_control_status`, `semctx_control_trace`, `semctx_control_plan`, `semctx_control_handoff`, `semctx_control_resume` | read-only freshness, trace, planning, and resume; manual capture writes only ignored local working state and grants no execution authority |

`semctx_prepare_task` remains experimental and is not a code-search replacement.

Before substantial edits, the shared skill frames the highest broken contract from
L6 strategy/constraints down through product intent, invariants, capabilities, boundaries and
symbols to L0 sealed observed hunks. It records why the next higher level is healthy, why a
lower-level patch would only move the symptom, and the smallest check able to falsify the
diagnosis. Missing semantic links remain unknowns; neither `STALE` nor `UNSEALED` triggers an
automatic reindex or reseal. For a diagnosis-only task, write-conditioned stages stay inactive and
unavailable verdicts are reported as `not run` or `not applicable`.

## Agent workflow

Before relying on a global `semctx` shell fallback, call `semctx_cli_compatibility`. Report a
mismatch and its explicit `upgradeCommand`, but continue through MCP and never upgrade
automatically.

1. Use normal repository search and Git inspection first.
2. Frame the top-down diagnosis and record `HIGHEST_BROKEN_LEVEL`, `WHY_NOT_HIGHER`,
   `WHY_NOT_LOWER`, and `PROOF_PLAN` before substantial edits.
3. Call `semctx_index_health`; keep binding, index freshness, coverage, candidate outcomes, workspace
   diagnostics, and reasons separate.
4. Resume an exact Control Handoff v2 hash with `semctx_control_resume` when one exists. Use
   `semctx_resume` only for legacy Plane-B Handoff v1 intent; otherwise inspect or slice existing
   authored intent.
5. Call `semctx_control_status`. Keep its control-freshness verdict separate from index health and
   continue high-risk control work only for `FRESH` or `DIRTY_KNOWN`.
6. Call `semctx_control_trace` for bounded L0-L6 reconstruction.
7. Record the returned status, seal hash, and any current/indexed mismatch as explicit facts.
8. Call `semctx_control_plan` only with an explicit target architecture.
9. For a user-authorized write, open or update a change contract before substantial edits.
10. Make the smallest coherent change.
11. Call `semctx_verify_change`, run the selected runtime tests, record only obtained evidence, and
   compose `semctx_change_verify` when a contract exists.
12. For write-scoped work that needs a manual machine-validated Plane C handoff, call
    `semctx_control_handoff` with the `PlanningBundleV1` and a requested current-state proof
    boundary; resume the exact hash with `semctx_control_resume`. This pointer is never execution
    history. The older `semctx_handoff` / `semctx_resume` pair remains the separate Plane-B Handoff
    v1 compatibility surface. Read-only work remains mutation-free.

## Lifecycle foundation

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
Exact-hash resume re-runs reconciliation and returns no stale capsule. Capture writes only a
content-addressed ignored local record; a non-Semctx repository is a write-free `NO_OP`. This manual
surface is shadow-only, non-blocking, grants `executionAuthority: "none"`, and does not prove that a
Claude lifecycle event invoked it.

The plugin ships one shadow lifecycle hook that automates only the before_completion checkpoint.
A `PostToolUse` entry matched on the bundled `semctx` MCP namespace records which Semctx MCP tool ran, as a canonical
stage id in a session-local git-ignored ledger under `.semctx/working/agent-lifecycle/`, and a
`Stop` entry reports the checkpoint at end of turn on stderr, only when the observed set has
changed since the last advisory - the host ends a turn many times per session, so a completed
cycle must not keep reporting a stale green over turns that produced no evidence. It never blocks: every path exits
0 and nothing is written to stdout, so no output can be read as a decision. It parses the envelope
the host sends and uses exactly `hook_event_name`, `session_id`, `cwd` and `tool_name`; every
other field — prompt, `transcript_path`, `tool_input`, `tool_response` — is not retained, used, or
reproduced, and the hook never opens the transcript file or reads repository source. It
never starts the Semctx runtime, so it never asserts `semctx_ready`. It stays silent when it observed nothing, so a session it could not observe is
never reported as a skipped one. `SEMCTX_LIFECYCLE=off` disables it without touching the
unrelated guard.

The observer sees MCP tool calls only. An agent that runs the documented shell fallback instead
— `semctx verify diff`, `semctx change verify` — performs the stage without being observed, and
the advisory will name it missing. Read `INCOMPLETE` as *not observed over MCP*, never as
*not done*: this surface reports stage presence, and presence was never proof.

Two limits are inherent to observing a host event rather than being called by an agent. First,
the advisory goes to the hook's stderr and nowhere else: it appears wherever the host surfaces
hook output, and it is deliberately **not** injected into the agent's context, because doing so
would mean emitting a host-interpreted control field on stdout — the exact channel a blocking
decision travels on. Second, the host ends a turn whenever the assistant finishes responding, not
only when work is done, so every turn end is treated as a possible completion claim. The
change-only rule keeps that from becoming noise, but it cannot tell a finished task from a pause.

The other three checkpoints have no automatic host hook. Persisted or measured telemetry and
enforcement remain open. Claude's existing optional commit/push guard remains separate and does
not invoke either lifecycle surface.

## Decision semantics

- Plane A: `PASS`, `WARN`, `BLOCK`.
- Plane B: `VERIFIED`, `PARTIAL`, `BLOCKED`, `STALE`.
- Plane C: `READY`, `BLOCKED`.

`PASS` does not replace runtime tests. `PARTIAL` must name the missing proof. `STALE` requires
re-linking. `READY` is a planning state, never execution authority. Plane C has no executor and
never performs a cutover, deployment or deletion.

Index binding, index freshness, and analysis coverage are three separately reported fields.
Coverage is `complete`, `partial`, or `insufficient`; none of those index-health fields replaces or
upgrades the independent control-freshness verdict.

`ControlFreshnessSeal` remains a local input attestation rather than an authenticity signature.
`semctx_control_status` owns the `FRESH` / `DIRTY_KNOWN` / `STALE` / `UNSEALED` decision; Claude
Code preserves its reasons and current/indexed evidence verbatim.

Global control freshness is not the post-edit handoff validation basis. Normal edits may produce
`STALE / WORKING_DIFF_MISMATCH`; Control Handoff v2 uses a fresh task-bound reconciliation and
preserves its `REALIZED`, `VIOLATED`, or `UNPROVEN` result without upgrading it or granting
execution authority.

## Generic demonstration objective

When the user asks for a repository-independent demonstration, the shared skill uses this objective:

> Identify the project's most critical functional path, reconstruct its real behaviour and
> invariants, then correct or strengthen one concrete weakness with the smallest safe, verifiable
> change. If no weakness is proved, report the leading risk and missing proof instead of inventing
> a change.

## Claude-specific guarded mode

The `PreToolUse` hook is advisory by default. When `.semctx/guard.json` enables guarded mode, it
blocks only `git commit` and `git push` until the current commit-bound working-state hash has a recorded non-`BLOCK`
verification. It never blocks edits, tests, exploration, trace or plan tools. See
[`claude-code-guarded-mode.md`](./claude-code-guarded-mode.md).

## MCP without the plugin

For source development without the plugin, launch the entrypoint directly:

```json
{
  "mcpServers": {
    "semctx": {
      "command": "bun",
      "args": ["/absolute/path/to/semctx/packages/mcp-server/src/index.ts"]
    }
  }
}
```

No `SEMCTX_ROOT` is set: the server starts unbound and pins on the first absolute `repositoryRoot`
it receives, the same start path Codex uses. Set it only to hard-bind the process to one checkout,
and only to an absolute path. A relative value such as `.` is rejected at construction with
`REPOSITORY_ROOT_INVALID`, so the handshake fails with JSON-RPC `-32603` and no tools are
advertised. See [ADR 0012](../adr/0012-mcp-2026-stable-surface.md) (repository root policy).

## Uninstall

```powershell
claude plugin uninstall semctx@semctx-stable
claude plugin marketplace remove semctx-stable
```
