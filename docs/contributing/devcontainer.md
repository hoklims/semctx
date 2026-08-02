# Contributor dev container

The contributor container provides Bun, Node, Git, a minimal build toolchain, Python, and the
quality tools pinned in `requirements-quality.txt` (currently Ruff and zizmor). It does not
install Claude Code, require an API key, publish anything, or run the private benchmark.

## Local use

1. Install Docker and the **Dev Containers** VS Code extension.
2. Open the repository, then run **Dev Containers: Reopen in Container**.
3. The container builds from `.devcontainer/Dockerfile` and runs `postCreateCommand.sh`.

The post-create script verifies Bun and every required pinned quality tool, then installs project
dependencies. It does not install or upgrade the pinned quality tools. When setup finishes, use
targeted commands while iterating and run the sole pre-PR gate before opening or updating a PR:

```bash
bun run quality
bun test packages/app-services
bun run verify:pr
```

The same `.devcontainer` works in GitHub Codespaces and other Dev Container CLI hosts.

## Validate without an IDE

With the [Dev Container CLI](https://github.com/devcontainers/cli):

```bash
devcontainer build --workspace-folder .
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . bun run verify:pr
```

## Focused checks

Use focused checks for iteration; they do not replace `bun run verify:pr`:

```bash
bun run quality                    # TypeScript, ESLint, Ruff, and workflow analysis
bun test packages/github-action    # GitHub Action adapter
bun test plugins                   # plugin behavior and parity
bun run plugin:build
bun run plugin:check
```

See the [public-contract contributor guide](public-contracts.md) before changing CLI/MCP
contracts, agent workflow, plugin packaging, CI, or release behavior.

## Limitations

- The image supplies Bun and the pinned quality tools. A version mismatch with
  `requirements-quality.txt` fails post-create rather than modifying the environment.
- The base image's Python is used locally. CI remains the compatibility-floor authority for
  maintained Python scripts.
- The private change-impact benchmark corpus is not included or fetched. Only repository-owned
  public fixtures and portability tests are available.
- Python supports repository quality and benchmark scripts; the semctx product itself needs Bun.
