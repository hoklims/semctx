# ADR 0007 — The Claude Code guarded hook gates on commit-bound working state, and is opt-in

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

Guarded enforcement is **source-state gated**, not re-analysis:

```
verify records:   HEAD + hash(tracked diff + non-ignored untracked bytes) + verdict
                 →  .semctx/verification-state.json
hook on git commit/push:
    recapture HEAD + complete working state
    allow  if both match the v2 baseline AND that verdict was not BLOCK
    block  otherwise, with the reason and the exact command to re-verify
```

State file `.semctx/verification-state.json` is **git-ignored** and written **atomically**
(temp file + rename). The baseline includes the commit, tracked binary diff, and every non-ignored
untracked path, mode, and byte. Legacy diff-only state is rejected; HEAD movement or any source
edit invalidates the baseline and requires re-verification.

## Consequences

- Fast: the hook does Git capture plus a hash compare, not an analysis run. Analysis happens once, when the agent
  calls verify.
- Safe: only terminal git verbs are gated; a false positive can never block editing or testing.
  Guarded is opt-in, and any user can disable enforcement (config flag / remove the hook).
- The hook parses git argv structurally (argv array, not a shell string) — no shell injection, no
  fragile command-string parsing.
- BLOCK is honoured: a recorded BLOCK verdict never satisfies the gate, even if the diff is
  unchanged.
- Cross-platform: the state/hash logic is a plain script; the guard reads stdin JSON from Claude
  Code's hook protocol and returns a structured decision.
