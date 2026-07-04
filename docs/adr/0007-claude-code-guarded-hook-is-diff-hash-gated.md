# ADR 0007 — The Claude Code guarded hook gates on a diff hash, and is opt-in

- Status: accepted
- Date: 2026-07-04

## Context

The Claude Code plugin should let an agent verify a change before committing, and optionally
*enforce* that. A naive enforcement ("run verify inside the commit hook") re-runs analysis on
every commit attempt, is slow, and couples the hook to the engine's runtime. We also must not
block ordinary work (file edits, tests, exploration) — only the terminal act of recording history.

## Decision

Two profiles, **advisory by default**:

- **advisory** (default): MCP tools + skill only. Never blocks anything. The agent is *guided* to
  run `semctx_verify_change` before finishing, but nothing is enforced.
- **guarded** (opt-in): a `PreToolUse` hook that blocks **only** terminal git verbs
  (`git commit`, `git push`) — never edits, tests, exploration, or non-terminal git commands.

Guarded enforcement is **diff-hash gated**, not re-analysis:

```
verify records:   hash(current working diff) + verdict  →  .semctx/verification-state.json
hook on git commit/push:
    recompute hash(current working diff)
    allow  if hash == last verified hash AND that verdict was not BLOCK
    block  otherwise, with the reason and the exact command to re-verify
```

State file `.semctx/verification-state.json` is **git-ignored** and written **atomically**
(temp file + rename). The hash is over the normalized diff text, so an unchanged diff that was
verified stays verified; any edit invalidates it and re-verification is required.

## Consequences

- Fast: the hook does a hash compare, not an analysis run. Analysis happens once, when the agent
  calls verify.
- Safe: only terminal git verbs are gated; a false positive can never block editing or testing.
  Guarded is opt-in, and any user can disable enforcement (config flag / remove the hook).
- The hook parses git argv structurally (argv array, not a shell string) — no shell injection, no
  fragile command-string parsing.
- BLOCK is honoured: a recorded BLOCK verdict never satisfies the gate, even if the diff is
  unchanged.
- Cross-platform: the state/hash logic is a plain script; the guard reads stdin JSON from Claude
  Code's hook protocol and returns a structured decision.
