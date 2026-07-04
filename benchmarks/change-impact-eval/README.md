# change-impact-eval — reproducible retrieval benchmark

A comparative evaluation of `semctx`'s `task → ContextPack` retriever against real baselines,
on **real commits** of a real repository. It is the evidence behind **ADR 0005**. Frozen
results: [`RESULTS.md`](./RESULTS.md). The raw corpus and machine-readable scores (`data/`) are
private to the repository they were computed on — regenerated locally, never committed (see below).

## Why this exists

A retriever is only as good as what it retrieves on *unseen* tasks. This harness measures that
directly: for each historical commit, can a retriever surface the files that commit actually
modified, from the (anonymized) commit message alone? It pits semctx against BM25 (content),
embeddings (`ccc`), and a task-blind repo-map, and it ablates semctx's own stages so a negative
result is attributable, not hand-waved.

The committed run is a **negative result** for the retriever. That is the point: the benchmark
is a standing gate — any future retriever must beat these baseline numbers before it ships.

## Method

1. **Select commits** (`scripts/select_commits.py` → `scripts/pick_final.py`) — deterministic,
   bias-free: non-merge, non-mechanical, ≤ 4 modified code files, ≥ 1 modified symbol,
   ≥ 0.75 of the commit's code files still present at HEAD. Balanced fix/feat/refactor.
2. **Build tasks** (`scripts/build_tasks.py`) — the ticket is the commit message,
   **anonymized**: conventional scope stripped; full paths, `*.ts`, and code-shaped symbol /
   basename tokens redacted (every redaction is logged per task in the locally-generated
   `data/tasks.json`). Plain domain
   words are kept — a real ticket says "damage is wrong", not "computeDamage line 175".
   Ground truth = files / symbols / tests actually modified (symbols from git hunk headers).
3. **Run retrievers** (`scripts/run_retrievers.py`) — per task, ranked file lists from:
   BM25 over file content (pure-python), `ccc` embeddings, task-blind PageRank centrality,
   semctx's lexical seed (A1), semctx `primaryNodes` (A3), semctx `recommendedReads` (A4).
4. **Score** (`scripts/score.py`) — recall@5/10/20 (code + all), MRR, false-neighbour rate,
   symbol/test recall, critical-read precision, pack size, compile time; the A1→A4 ablation
   ladder; per-task matrix; win/loss classification. Writes the machine-readable scores locally
   (`data/results.json`, git-ignored).
5. **Markers ablation** (`scripts/add_markers.py`) — optional Addendum A: add minimal markers
   to ground-truth files in an isolated workspace copy and re-measure (see `RESULTS.md`).

## What is committed vs what you supply

| | committed to the repo? |
| --- | --- |
| **Scripts** (`scripts/`) — the harness | ✅ yes, portable (no absolute paths) |
| **Frozen public results** (`RESULTS.md`) | ✅ yes, the standing artifact |
| **The private corpus** (`data/` — raw tasks + machine scores) | ❌ never committed — you supply your own repo |
| **Regenerated artifacts** (`output/`, `data/`, `.env`, `.semctx-bench/`) | ❌ git-ignored |

So the numbers in `RESULTS.md` are **frozen** (the corpus is private), while the scripts are
**reproducible** against any repository you point them at.

## Configuration

All machine-specific locations come from environment variables — nothing is hard-coded. Copy
`.env.example` and edit, or export directly:

| variable | required | default |
| --- | --- | --- |
| `SEMCTX_BENCH_REPO_ROOT` | **yes** (never guessed) | — |
| `SEMCTX_BENCH_WORKDIR` | no | `./.semctx-bench/workspace` |
| `SEMCTX_BENCH_OUTPUT_DIR` | no | `benchmarks/change-impact-eval/output` |

`WORKDIR` must be a semctx-indexed **copy** of the corpus (never the repo you edit). The semctx
CLI is located relative to the scripts — not configured. Missing `SEMCTX_BENCH_REPO_ROOT` exits
non-zero with a usage message. `ccc` (the embeddings baseline) is skipped gracefully if absent.

## Reproducing (with a corpus you own)

Prerequisites: Bun ≥ 1.3, Python ≥ 3.10, and a git repository to evaluate. Then:

```bash
# 1. one-time: an indexed COPY of the corpus (never index a repo you edit)
export SEMCTX_BENCH_REPO_ROOT=/path/to/your-repo
cp -r "$SEMCTX_BENCH_REPO_ROOT" ./.semctx-bench/workspace
cd ./.semctx-bench/workspace && bun ../../apps/cli/src/index.ts init && \
  bun ../../apps/cli/src/index.ts index && cd -

# 2. run the pipeline (writes only to $SEMCTX_BENCH_OUTPUT_DIR)
python scripts/select_commits.py     # -> output/candidates.json
python scripts/pick_final.py         # -> output/eval_set.json
python scripts/build_tasks.py        # -> output/tasks.json + output/tasks/*.md
python scripts/run_retrievers.py     # -> output/runs.json   (spawns semctx per task)
python scripts/score.py              # -> output/results.json + tables
```

Verify the harness is portable and correctly configured without running an evaluation:

```bash
python scripts/smoke_test.py         # checks: no absolute paths, clean failure, path wiring
```

## Honesty notes

- **Anonymization is imperfect**: residual domain terms in the commit body may remain. They
  inflate the absolute recall of *every* lexical method uniformly, so they do not tilt the
  comparison toward or away from semctx.
- **Ground truth is "what the commit changed"**, a proxy for "what you must read". A retriever
  could surface a genuinely necessary file the commit did not touch; that counts against it
  here. This makes the benchmark strict, which is the intent.
- **Read-only against the corpus**: the harness only `git -C <repo>` queries and reads a
  workspace *copy*. It never writes to the corpus repository.
