# Contributor dev container for semctx. Provides Bun, Node, Git and a minimal build toolchain,
# plus Python for the benchmark/smoke scripts. It does NOT install Claude Code, require an API
# key, publish anything, or run the private benchmark.
FROM mcr.microsoft.com/devcontainers/typescript-node:20

# Python is used only by benchmarks/change-impact-eval scripts (smoke test, harness).
RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Bun (pinned to match the GitHub Action toolchain), installed for the non-root `node` user.
USER node
ENV BUN_INSTALL=/home/node/.bun
ENV PATH=/home/node/.bun/bin:${PATH}
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.13"
