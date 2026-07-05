# consumer-typescript-repo (example)

A minimal repository that adopts `semctx`. It is intentionally tiny: one source file with a
`@capability`/`@invariant` marker so `verify diff` has something to gate on.

## Adopt semctx in under a minute

```bash
# from this directory. `semctx` here is `bunx semctx` (or the repo's
# `bun apps/cli/src/index.ts`) until the CLI is published to a registry.
bunx semctx init --preset github-claude --dry-run   # preview what would be created
bunx semctx init --preset github-claude             # write config, workflow, .claude note
bunx semctx index                                   # build the deterministic graph
# --base needs the base branch fetched locally (git fetch origin main; CI: actions/checkout fetch-depth: 0)
bunx semctx verify diff --base origin/main          # analyse a range → PASS / WARN / BLOCK
```

The preset never overwrites an existing file (use `--force` to replace), never adds a blocking
hook by default, and always prints exactly what it created or skipped.

Add `--with-devcontainer` to also generate `.devcontainer/devcontainer.json`.
