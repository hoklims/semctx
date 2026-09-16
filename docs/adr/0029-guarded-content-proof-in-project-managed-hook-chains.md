# ADR 0029 — Guarded content proof may run as the last job of a project-managed Git hook chain

- Status: accepted
- Date: 2026-09-16
- Amends: ADR 0007 (hook-surface rule). Design thread: issue #169.

## Context

ADR 0007 places the content proof in the plugin's `PreToolUse` hook and, to keep that proof honest,
refuses to authorize `git commit` / `git push` while the effective hooks directory contains any
entry except `*.sample`. Managed hook wrappers (Lefthook, husky) install themselves *as* the
`pre-commit` and `pre-push` files, and commonly run writers — formatters, restagers, codegen —
before the commit object exists. Two consequences followed:

1. Guarded mode was unusable next to any real Lefthook/husky install. The repository even documented
   `verify diff --staged` inside a Lefthook job (`docs/examples/pre-commit-hook.md`) while guarded
   mode refused the same install.
2. Relaxing the rule alone leaves a sequence hole. `PreToolUse` authorizes index `I`; a pre-commit
   writer produces `I'`; the commit records `I'`; the push gate compares `HEAD` (`I'`) with the
   recorded proof (`I`) and blocks. The obvious repair — a second `verify diff --record` after the
   commit — analyzes an *empty* working-tree diff: it re-stamps the committed tree with a vacuous
   `PASS`. It is not a proof of `I'`.

`PreToolUse` runs before Git and cannot observe the index after the project's hooks. Only a job
inside the hook chain, after the last writer, sees the tree Git is about to record.

## Decision

1. **Opt-in declaration.** `.semctx/guard.json` accepts `{ "enabled": true, "hooks": "project-managed" }`.
   Under it the guard no longer requires a sample-only hooks directory for commit or push. Without
   the key, ADR 0007's rule is unchanged. Any other `hooks` value is a malformed configuration
   (unknown enablement), never a relaxation. Only the target repository's own `guard.json` can
   declare its hooks project-managed; a session-root declaration never relaxes another repository.
2. **`semctx verify hook pre-commit`** is the content proof of the tree Git will record. Run as the
   last pre-commit job, it captures the recordable state after the last writer, refuses a partial
   index (unstaged edits, non-ignored untracked files) before any analysis, returns without analysis
   when a non-`BLOCK` record already covers that exact tree, and otherwise records a new
   working-tree verification under the same stability and refusal rules as `verify diff --record`.
   Exit `0` when covered or recorded non-`BLOCK`; `3` on `BLOCK` (the commit is aborted); `1` when
   the hook cannot vouch for the commit.
3. **`semctx verify hook pre-push`** never records. It reads Git's `<local ref> <local oid> <remote
   ref> <remote oid>` lines and requires the tree of every pushed commit to equal the recorded
   `repositoryStateHash`. Deletions and unproven commits are refused (`1`); a matching `BLOCK`
   record exits `3`. Without ref lines (a manual run) it checks `HEAD`.
4. **`PreToolUse` keeps both tree checks.** The commit-time check forces a fresh proof before the
   commit starts, which is what keeps the in-hook job a hash compare in the no-drift case. The
   push-time check is the *ordering verifier*: a writer that runs after the semctx job leaves
   `HEAD` ≠ recorded state, and the push fails closed with a reason naming the misordering.
5. **Hook bypass is non-authorizing** on both verbs, in every guarded profile: `git commit
   --no-verify` / `-n` (including short clusters carrying `n` and Git long-option abbreviations)
   and `git push --no-verify`. `--no-verify` leaves the safe push-option list; `git push -n` stays
   `--dry-run`.
6. The plugin hook stays agent-only. Taking the proof into the hook chain also gates a human
   `git commit` / `git push` in that repository. That is the declared integration, chosen by the
   project, not a side effect.

## Consequences

- Placement is the project's responsibility and is verified after the fact, not at declaration
  time. `semctx verify hook pre-commit` must be the last command of one sequential pre-commit
  script (Lefthook: a single `commands:` entry running a script, or `parallel: false` with the
  proof last — a parallel sibling races the formatter). A misplaced job is caught by the push-time
  check, not at commit time.
- The cost model of ADR 0007 is preserved: analysis runs only when the tree drifted between the
  agent's `verify diff --record` and the end of the hook chain. Running the project's writers before
  `verify diff --record` makes that drift zero in the nominal loop; the verify skill says so.
- Residues, accepted and named: `post-commit` / `post-rewrite` hooks may publish an unverified tree
  from inside the chain (ADR 0007's follow-up-effect concern moves from *refused* to *accepted
  under the declaration*); a human `--no-verify` bypasses the chain outside the plugin; a pre-push
  hook cannot alter the pushed commits but can still move local refs or push other refs; and a
  `verify diff --record` run on a clean tree after a commit remains a vacuous re-stamp — this is
  pre-existing, unchanged here, and the reason `verify hook pre-push` never records.
- Threat model unchanged: a negligent agent and a cooperative local principal, not a hostile one.

## Public contract and compatibility

- `guard.json`: additive optional key `hooks`; existing files behave identically.
- CLI: new `verify hook <pre-commit|pre-push>` with text output and exit codes only; no versioned
  JSON is added. `verify diff` is unchanged.
- Guard: a tightening. `--no-verify` on commit or push was previously authorizable (push listed it
  as safe; commit did not inspect it) and is now non-authorizing in guarded mode.
- Plugin runtimes are regenerated for both host trees; the OMP adapter shares `evaluateGuard`
  unchanged. Evidence: `plugins/claude-code/test/guard.test.ts` (bypass detection, policy, real-Git
  replay of a restaging hook caught at push time) and `apps/cli/test/verify-hook-cli.test.ts`
  (record / current / drift / partial index / untracked / pre-push refs / `BLOCK` / a real
  `pre-commit` hook running the CLI after a writer).
