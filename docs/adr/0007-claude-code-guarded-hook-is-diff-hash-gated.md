# ADR 0007 — The Claude Code guarded hook gates on analyzed content, and is opt-in

- Status: accepted
- Date: 2026-07-04
- Amended by: ADR 0029 — the hook-surface rule is relaxed only under an explicit
  `"hooks": "project-managed"` declaration, and hook bypass (`--no-verify`) is non-authorizing.

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
  (`git commit`, `git push`) — never edits, tests, exploration, or non-terminal git commands. The
  terminal operation must be isolated; compound commands, substitutions, and redirections are
  rejected before the state comparison.

Guarded enforcement is **source-state gated**, not re-analysis:

```
verify records:   HEAD + exact analyzed-diff hash + raw content hash + canonical repository-state hash
                  + exact index-state hash + verdict
                 →  .semctx/verification-state.json
hook on git commit:
    allow  if the analyzed content still matches the v3 baseline, the index exactly materializes
           it, the command consumes that whole index, AND verdict != BLOCK
hook on git push:
    allow  if the content still matches AND HEAD exactly materializes the recorded repository state
           AND an explicit non-delegating remote carries that verified HEAD only
    block  otherwise, with the reason and the exact command to re-verify
```

State file `.semctx/verification-state.json` is **git-ignored** and written **atomically**
(temp file + rename). The baseline binds normalized paths, raw bytes or symlink targets, executable
modes, the canonical Git object representation, and the HEAD tree observed at verification time.
Present tracked files are hashed from their materialized bytes even when `assume-unchanged` or
`skip-worktree` suppresses them from Git's ordinary diff output. Such a hidden mismatch makes
`--record` fail closed because those bytes were absent from the analyzed diff; only absent
sparse-checkout entries may reuse their indexed object. Initialized gitlinks are compared directly
to their materialized submodule HEAD, independently of Git's submodule-diff configuration; a
directly symlinked gitlink is rejected rather than followed.
The CLI also compares the exact resolved HEAD and diff bytes consumed by analysis with captures made
before and after analysis, so an A-B-A working-state race cannot attach B's verdict to A's baseline.
A commit SHA may move without invalidating the proof when the resulting tree exactly materializes
the recorded repository state. Byte, path, mode, symlink-target, partial-commit, or non-ignored
untracked drift fails closed. Version 1 and version 2 records remain readable JSON but do not
authorize a terminal Git operation.

## Consequences

- Fast: the hook does Git capture plus a hash compare, not an analysis run. Analysis happens once, when the agent
  calls verify.
- Safe: only terminal git verbs are gated; a false positive can never block editing or testing.
  Guarded is opt-in, and any user can disable enforcement (config flag / remove the hook).
- The hook parses the command string structurally without evaluating it. It permits only an isolated
  terminal Git operation plus explicit, literal cwd and non-retargeting environment/Git-global
  prefixes, closing the pre-check TOCTOU created by mutating shell segments. Paths requiring shell
  expansion (`$VAR`, `${VAR}`, `~`, or globs) and repository-state retargeting (`GIT_DIR`,
  `GIT_WORK_TREE`, `--git-dir`, `--work-tree`, namespaces, alternate index/object state, or
  equivalent config) are outside the isolated-command contract and fail closed when the target or
  session repo enables guarded mode. Command-scoped executable/config discovery changes (`PATH`,
  home/profile or XDG config variables, and related Git discovery variables) and non-canonical Git
  executable paths and `--exec-path=<path>` fail closed so the hook and the shell cannot resolve
  different Git programs or configuration. Literal quote/backslash composition is normalized for detection, so forms such as
  `g\it`, `gi't'`, `git co'mmit'`, `git pu\sh`, escaped newlines, or a composed `P'A'TH=...`
  assignment cannot hide the terminal Git operation. Direct `command`, `exec`, and `builtin` forms,
  plus shell-expanded executable expressions such as `$GIT`, `${GIT:-git}`, `$(printf git)`, and
  `$(true; printf git)` (including literal parameter fallbacks and fragments such as `${X:=git}`,
  `${X:-g}it`, and `$(printf g)it`), and
  expansion-split terminal words such as `git${IFS}push` and
  `${GIT:-git}${IFS}push`, are detected and rejected as non-canonical command shapes. Shell expansion
  in any otherwise authorizable terminal-command word is also rejected, so word splitting cannot
  turn an inspected argument such as `.${IFS}--all` into an uninspected push option.
  Visible terminal operations nested in command substitutions, backticks, asynchronous `&`
  segments, subshell groups, or brace groups are detected too and then rejected as non-isolated.
  The same applies after shell control keywords and the recognized execution-transparent wrappers
  `chroot`, `chrt`, `doas`, `ionice`, `nice`, `nohup`, `setsid`, `stdbuf`, `sudo`, `taskset`,
  `time`, `timeout`, and `unshare`; arbitrary other external wrappers remain outside the cooperative contract.
  Recognized `bash`/`sh`/`zsh` command wrappers include both a separate `-c` and grouped short
  options containing `c`, such as `-lc`, `-ec`, or `-euc`.
