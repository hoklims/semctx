# Semctx — Claude Code plugin

Give Claude Code the same proof-honest semctx workflow as Codex: reconstruct a change across
repository facts, authored intent and migration controls, then verify the resulting diff and real
runtime behaviour. The analysis is local and deterministic; semctx itself needs no LLM or network.

## What it installs

- **Repository MCP tools** (`.mcp.json`): `semctx_setup` (plugin-native workspace bootstrap),
  `semctx_verify_change`, `semctx_inspect`, and the experimental `semctx_prepare_task` (not a
  code-search retriever; ADR 0005).
- **Semantic-layer tools**: `semctx_semantic_check`, `semctx_semantic_slice`, `semctx_change_open`,
  `semctx_change_update`, `semctx_change_verify`, `semctx_semantic_inspect`, `semctx_handoff`,
  `semctx_resume` — authored intent, invariants, decisions, evidence and unknowns (Plane B).
- **Control-plane tools**: read-only `semctx_control_status`, `semctx_control_trace`, and
  `semctx_control_plan` for freshness preflight, bounded L0-L6 reconstruction, and fail-closed
  migration planning (Plane C); manual content-addressed `semctx_control_handoff` /
  `semctx_control_resume`; plus the MCP-only advisory `semctx_control_agent_lifecycle` checkpoint.
- **Bundled CLI** (`dist/semctx.js`): the full Bun CLI committed with the `dist/semctx-mcp.js`
  entry and their fixed root `dist/semctx-shared.js` runtime chunk, so a plugin update keeps agent
  MCP and CLI in lockstep. Agent sessions get its absolute path for free:
  Claude Code substitutes the `${CLAUDE_PLUGIN_ROOT}` placeholder into the skills at load time, and
  the guard hook prints a resolved path. The variable is exported to hooks and MCP servers, **not**
  to the agent's shell. A global `semctx` (`bun install -g semctx@latest`) remains optional for CI and
  non-plugin shells.
- **Shared skill**: `skills/semctx-control` — host-neutral workflow body is byte-identical to Codex;
  the shell CLI ladder is generated per host at `plugin:build` (Claude keeps the plugin-CLI
  placeholder; Codex documents global `semctx` only). Source template:
  `plugins/shared/skills/semctx-control/SKILL.md`.
- **Focused skills**: `skills/semctx-verify` for Plane A and `skills/semctx-semantic` for Plane B.
- **Guard hook** (`hooks/`): a `PreToolUse` guard that is **inert by default** (advisory) and, when
  the project opts into guarded mode, blocks non-isolated `git commit` / `git push` commands or an
  unverified working state. Block messages point at the plugin-bundled CLI by absolute path when
  the bundle is in reach, and at a global `semctx` otherwise. The semantic and control tools do not
  change this host-specific behaviour.

## Shared Codex/Claude contract

Both plugins now use the same `semctx-control` skill and the same MCP server identity. They follow
the same sequence: inspect normally → rehydrate intent → check freshness → trace L0-L6 → compile a plan → open a
change contract only for user-authorized writes → edit → verify impact → run runtime checks →
compose the final verdict.

The verdict namespaces stay distinct:

- Plane A: `PASS` / `WARN` / `BLOCK`;
- Plane B: `VERIFIED` / `PARTIAL` / `BLOCKED` / `STALE`;
- Plane C: `READY` / `BLOCKED`.

`READY` is never execution authority. Claude Code may edit only inside the user's write scope, and
Plane C never performs a cutover, deployment or deletion.

### MCP-only lifecycle foundation

Codex and Claude Code expose the same strict lifecycle policy and report through
`semctx_control_agent_lifecycle`. Agents must invoke it explicitly at
`before_implementation_write` before the first eligible L2+ write, `after_repository_edits` after
edits, `before_completion` before claiming completion, and `before_compaction` before compaction or
owner transfer. The request carries `requiredAltitude`; pre-write L0-L1 is `NO_OP`.

`NO_OP` means no stage-presence obligation applies, `RECORDED` means all required stage ids were
recorded, and `INCOMPLETE` means required ids are missing. The report evaluates neither stage
outcomes nor admissibility. It also distinguishes a non-Semctx no-op from an explicit
`semctx_unready` repository.

