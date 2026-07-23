# Claude Code — guarded mode

Guarded mode makes the plugin's `PreToolUse` hook **block** `git commit` / `git push` until the
current commit-bound working state has been verified. It is **opt-in**; advisory is the default.

## How it works (ADR 0007)

```
you run:   semctx verify diff --record
             → analyses the diff, records { HEAD, hash(tracked + untracked state), verdict } to
               .semctx/verification-state.json  (git-ignored, written atomically)

hook on `git commit` / `git push`:
   recapture HEAD + tracked diff + non-ignored untracked paths/modes/bytes
   ALLOW  if the v2 baseline matches AND recorded verdict != BLOCK
   BLOCK  otherwise, printing the exact command to re-verify
```

The hook does a **hash comparison, not an analysis** — it is fast and never re-runs the engine.
It parses the Bash command **structurally** (segments + tokens, never a shell eval) and gates
**only** the two terminal git verbs. It never blocks file edits, tests, exploration, or
non-terminal git commands.

## Enable

Create `.semctx/guard.json` in the project (see `plugins/claude-code/examples/guard.json`):

```json
{ "enabled": true }
```

## The loop

```bash
# ... make changes ...
semctx verify diff --record     # PASS/WARN → commit allowed; BLOCK → resolve first
git commit -m "..."             # allowed only if the diff is unchanged since --record
```

If HEAD moves or any tracked/untracked source input changes, the baseline no longer matches and the commit is blocked until you
re-run `semctx verify diff --record`.

## Disable

- **Strictly, at any time** (wins over `guard.json`): `SEMCTX_GUARD=off` in the environment.
- **Per project**: set `.semctx/guard.json` to `{ "enabled": false }`, or delete it.
- **Entirely**: remove the hook from the plugin install; advisory mode never blocks.

## Workflow guarantees and non-goals

- `BLOCK` is honoured: a recorded BLOCK verdict never satisfies the gate, even if the diff is
  unchanged.
- No false positive can block editing or testing — only `git commit` / `git push` are gated.
- The state file `.semctx/verification-state.json` is git-ignored and written atomically.
- Legacy diff-only baselines are rejected and must be recreated with `--record`.

This is a cooperative soft gate, not a sandbox or hostile-agent boundary. The same local principal
can edit `verification-state.json`, set `SEMCTX_GUARD=off`, invoke Git outside Claude Code, or use a
command shape/tool the hook does not recognize. Detection covers direct Bash invocations plus common
quoted/path/`command`/`bash -c` forms, but aliases, shell functions, arbitrary nesting and non-Bash
tools remain outside the contract. A syntactically valid state is still an authored assertion.
