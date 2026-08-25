# Contributor dev container for semctx. Provides Bun, Node, Git and a minimal build toolchain,
# plus Python for the benchmark/smoke scripts. It does NOT install Claude Code, require an API
# key, publish anything, or run the private benchmark.
FROM mcr.microsoft.com/devcontainers/typescript-node:24

COPY requirements-quality.txt /tmp/semctx/requirements-quality.txt

# The image's supported Python may be newer than 3.10. CI compilation and smoke
# on Python 3.10 remain the compatibility-floor authority for the benchmark scripts.
RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && python3 -m venv /opt/semctx-quality \
    && /opt/semctx-quality/bin/pip install --no-cache-dir --requirement /tmp/semctx/requirements-quality.txt \
    && rm -rf /tmp/semctx \
    && rm -rf /var/lib/apt/lists/*

ENV PATH=/opt/semctx-quality/bin:${PATH}

# Bun (pinned to match the GitHub Action toolchain), installed for the non-root `node` user.
USER node
ENV BUN_INSTALL=/home/node/.bun
ENV PATH=/home/node/.bun/bin:${PATH}
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0"
