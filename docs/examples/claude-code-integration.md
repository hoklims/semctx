# Using semctx from Claude Code

semctx ships an MCP server exposing three tools:

- `semctx_prepare_task` — compile a task into a justified ContextPack;
- `semctx_inspect` — inspect the repository graph around a symbol/capability;
- `semctx_verify_change` — analyse a diff for impact + a PASS/WARN/BLOCK verdict.

The server is **local-first and deterministic**: no LLM, no network, no CocoIndex. On
first use it auto-initialises `.semctx/` and indexes the repository it is pointed at.

## 1. Install (local, from the repo)

```bash
bun install
bun run build   # typecheck
```

No global install is required — the server runs straight from source with Bun.

## 2. Register the MCP server

### Option A — project `.mcp.json`

Create `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "semctx": {
      "command": "bun",
      "args": ["/absolute/path/to/semantic-context-compiler/packages/mcp-server/src/index.ts"],
      "env": { "SEMCTX_ROOT": "." }
    }
  }
}
```

`SEMCTX_ROOT` is the repository semctx should analyse. When omitted, it defaults to the
server process's working directory.

### Option B — `claude mcp add`

```bash
claude mcp add semctx -- bun /absolute/path/to/semantic-context-compiler/packages/mcp-server/src/index.ts
```

Set `SEMCTX_ROOT` in the environment if the analysed repo differs from the cwd.

## 3. Use it

In a Claude Code session:

- "Prepare context for: fix the overbooking on concurrent confirmation."
  Claude calls `semctx_prepare_task`; the returned ContextPack tells it which files are
  authoritative, which invariant is non-negotiable, which tests to run, and which docs
  are contradictory (non-normative).
- "Inspect the capability reservation-confirmation." -> `semctx_inspect`.
- Before finishing: "Verify my change." -> `semctx_verify_change` returns the impacted
  invariants/contracts, the tests to run, and a PASS/WARN/BLOCK verdict.

## 4. CLI equivalent

Everything the MCP server does is also available on the CLI:

```bash
semctx init
semctx index
semctx task create --from-file task.md
semctx context prepare <task-id>
semctx inspect capability reservation-confirmation
semctx verify diff
```

## Determinism note

The only non-deterministic value in any output is the `generatedAt` / `createdAt`
timestamp. Run the same task against the same repository state twice and the ContextPack
is byte-identical otherwise.