- Commit commands must consume the already-inspected whole index. Commit-time staging, interactive
  selection, partial-index options, pathspecs, and every `--fixup` form fail closed, including Git's
  accepted long-option abbreviations. Every persisted version 3
  field is shape-validated before authorization. Verification diff capture disables external diff
  and textconv helpers so repository configuration cannot substitute the analyzed hunks. A commit
  is non-authorizing while the effective hooks directory contains any entry except ordinary
  `*.sample` files. This covers current and future hook names, including `reference-transaction`,
  `post-index-change`, `pre-auto-gc`, and `pre-push`: earlier hooks can restage a different tree,
  while later hooks can initiate unguarded follow-up effects after the pre-tool check. ADR 0029
  relaxes this rule only for a repository whose `guard.json` declares `"hooks": "project-managed"`;
  there `semctx verify hook` runs as the last hook job and the index/HEAD tree checks above remain
  in force. `--no-verify` (commit `-n` included) is non-authorizing in every guarded profile.
  All command-scoped config (`-c key=value`, attached `-ckey=value`, and `--config-env`) is outside
  the authorizing contract so direct or included config cannot evade that hook-surface probe.
- Push refspecs are resolved before authorization. Deletions, multi-ref, mirror, tag-wide, wildcard,
  configured, ambiguous, or non-HEAD sources fail closed. An explicit source must be literal `HEAD`
  or the exact full verified object ID, and the remote must be explicit. Push options use a closed allowlist; receiver delegation and
  arbitrary server options (`--exec`, `--receive-pack`, and `--push-option`), including configured
  `push.pushOption` and remote server options, are rejected. Configured `submodule.recurse` is also
  rejected so an inspected single-repository push cannot implicitly publish submodule commits. Likewise,
  command-scoped transport helpers (`GIT_PROXY_COMMAND`, `GIT_SSH`, or `GIT_SSH_COMMAND`), proxy
  environment overrides (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, or `NO_PROXY`), configured HTTP
  proxy/resolution, configured
  executable transport/proxy helpers, configured `remote.<name>.vcs` helpers, remote proxy authentication,
  URL rewrites, unknown URL schemes, `ext::` remote helpers, and
  `remote.<name>.receivepack` helpers are rejected before an exact-HEAD push is authorized. Configured
  remote names are authorized only after every effective push URL passes the same transport check.
  shell words composed with embedded quotes or backslashes are rejected, so lexical reconstruction
  cannot disguise a source-expanding option. Guarded mode never reuses one HEAD proof to publish
  another ref.
- If Git cannot resolve the top-level directory, the hook walks literal parent directories for the
  nearest `.git` or guarded `.semctx` marker. A failed Git probe therefore cannot silently turn a
  guarded nested invocation into advisory mode. An initialized gitlink whose repository or HEAD
  probe fails is likewise rejected rather than treated as an uninitialized checkout.
- BLOCK is honoured: a recorded BLOCK verdict never satisfies the gate, even if the diff is
  unchanged.
- Cross-platform: the state/hash logic is a plain script; the guard reads stdin JSON from Claude
  Code's hook protocol and returns a structured decision.
