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

Requirements: Claude Code with plugin support, Bun 1.3 or newer, and Node for the optional guard
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

Claude Code launches the committed `dist/semctx-mcp.js` bundle from its plugin cache through Bun.
It never reaches back into the source checkout and does not depend on a globally linked
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

Restart Claude Code after installation. Then initialise each target repository once with either
form.

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
| A | `semctx_index_health`, `semctx_inspect`, `semctx_verify_change` | index binding and coverage; observed graph, impact, recommended tests, `PASS/WARN/BLOCK` |
| B | `semctx_semantic_check`, `semctx_semantic_slice`, `semctx_semantic_inspect`, `semctx_change_open`, `semctx_change_update`, `semctx_change_verify`, `semctx_handoff`, `semctx_resume` | authored intent, lifecycle integrity, proof-carrying contracts and rehydration |
| C | `semctx_control_status`, `semctx_control_trace`, `semctx_control_plan` | read-only freshness preflight, L0-L6 trace and fail-closed migration planning |

`semctx_prepare_task` remains experimental and is not a code-search replacement.

## Agent workflow

1. Use normal repository search and Git inspection first.
2. Call `semctx_index_health`; keep binding, freshness, coverage, candidate outcomes, workspace
   diagnostics, and reasons separate.
3. Resume or slice existing authored intent when it exists.
4. Call `semctx_control_status`. Continue high-risk control work only for `FRESH` or `DIRTY_KNOWN`.
5. Call `semctx_control_trace` for bounded L0-L6 reconstruction.
6. Record the returned status, seal hash, and any current/indexed mismatch as explicit facts.
7. Call `semctx_control_plan` only with an explicit target architecture.
8. For a user-authorized write, open or update a change contract before substantial edits.
9. Make the smallest coherent change.
10. Call `semctx_verify_change`, run the selected runtime tests, record only obtained evidence, and
   compose `semctx_change_verify` when a contract exists.
11. Write a handoff only for write-scoped work; read-only work remains mutation-free.

## Decision semantics

- Plane A: `PASS`, `WARN`, `BLOCK`.
- Plane B: `VERIFIED`, `PARTIAL`, `BLOCKED`, `STALE`.
- Plane C: `READY`, `BLOCKED`.

`PASS` does not replace runtime tests. `PARTIAL` must name the missing proof. `STALE` requires
re-linking. `READY` is a planning state, never execution authority. Plane C has no executor and
never performs a cutover, deployment or deletion.

Index coverage is `complete`, `partial`, or `insufficient`. It never replaces or upgrades the
independent control-freshness verdict.

`ControlFreshnessSeal` remains a local input attestation rather than an authenticity signature.
`semctx_control_status` owns the `FRESH` / `DIRTY_KNOWN` / `STALE` / `UNSEALED` decision; Claude
Code preserves its reasons and current/indexed evidence verbatim.

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
      "args": ["/absolute/path/to/semctx/packages/mcp-server/src/index.ts"],
      "env": { "SEMCTX_ROOT": "." }
    }
  }
}
```

## Uninstall

```powershell
claude plugin uninstall semctx@semctx-stable
claude plugin marketplace remove semctx-stable
```
