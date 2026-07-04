# Change-impact / retrieval evaluation — results (frozen)

> Frozen run, 2026-07-04. The raw corpus and machine-readable scores (`data/`) are private to the
> repository they were computed on and are not committed; methodology and how to re-run against
> your own repo: `README.md`. This benchmark is a **negative result**: it is the evidence behind
> ADR 0005 (the `task → ContextPack` retriever is rejected). It is committed so the project
> can prove what it does *not* yet do.

## Setup

- **Corpus**: an external 260-file TypeScript monorepo (private), indexed by `semctx`
  (2282 nodes / 6403 edges / 483 claims, 3.6 s). **Zero semantic markers** — the realistic
  un-annotated regime.
- **Tasks**: 16 non-trivial commits (6 fix, 6 feat, 1 refactor, 3 other), selected
  deterministically (`select_commits.py` → `pick_final.py`; coverage ≥ 0.75, ≤ 4 code files,
  ≥ 1 modified symbol). No cherry-picking.
- **Ticket = anonymized commit message**: conventional scope stripped, paths / `*.ts` /
  code-shaped symbol & basename tokens redacted (logged per task in the local `data/tasks.json`).
  Residual domain vocabulary remains — it inflates *all* lexical methods uniformly, so it does
  not favour semctx.
- **Ground truth**: files / symbols / tests actually modified (symbols from git hunk headers).
- **Baselines**: BM25 over file **content**; `ccc` embeddings; task-blind graph centrality
  (repo-map). **Ablations** isolate semctx's own stages.

## Retrieval — mean over 16 tasks (recall on modified **code** files)

| retriever | R@5 | R@10 | R@20 | R@10 (all) | MRR | FNR@10 |
| --- | --- | --- | --- | --- | --- | --- |
| **bm25** (lexical, content) | **0.84** | **0.97** | **1.00** | **0.96** | **0.88** | 0.48 |
| ccc (embeddings) | 0.67 | 0.67 | 0.67 | 0.66 | 0.68 | **0.25** |
| centrality (repo-map, task-blind) | 0.14 | 0.52 | 0.55 | 0.29 | 0.17 | 0.79 |
| lexical_name (semctx seed) | 0.59 | 0.67 | 0.88 | 0.49 | 0.53 | 0.73 |
| semctx_primary (graph selection) | 0.31 | 0.31 | 0.42 | 0.19 | 0.20 | 0.87 |
| **semctx_full** (final pack) | 0.03 | 0.31 | 0.34 | 0.19 | 0.06 | 0.90 |

`R@k` = fraction of modified code files in the top-k. `MRR` = 1 / rank of first hit.
`FNR@10` = fraction of the top-10 that is neither ground truth nor structurally adjacent to it.

## Ablation ladder — monotonically negative for semctx

| stage | R@10 | MRR |
| --- | --- | --- |
| A1 lexical seed only | 0.67 | 0.53 |
| A2 graph only (task-blind) | 0.52 | 0.17 |
| A3 lexical + graph | 0.31 | 0.20 |
| A4 + structural scoring (= semctx) | 0.31 | **0.06** |

Every stage semctx adds on top of its own lexical seed makes retrieval worse. The seed alone
(0.67) beats the full pipeline (0.31).

## semctx-specific

| metric | value |
| --- | --- |
| selection recall (gt file present anywhere in pack, rank-agnostic) | **0.34** |
| symbol recall (gt hunk-symbols in `primaryNodes`) | 0.20 |
| test recall (modified tests in `relevantTests`) | 0.48 |
| critical-read precision (`critical` reads that are ground truth) | 0.05 |
| mean files proposed (`recommendedReads`) | 44.4 |
| mean pack size | 731 KB |
| mean compile time | 0.34 s |

Two-thirds of the time the modified file is **not selected at all** — this is not merely a
ranking problem.

## Per-task recall@10 (code) — bm25 / ccc / semctx_full

```
t00  1.0 0.0 0.0  fix       t08  1.0 0.25 0.0 feat   LOSS
t01  1.0 0.5 0.5  feat      t09  1.0 0.5  0.0 fix    LOSS
t02  1.0 1.0 1.0  other     t10  1.0 0.5  0.5 feat
t03  1.0 1.0 1.0  fix       t11  0.5 0.5  0.5 fix
t04  1.0 1.0 1.0  fix       t12  1.0 1.0  0.0 feat   LOSS
t05  1.0 0.5 0.0  refactor  t13  1.0 1.0  0.0 fix    LOSS
t06  1.0 1.0 0.0  channel   t14  1.0 0.5  0.5 feat
t07  1.0 0.5 0.0  channel   t15  1.0 1.0  0.0 feat   LOSS
```

semctx beats both baselines on **0/16** tasks; loses outright on 8/16. It ties (all 1.0) only
where the file/symbol **name** aligns with the ticket vocabulary.

## Case studies

The per-task qualitative breakdown (which named the private corpus's files and symbols) is
omitted here for corpus privacy. The mechanism it documented is captured by the numbers above:
semctx ties BM25 only when a ground-truth file or symbol **name** lexically aligns with the ticket
vocabulary, and misses when the relevance lives in file **content** — because the retriever seeds
from names, not content, and the graph then expands into alphabetically-first neighbours rather
than the modified file.

## Addendum A — effect of adding markers (ergonomic ceiling, not comparative gain)

~4 markers (`@capability`/`@invariant`, slugs aligned to ticket vocabulary) added to 3 ground
truth files in the isolated workspace copy, re-indexed, same tasks:

| task | before | after |
| --- | --- | --- |
| t03 | rank 10, pack 33 | **rank 2**, pack 13, critical |
| t04 | rank 10, pack 61 | **rank 1**, pack 23, critical |
| t13 | **MISS**, pack 59 | **rank 3**, pack 23, critical |

`verify diff`: an `@invariant` on an **untested** exported symbol turns a silent `PASS` into a
justified `BLOCK` (`invariant_touched_without_test`).

**Caveat**: the marker slugs were hand-authored to match the ticket vocabulary — circular by
construction. This shows markers make the layer work *as designed* and reach **parity** with a
zero-annotation BM25 (rank 1–3) at the cost of human annotation; it is **not** evidence that
graph+authority beats content retrieval. Markers help gating/verification, not base recall.

## Conclusion

- **verify-diff**: confirmed valuable, precise, marker-independent — shipped surface.
- **task → ContextPack**: not shippable as a retriever (beaten by plain BM25 on every metric).
- **graph + scoring**: net-negative on un-annotated code.
- **markers**: useful for gates/authority/verification; they do not fix base retrieval.
- **decision (ADR 0005)**: reject the retriever; retain graph traversal for impact and
  justification only. Any future retriever must beat BM25+embeddings on this benchmark before
  it ships.
