# Pre-commit / CI gate with `semctx verify diff`

`semctx verify diff` analyses a git diff and exits **non-zero on `BLOCK`** (exit code 3), so it
drops straight into a pre-commit hook or a CI job. `WARN` and `PASS` exit 0 by default; add
`--strict` to also fail on `WARN`.

## Local pre-commit hook

`semctx verify diff --staged` analyses exactly what is staged for the commit.

Create `.git/hooks/pre-commit` (make it executable: `chmod +x .git/hooks/pre-commit`):

```sh
#!/bin/sh
# Block a commit whose staged diff violates a strict-tier rule
# (invariant or critical contract changed without a covering test).
SEMCTX="bun /abs/path/semantic-context-compiler/apps/cli/src/index.ts"

# Skip if the repo was never indexed (nothing to verify against).
[ -d .semctx ] || exit 0

$SEMCTX verify diff --staged --root .
status=$?
if [ "$status" -eq 3 ]; then
  echo "semctx: BLOCK — a strict-tier rule failed. Fix or add a test, then re-commit."
  echo "        (bypass once with:  git commit --no-verify)"
  exit 1
fi
exit 0
```

Notes:

- The hook re-uses the **already-indexed** `.semctx/` graph; it does not re-index. After large
  refactors run `semctx index` to refresh the graph (or add it to the hook if your repo is
  small — indexing the demo repo is ~sub-second, a 260-file monorepo ~3–4 s).
- Use `--strict` in the hook if you want `WARN` (plain exported contract without a direct test)
  to block as well.
- `git commit --no-verify` bypasses the hook for the rare intentional exception.

## Managed hooks (husky / lefthook / pre-commit framework)

lefthook (`lefthook.yml`):

```yaml
pre-commit:
  commands:
    semctx-verify:
      run: bun /abs/path/apps/cli/src/index.ts verify diff --staged --root .
```

## CI

Analyse the PR's diff against its merge base:

```sh
git diff --relative --unified=0 origin/main...HEAD > pr.diff
semctx verify diff --from-file pr.diff --root .
# exit 3 → BLOCK → fail the job
```

`verify diff --from-file <file>` accepts any unified diff, so you can feed it a diff produced by
whatever range your CI compares.

## What blocks vs warns

| verdict | exit | default rules |
| --- | --- | --- |
| `BLOCK` | 3 | invariant touched without test · **critical** contract (tagged `critical`/`security`) without test · security surface without verification |
| `WARN` | 0 (3 with `--strict`) | plain exported contract without a direct test · touched unresolved contradiction |
| `PASS` | 0 | none of the above |

Rules are configurable in `.semctx/config.json` (`blockingRules`). See
`docs/concepts/context-pack.md` and ADR 0005 for the reasoning behind the strict/advisory split.
