# Using semctx from Claude Code

semctx ships an MCP server whose primary Plane-A tools are:

- `semctx_verify_change` — analyse a diff for impact + a PASS/WARN/BLOCK verdict;
- `semctx_inspect` — inspect the repository graph around a symbol/capability;

`semctx_prepare_task` compiles a task into an **experimental** ContextPack. It is not a
code-search replacement or a primary task-to-code retriever
([accepted ADR 0005](../adr/0005-context-retrieval-pipeline-rejected.md)). Locate code with
normal repository search, then use `semctx_verify_change` to analyse a known change.

The server is **local-first and deterministic**: no LLM, no network, no CocoIndex. It fails closed
when a repository is not prepared; run `semctx setup` once before using MCP tools. Read-only calls
never create `.semctx/` or silently re-index the repository.

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
      "args": ["/absolute/path/to/semantic-context-compiler/packages/mcp-server/src/index.ts"]
    }
  }
}
```

No `SEMCTX_ROOT` is set: the server starts unbound and pins on the first absolute `repositoryRoot`
it receives. Every tool call must pass the absolute target as `repositoryRoot` (missing or relative
roots are rejected), except `semctx_control_verify_authorization`, whose entire input is
`{ request }` and which rejects `repositoryRoot` outright — it verifies a sealed capsule offline and
has no target repository.

Setting `SEMCTX_ROOT` is optional and only hard-binds the process to one checkout. It must then be
an **absolute** path: a relative value such as `.` is rejected at construction with
`REPOSITORY_ROOT_INVALID`, so the server never completes its handshake.

### Option B — `claude mcp add`

```bash
claude mcp add semctx -- bun /absolute/path/to/semantic-context-compiler/packages/mcp-server/src/index.ts
```

Pass the analysed repository's absolute `repositoryRoot` on every call, except
`semctx_control_verify_authorization` (see above).

## 3. Use it

In a Claude Code session:

- After locating and editing code: "Verify my change." -> `semctx_verify_change` returns the
  impacted invariants/contracts, the tests to run, and a PASS/WARN/BLOCK verdict.
- "Inspect the capability reservation-confirmation." -> `semctx_inspect`.
- Optional experiment after code search: "Prepare context for: fix the overbooking on concurrent
  confirmation." -> `semctx_prepare_task` returns eligible claims, suggested reads and tests,
  and contradictions from the repository graph. Treat these as experimental context.

## 4. CLI equivalent

Everything the MCP server does is also available on the CLI:

```bash
semctx setup
semctx verify diff
semctx inspect capability reservation-confirmation
```

The experimental ContextPack CLI path remains available for evaluation under ADR 0005:

```bash
semctx task create --from-file task.md
semctx context prepare <task-id>
```

## Determinism note

The only non-deterministic value in any output is the `generatedAt` / `createdAt`
timestamp. Run the same task against the same repository state twice and the ContextPack
is byte-identical otherwise.
