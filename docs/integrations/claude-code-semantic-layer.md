# Claude Code — semantic layer integration

The Claude Code plugin exposes the semantic layer as **advisory** MCP tools plus focused and shared
skills. Use `semctx-semantic` for Plane B alone or `semctx-control` for the byte-identical Plane
A/B/C workflow shipped with Codex. Neither skill blocks exploration, reading, editing or tests; the
existing guarded hook (ADR 0007) still only gates `git commit` / `git push` on opt-in.

## MCP tools

| tool | purpose |
| --- | --- |
| `semctx_verify_change` | **primary, unchanged** — Plane-A impact + PASS/WARN/BLOCK for a diff |
| `semctx_semantic_check` | versioned model/link/lifecycle report with canonical refusal reasons |
| `semctx_semantic_slice` | bounded, deterministic capsule for an explicit scope (change/symbol/claim) — **not** code search |
| `semctx_change_open` | open a proof-carrying change contract (provenance `agent`), set active |
| `semctx_change_update` | additively patch a change; unknown resolution requires proven `proved_by` evidence |
| `semctx_change_verify` | compose `verify diff` + the contract → VERIFIED/PARTIAL/BLOCKED/STALE |
| `semctx_change_close` | derive `verified` after a fresh VERIFIED composed check, or mark superseded |
| `semctx_semantic_inspect` | inspect a semantic id: declaration, incoming refs, link resolution |
| `semctx_handoff` / `semctx_resume` | capture / rehydrate the working delta across a compaction |

All are served by the same MCP server (`.mcp.json`); no extra registration is needed. Every call
must pass `repositoryRoot` as the absolute project root. The explicit machine contract prevents a
plugin-cache working directory from becoming the accidental target.

## Agent loop (skill `semctx-semantic`)

For a non-trivial change:

1. `semctx_change_open` — declare goal served, invariants to preserve, evidence required, unknowns.
2. `semctx_semantic_slice { changeId }` — pull the bounded capsule (intentions, invariants,
   decisions, linked symbols, evidence, open unknowns, safety constraints, next proofs).
3. Edit the code.
4. `semctx_verify_change` — Plane-A impact + recommended tests.
5. `semctx_change_verify { changeId }` — the composed verdict.
6. Run the recommended tests.
7. Record obtained proofs in the authored evidence, ensure each resolved unknown declares a
   `proved_by` relation to proven evidence, then use `semctx_change_update` to resolve it.
8. `semctx_change_close` — derive `verified` only after the fresh composed check passes.
9. **Never conclude "done" on BLOCKED.** On **PARTIAL**, state exactly what remains unproven
   (pending evidence + open unknowns). On **STALE**, re-link before trusting the verdict.

## Handoff across compaction

Claude Code's hook surface is used conservatively: the plugin ships **only** the existing
`PreToolUse` guard. Anti-compaction rehydration is exposed as **explicit** tools/commands
(`semctx_handoff` / `semctx_resume`, or `semctx semantic handoff` / `resume`) rather than relying on
an implicit compaction event — capture before you compact, resume after. The capsule lives in
`.semctx/working/` (local, git-ignored).

## Guarded mode

Unchanged. The semantic tools are advisory and add no blocking. Guarded mode still only concerns
`git commit` / `git push` via the commit-bound working-state hook, enabled by `.semctx/guard.json` (`{ "enabled":
true }`) and strictly disabled by `SEMCTX_GUARD=off`. A BLOCKED `change verify` is a signal to the
agent, not a commit gate — wire it into CI (`change verify --fail-on block`) if you want enforcement.
