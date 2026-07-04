#!/usr/bin/env python3
"""Shared configuration for the change-impact benchmark.

No machine-specific path is committed; every location comes from an environment variable
(with a safe default where one is possible). The private corpus is never guessed.

  SEMCTX_BENCH_REPO_ROOT   (required)  git repo of the private corpus to mine commits from.
                                       Read-only; only `git -C` queries and `ccc` search run here.
  SEMCTX_BENCH_WORKDIR     (optional)  a semctx-INDEXED COPY of the corpus (never the repo you
                                       edit). default: <cwd>/.semctx-bench/workspace
  SEMCTX_BENCH_OUTPUT_DIR  (optional)  where intermediate + result artifacts are written.
                                       default: <this benchmark>/output

The semctx CLI is resolved relative to this file (…/apps/cli/src/index.ts) — not an env var.
"""
import os
import sys

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
BENCH_DIR = os.path.dirname(SCRIPTS_DIR)                       # benchmarks/change-impact-eval
REPO_TOP = os.path.dirname(os.path.dirname(BENCH_DIR))         # repository root
CLI = os.path.join(REPO_TOP, "apps", "cli", "src", "index.ts")


def _env(name, default):
    value = os.environ.get(name)
    return value if value else default


OUTPUT_DIR = os.path.abspath(_env("SEMCTX_BENCH_OUTPUT_DIR", os.path.join(BENCH_DIR, "output")))
WORKDIR = os.path.abspath(_env("SEMCTX_BENCH_WORKDIR", os.path.join(os.getcwd(), ".semctx-bench", "workspace")))
DB = os.path.join(WORKDIR, ".semctx", "semctx.db")

_EXAMPLE = (
    "Example (a machine that has the private corpus):\n"
    "  SEMCTX_BENCH_REPO_ROOT=/path/to/private-corpus \\\n"
    "  SEMCTX_BENCH_WORKDIR=/path/to/indexed-workspace-copy \\\n"
    "  python scripts/run_retrievers.py\n\n"
    "WORKDIR must be a semctx-indexed COPY of the corpus (semctx init && semctx index).\n"
    "Never point it at a repo you edit. See benchmarks/change-impact-eval/README.md.\n"
)


def repo_root():
    """The private corpus repo. Never defaulted; exits non-zero with guidance when unset."""
    root = os.environ.get("SEMCTX_BENCH_REPO_ROOT")
    if not root:
        sys.stderr.write("ERROR: SEMCTX_BENCH_REPO_ROOT is not set (the private corpus is required).\n\n" + _EXAMPLE)
        sys.exit(2)
    if not os.path.isdir(root):
        sys.stderr.write("ERROR: SEMCTX_BENCH_REPO_ROOT does not exist: " + root + "\n\n" + _EXAMPLE)
        sys.exit(2)
    return root


def require_workdir_indexed():
    """The indexed workspace copy. Exits non-zero with a create-it recipe when missing."""
    if not os.path.isfile(DB):
        sys.stderr.write(
            "ERROR: no indexed semctx workspace at SEMCTX_BENCH_WORKDIR=" + WORKDIR + "\n"
            "       expected a database at " + DB + "\n"
            "       create it once (copy the corpus, then index the copy):\n"
            '         cp -r "$SEMCTX_BENCH_REPO_ROOT" "' + WORKDIR + '" && \\\n'
            '         (cd "' + WORKDIR + '" && bun ' + CLI + " init && bun " + CLI + " index)\n\n" + _EXAMPLE
        )
        sys.exit(2)
    return WORKDIR


def out(*parts):
    """A path inside OUTPUT_DIR (created on demand)."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    return os.path.join(OUTPUT_DIR, *parts)