Touched coordinates are `caller_observed_advisory`. Their fold is
`stateless_caller_reinjected_unbound`: the caller must reinject prior ids, and Semctx persists or
binds none of them. The tool is read-only and source-non-collecting; `shadow` mode blocks nothing
and grants no execution authority. The separate manual Control Handoff v2 surface derives a
task-bound capsule from fresh reconciliation and resumes only its exact hash. Its progress pointer
requests a proof-bearing boundary from current state, never execution history. Explicit
zero-obligation labels are reported separately and are the only phases the next transition may
skip; empty legacy steps fail closed and unsatisfied migration obligations remain `UNPROVEN`. An
edit-only step may focus the exact sealed observed hunk SHA-256 node at L0. Capture writes ignored
local working state, remains manual, shadow-only, non-blocking, and grants
`executionAuthority: "none"`. It is not invoked by the checkpoint. There are no automatic lifecycle hooks.
Persisted or measured telemetry, enforcement, and an executor remain unshipped.
Claude's existing optional commit/push guard is separate and invokes neither lifecycle surface.

## Two profiles

| profile | default | behaviour |
| --- | --- | --- |
| **advisory** | ✅ yes | MCP + skill. The guard hook is present but never blocks. |
| **guarded** | opt-in | The guard requires isolated `git commit`/`git push` commands and a verified current state. |

Enable guarded mode for a project:

```jsonc
// .semctx/guard.json
{ "enabled": true }
```

Strictly disable enforcement at any time (wins over `guard.json`):

```
SEMCTX_GUARD=off
```

The guard only ever gates the two terminal git verbs — never file edits, tests, exploration, or
non-terminal git commands. It compares a hash of the working diff to the last verified hash
(ADR 0007); it runs no analysis itself. In guarded mode, cwd prefixes must be literal and Git
repository retargeting (`GIT_DIR`, `GIT_WORK_TREE`, `--git-dir`, `--work-tree`, and related forms)
is rejected rather than compared against the session repository's hash.

## Requirements

- **Bun** on PATH (the bundled MCP server and CLI run under Bun; no global `semctx` / `semctx-mcp`
  link is required for agent use).
- **Node** on PATH (the guard hook runs under Node, so it works even where Bun is absent).
- The project should be initialised and indexed once (prefer the **plugin MCP tool** — no global
  package install):

```text
# Preferred (agent / plugin): MCP tool after user OK
semctx_setup { "repositoryRoot": "/abs/path", "confirm": true }

# Shell fallbacks
bun "<plugin-root>/dist/semctx.js" setup    # plugin-bundled CLI (same release as MCP)
semctx setup                                # optional global install
```

  The legacy equivalent is `semctx init && semctx index`; CLI `setup --preset github-claude` also
  installs the preset integration files.

Preferred install/update from a target repository:

```powershell
bunx semctx@latest install --host claude
```

Use `--skip-setup` for a machine-only refresh or `--dry-run` to preview. Manual install from this
clone remains available:

```powershell
claude plugin marketplace add ./
claude plugin install semctx@semctx-stable --scope user
```

After installing or updating during an active session, run `/reload-plugins` to load the new
snapshot. Restart Claude Code only if the reload reports an error or the plugin remains unavailable.

If an older direct MCP registration is still present, remove it after the plugin is enabled with
`claude mcp remove semctx -s user`; otherwise Claude sees duplicate copies of the same tools.

## Notes

- Every MCP call must pass the absolute project path as `repositoryRoot`; missing or relative roots
  are rejected.
- Both host plugins ship byte-identical `dist/semctx-mcp.js` and `dist/semctx.js` entries plus the
  fixed root `dist/semctx-shared.js` runtime chunk. Claude also binds `SEMCTX_ROOT`, while the
  shared skill passes the explicit `repositoryRoot` required by the common Claude/Codex machine
  contract.
- Invoke the shared workflow explicitly as `semctx-control` for migrations, architecture work,
  generic demonstrations or cross-plane verification. The narrower skills remain available for
  backward compatibility.
- To remove the guard entirely (zero footprint), delete `hooks/hooks.json` from your plugin
  install, or keep advisory mode (the default) where it never blocks.

See `docs/integrations/claude-code.md` and `docs/integrations/claude-code-guarded-mode.md`.
