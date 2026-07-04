# Claude Code integration

The Claude Code plugin (`plugins/claude-code`) gives an agent a verify-before-commit reflex,
locally and deterministically. Two things ship:

1. **MCP tools** — `semctx_verify_change` (primary) and `semctx_inspect`.
2. **A skill** — instructs the agent to verify after non-trivial edits, run the recommended
   tests, and never finish on a BLOCK.

A guard hook is also included but is **inert by default** (advisory). See
[claude-code-guarded-mode.md](./claude-code-guarded-mode.md) to opt into enforcement.

## Install

The plugin lives in this repository under `plugins/claude-code`. Point Claude Code at it as a
plugin (repo-hosted). It requires:

- **Bun** on PATH — the MCP server runs under Bun.
- **Node** on PATH — the guard hook runs under Node (works even without Bun).

Initialise the project once so there is a graph to verify against:

```bash
semctx init && semctx index
# or, with the bootstrap preset:
semctx init --preset github-claude
```

## MCP without the plugin

If you prefer to register the MCP server directly (no plugin), add:

```json
{
  "mcpServers": {
    "semctx": {
      "command": "bun",
      "args": ["/abs/path/semantic-context-compiler/packages/mcp-server/src/index.ts"],
      "env": { "SEMCTX_ROOT": "." }
    }
  }
}
```

The server resolves its repository from `SEMCTX_ROOT`, falling back to the working directory.

## The tools

| tool | use |
| --- | --- |
| `semctx_verify_change` | **primary.** Analyse a diff (or the current `git diff HEAD`) → impacted invariants/contracts, recommended tests, PASS/WARN/BLOCK, with evidence. |
| `semctx_inspect` | Inspect the graph around a symbol/capability. |
| `semctx_prepare_task` | **experimental** — not a code-search retriever (ADR 0005). |

## The agent workflow (from the skill)

1. After a non-trivial change, call `semctx_verify_change`.
2. `PASS` → proceed. `WARN` → consider a test, not a blocker. `BLOCK` → resolve before finishing.
3. Run the `recommendedTests`.
4. Never declare the work done while a BLOCK is unresolved. Never cite evidence absent from the
   report. Do not claim "full repository understanding" — semctx verifies impact, nothing more.
