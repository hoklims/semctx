# Pre-commit / CI gate with `semctx verify diff`

`semctx verify diff` analyses a git diff and exits **non-zero on `BLOCK`** (exit code 3), so it
drops straight into a pre-commit hook or a CI job. `WARN` and `PASS` exit 0 by default; add
`--fail-on warn` to also fail on `WARN` (`--strict` is a legacy alias).

## Local pre-commit hook

`semctx verify diff --staged` analyses exactly what is staged for the commit.

Bun loads `bunfig.toml` preloads and `.env` from its working directory before semctx can inspect
source. A clean contributor checkout is not necessarily trusted. All Bun-backed commands below
start from a trusted semctx installation, separate from the analysed checkout, and pass the
captured absolute repository path through `--root`. Do not point `semctx_home` at an untrusted
branch, or run a bare `semctx` command there. See [SECURITY.md](../../SECURITY.md#integrations).

Create `.git/hooks/pre-commit` (make it executable: `chmod +x .git/hooks/pre-commit`):

```sh
#!/bin/sh
# Block a commit whose staged diff violates a strict-tier rule
# (invariant or critical contract changed without a covering test).
repo_root="$(git rev-parse --show-toplevel)" || exit 1
semctx_home="/abs/path/semantic-context-compiler" # trusted installation, not the contributor checkout

# Skip if the repo was never indexed (nothing to verify against).
[ -d "$repo_root/.semctx" ] || exit 0

bun --cwd "$semctx_home" "$semctx_home/apps/cli/src/index.ts" verify diff --staged --root "$repo_root"
status=$?
if [ "$status" -eq 3 ]; then
  echo "semctx: BLOCK — a strict-tier rule failed. Fix or add a test, then re-commit."
  echo "        (bypass once with:  git commit --no-verify)"
  exit 1
fi
exit 0
```

Notes:

- The hook re-uses the **already-indexed** `.semctx/` graph and must not re-index. A staged or
  working-tree check reads the index as a snapshot of the committed `HEAD` and matches the diff's
  old-side line numbers against it. Indexing the staged or edited tree first stores post-edit
  ranges, which can stop overlapping those hunks and hide a `WARN` or `BLOCK` finding.
- Re-index outside the hook, from a clean tree, after each commit, pull or branch switch, using
  the trusted-directory command below. If `HEAD` changes without a refresh, the next check returns
  `BLOCK` with `index_binding_stale`. Indexing was previously measured at sub-second on the demo
  repo and about 3–4 s on a 260-file monorepo; these timings have not been re-measured here.
- Use `--fail-on warn` in the hook if you want `WARN` (plain exported contract without a direct
  test) to block as well.
- `git commit --no-verify` bypasses the hook for the rare intentional exception.

To refresh the committed snapshot outside the hook, run this from the clean analysed checkout:

```sh
repo_root="$(git rev-parse --show-toplevel)" || exit 1
semctx_home="/abs/path/semantic-context-compiler" # trusted installation
bun --cwd "$semctx_home" "$semctx_home/apps/cli/src/index.ts" index --root "$repo_root"
```

## Managed hooks (husky / lefthook / pre-commit framework)

lefthook (`lefthook.yml`):

```yaml
pre-commit:
  commands:
    semctx-verify:
      run: |
        repo_root="$(git rev-parse --show-toplevel)" || exit 1
        semctx_home="/abs/path/semantic-context-compiler" # trusted installation
        bun --cwd "$semctx_home" "$semctx_home/apps/cli/src/index.ts" verify diff --staged --root "$repo_root"
```

## Guarded mode (Claude Code plugin)

`verify diff --staged` above is an advisory gate: it exits on `BLOCK` but records nothing. When the
repository also runs the Claude Code plugin in guarded mode, declare `"hooks": "project-managed"` in
`.semctx/guard.json` and make `semctx verify hook pre-commit` the **last** pre-commit job, after any
formatter or restager; put `semctx verify hook pre-push` last in pre-push. Launch both jobs with
Bun's trusted `--cwd` and the absolute `--root` as above. The pre-commit job
compares the post-writer tree with the recorded proof and re-records only on drift; the pre-push job
checks every pushed commit tree and never records. Configuration, Lefthook layout and accepted
residue: [`docs/integrations/claude-code-guarded-mode.md`](../integrations/claude-code-guarded-mode.md)
(ADR 0029).

## CI

Analyse the PR directly from its Git-backed range:

```sh
repo_root="$(git rev-parse --show-toplevel)" || exit 1
semctx_home="/abs/path/semantic-context-compiler" # trusted installation
bun --cwd "$semctx_home" "$semctx_home/apps/cli/src/index.ts" verify diff --base origin/main --head HEAD --root "$repo_root"
# exit 3 → BLOCK → fail the job
```

Fetch full history first (`fetch-depth: 0`) so the merge base exists locally. Do not use
`verify diff --from-file <file>` as a gate: an external diff carries no provable source identity and
therefore remains a deliberately blocking diagnostic, even when accompanied by `--head`.

## What blocks vs warns

| verdict | exit | default rules |
| --- | --- | --- |
| `BLOCK` | 3 | invariant touched without test · **critical** contract (tagged `critical`/`security`) without test · security surface without verification |
| `WARN` | 0 (3 with `--fail-on warn`) | plain exported contract without a direct test · touched unresolved contradiction |
| `PASS` | 0 | none of the above |

Rules are configurable in `.semctx/config.json` (`blockingRules`). See
`docs/concepts/context-pack.md` and ADR 0005 for the reasoning behind the strict/advisory split.
