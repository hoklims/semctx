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

## Install from a clone

Requirements: Claude Code with plugin support, Bun 1.3 or newer, and Node for the optional guard
hook. The marketplace plugin contains its own MCP runtime; no clone-time link is required.

```powershell
claude plugin marketplace add ./
claude plugin install semctx@semctx --scope user
```

Claude Code launches the committed `dist/semctx-mcp.js` bundle from its plugin cache through Bun.
It never reaches back into the source checkout and does not depend on a globally linked
`semctx-mcp`. Every tool call carries the absolute `${CLAUDE_PROJECT_DIR}` as `repositoryRoot`;
missing or relative roots are rejected.

Restart Claude Code after installation. Then initialise each target repository once:

```text
semctx setup
```

Inspect and verify tools fail closed with `CONFIG_NOT_FOUND` or `REPO_NOT_INDEXED`; they never run
setup or mutate readiness implicitly.

If semctx was previously registered directly in the user MCP configuration, remove that legacy
entry after installing the plugin to avoid two servers exposing the same tools:

```powershell
claude mcp remove semctx -s user
```

For a local development reinstall:

```powershell
claude plugin update semctx@semctx
```

## Shared skills

- `semctx-control`: the complete Plane A/B/C workflow, byte-identical to the Codex skill.
- `semctx-semantic`: a focused Plane B compatibility workflow for change contracts and handoffs.
- `semctx-verify`: a focused Plane A compatibility workflow for diff verification.

Use `semctx-control` for non-trivial changes, architecture reconstruction, migrations, invariant
preservation, or a generic project demonstration.

## MCP tools

| plane | tools | role |
| --- | --- | --- |
| A | `semctx_inspect`, `semctx_verify_change` | observed graph, impact, recommended tests, `PASS/WARN/BLOCK` |
| B | `semctx_semantic_slice`, `semctx_semantic_inspect`, `semctx_change_open`, `semctx_change_update`, `semctx_change_verify`, `semctx_handoff`, `semctx_resume` | authored intent, proof-carrying contracts and rehydration |
| C | `semctx_control_trace`, `semctx_control_plan` | read-only L0-L6 trace and fail-closed migration planning |

`semctx_prepare_task` remains experimental and is not a code-search replacement.

## Agent workflow

1. Use normal repository search and Git inspection first.
2. Resume or slice existing authored intent when it exists.
3. Call `semctx_control_trace` for bounded L0-L6 reconstruction.
4. Record the returned `freshnessSeal.sealHash` and preserve any current/indexed mismatch as an
   explicit fact; the seal does not yet assign a freshness verdict.
5. Call `semctx_control_plan` only with an explicit target architecture.
6. For a user-authorized write, open or update a change contract before substantial edits.
7. Make the smallest coherent change.
8. Call `semctx_verify_change`, run the selected runtime tests, record only obtained evidence, and
   compose `semctx_change_verify` when a contract exists.
9. Write a handoff only for write-scoped work; read-only work remains mutation-free.

## Decision semantics

- Plane A: `PASS`, `WARN`, `BLOCK`.
- Plane B: `VERIFIED`, `PARTIAL`, `BLOCKED`, `STALE`.
- Plane C: `READY`, `BLOCKED`.

`PASS` does not replace runtime tests. `PARTIAL` must name the missing proof. `STALE` requires
re-linking. `READY` is a planning state, never execution authority. Plane C has no executor and
never performs a cutover, deployment or deletion.

`ControlFreshnessSeal` is a local input attestation, not a `FRESH`/`STALE` verdict or an
authenticity signature. Claude Code preserves null or unequal current/indexed fields verbatim.

## Generic demonstration objective

When the user asks for a repository-independent demonstration, the shared skill uses this objective:

> Identify the project's most critical functional path, reconstruct its real behaviour and
> invariants, then correct or strengthen one concrete weakness with the smallest safe, verifiable
> change. If no weakness is proved, report the leading risk and missing proof instead of inventing
> a change.

## Claude-specific guarded mode

The `PreToolUse` hook is advisory by default. When `.semctx/guard.json` enables guarded mode, it
blocks only `git commit` and `git push` until the current diff hash has a recorded non-`BLOCK`
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
claude plugin uninstall semctx@semctx
claude plugin marketplace remove semctx
```
