# Contributor dev container

A ready-to-hack environment for working on `semctx` itself. It provides Bun, Node, Git and a
minimal build toolchain, plus Python for the benchmark/smoke scripts. It does **not** install
Claude Code, require an API key, publish anything, or run the private benchmark.

## Local (VS Code)

1. Install Docker and the **Dev Containers** VS Code extension.
2. Open the repository, then **Dev Containers: Reopen in Container**.
3. The container builds from `.devcontainer/Dockerfile` and runs `postCreateCommand.sh`
   (`bun install`). When it finishes:

   ```bash
   bun run typecheck
   bun run build
   bun test
   ```

## Codespaces / other devcontainer-compatible environments

The same `.devcontainer` works in GitHub Codespaces and any Dev Container CLI host — no local
Docker needed. Create a Codespace on the branch; the post-create step installs dependencies.

## Validating the container without an IDE

With the [Dev Container CLI](https://github.com/devcontainers/cli):

```bash
devcontainer build --workspace-folder .
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . bun test
```

## Running the test suite

```bash
bun test                 # packages, apps and plugins
bun run typecheck        # strict tsc
```

## Testing the GitHub Action locally

The Action is a composite that sets up Bun and runs the CLI. Its Node adapter is unit-tested in
the suite:

```bash
bun test packages/github-action
```

To exercise the full workflow, push a branch and open a PR against a repo that references
`hoklims/semctx/packages/github-action@v0.1.0` (see `docs/integrations/github-actions.md`).

## Testing the Claude Code plugin

```bash
bun test plugins                                # guard detection + decision logic
```

Then point Claude Code at `plugins/claude-code` and use `semctx_verify_change` on a change.
Guarded mode is documented in `docs/integrations/claude-code-guarded-mode.md`.

## Limitations

- The container installs Bun via the official installer at build time (pinned to match the
  Action). If you are offline during build, provide Bun another way.
- The private change-impact benchmark corpus is **not** included and is never fetched; only the
  portability smoke test (`benchmarks/change-impact-eval/scripts/smoke_test.py`) runs without it.
- Python is present only for those scripts; the product itself needs only Bun.
