# Semctx — Claude Code plugin

Give a coding agent a **verify-before-commit** reflex: map a change to affected symbols,
contracts, invariants and tests, and get a PASS/WARN/BLOCK verdict — locally, deterministically,
with no LLM in the analysis and no network.

## What it installs

- **MCP tools** (`mcp.json`): `semctx_verify_change` (primary) and `semctx_inspect`.
  `semctx_prepare_task` is exposed but experimental — not a code-search retriever (ADR 0005).
- **Skill** (`skills/semctx-verify`): tells the agent to verify after non-trivial edits, run the
  recommended tests, and never finish on a BLOCK.
- **Guard hook** (`hooks/`): a `PreToolUse` guard that is **inert by default** (advisory) and, when
  the project opts into guarded mode, blocks only `git commit` / `git push` on an unverified diff.

## Two profiles

| profile | default | behaviour |
| --- | --- | --- |
| **advisory** | ✅ yes | MCP + skill. The guard hook is present but never blocks. |
| **guarded** | opt-in | The guard blocks `git commit`/`git push` until the current diff is verified. |

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
(ADR 0007); it runs no analysis itself.

## Requirements

- **Bun** on PATH (the MCP server runs under Bun).
- **Node** on PATH (the guard hook runs under Node, so it works even where Bun is absent).
- The project should be initialised + indexed once (`semctx init && semctx index`), or via
  `semctx init --preset github-claude`.

## Notes

- The MCP server resolves its repository from `SEMCTX_ROOT` (set to `${CLAUDE_PROJECT_DIR}` here);
  if your setup does not expose that variable, the server falls back to the process working
  directory.
- To remove the guard entirely (zero footprint), delete `hooks/hooks.json` from your plugin
  install, or keep advisory mode (the default) where it never blocks.

See `docs/integrations/claude-code.md` and `docs/integrations/claude-code-guarded-mode.md`.
