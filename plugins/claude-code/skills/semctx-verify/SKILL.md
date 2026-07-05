---
name: semctx-verify
description: >-
  Verify the semantic blast radius of a code change before finishing. Use after any non-trivial
  edit and before a commit or push: check impacted invariants/contracts and run the recommended
  tests. Invoke when the user asks to commit, open a PR, or "make sure this change is safe".
---

# Verifying a change with semctx

`semctx` maps a diff to the symbols, exported contracts, declared invariants and tests it
affects, and returns a **PASS / WARN / BLOCK** verdict with evidence. It is **not** a code-search
tool — do not use it to find files for a task.

## When to run

After a non-trivial change, **before** committing or pushing:

1. Call the MCP tool **`semctx_verify_change`** (no argument analyses the current `git diff HEAD`;
   pass a unified diff to analyse something specific).
2. Read the verdict:
   - **PASS** — nothing gated. Proceed.
   - **WARN** — a request for attention, **not** a failure. A plain exported contract changed
     without a direct test. Decide whether a test is warranted; it is fine to proceed.
   - **BLOCK** — an invariant, or a critical (`critical`/`security`-tagged) contract, changed
     with no covering test. This must be resolved or explicitly disabled by the user's config.
3. Run the tests listed under `recommendedTests`. They must pass.
4. Fix every **BLOCK** before declaring the work done.

## Rules

- **Never declare the work finished while a BLOCK is unresolved.** Either add the missing test /
  fix the change, or the user explicitly disables the rule in `.semctx/config.json`.
- **WARN is not proof of failure.** Treat it as a prompt to consider a test, not a stop.
- **Never invent evidence.** Only cite findings, contracts, invariants and tests that appear in
  the report. If the report does not show something, do not claim it.
- **Do not oversell.** semctx verifies impact; it does not "understand the whole repository".
- **Static, not dynamic — semctx is the scope selector.** semctx never builds or runs the code.
  It says *what to re-test*; a runtime `/verify` step then *runs and observes* behaviour. Pair them
  — impact first, behaviour second — and never treat a semctx PASS as proof the code still works
  at runtime.

## Optional: guarded mode

If the project has guarded mode enabled (`.semctx/guard.json` with `{"enabled": true}`), a
pre-commit/push hook will **block** `git commit` / `git push` until the current diff has been
verified. Record a verification with:

```
semctx verify diff --record
```

after which an unchanged, non-BLOCK diff is allowed to commit. Any further edit invalidates it —
re-run the command. Guarded mode is opt-in; advisory (no blocking) is the default. It can be
strictly disabled with `SEMCTX_GUARD=off`.

## Local commands (equivalent to the MCP tool)

```
semctx verify diff                       # analyse working tree vs HEAD
semctx verify diff --base origin/main     # analyse a range (merge-base)
semctx verify diff --record               # analyse and record state for guarded mode
```
