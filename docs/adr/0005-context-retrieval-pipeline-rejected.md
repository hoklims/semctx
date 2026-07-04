# ADR 0005 — Context retrieval pipeline rejected as a primary retriever

- Status: accepted
- Date: 2026-07-04
- Supersedes: the retriever framing of the product (README/overview pre-0005)

## Context

`semctx` shipped two engines over the same deterministic repository graph:

1. **`verify diff`** — analyse a change: impacted symbols, exported contracts, symbol→test
   links, annotated invariants, and a PASS/WARN/BLOCK verdict with provenance.
2. **`task → ContextPack`** — compile a task into a ranked, justified set of files to read
   (a *retriever*).

We ran a comparative evaluation of (2) against real baselines on **16 non-trivial commits**
(fix/feat/refactor) of an external 260-file TypeScript monorepo (`benchmarks/change-impact-eval`).
Tasks were the commit messages, **anonymized** (scope, paths, `*.ts`, and code-shaped symbol
names redacted). Ground truth was the files/symbols/tests actually modified. Baselines: BM25
over file **content**, `ccc` embeddings, task-blind graph centrality (repo-map). Ablations
isolated semctx's own stages.

The result was unambiguous (mean over 16 tasks, recall on modified code files):

| retriever | R@10 | MRR | selection recall |
| --- | --- | --- | --- |
| BM25 (content) | **0.97** | **0.88** | — |
| ccc (embeddings) | 0.67 | 0.68 | — |
| semctx lexical seed (A1) | 0.67 | 0.53 | — |
| semctx graph selection (A3) | 0.31 | 0.20 | — |
| **semctx full pack (A4)** | **0.31** | **0.06** | **0.34** |

The ablation ladder is **monotonically negative**: every stage semctx adds on top of its own
lexical seed (graph expansion, then structural scoring) makes retrieval *worse*. semctx's full
pipeline retrieves the modified file into the pack only 34% of the time, ranks it ~7–10th when
present, ships 44-file / ~700 KB packs, and puts the right file in a `critical` read 4.6% of
the time.

The cause is architectural, not a tuning problem. The pipeline is:

```
seed by symbol/file NAME  →  graph expansion  →  structural scoring
```

It never reads file **content**. A file whose relevance lives in its body — one whose name shares
no token with the ticket vocabulary — is invisible to a name-matcher, while BM25 ranks it first.
No amount of graph traversal or re-weighting recovers a signal the pipeline never had.

Adding semantic **markers** (`@capability`/`@invariant`) improves ranking and selection where
present (a MISS becomes rank 3; rank 10 → rank 1–2), but this only brings semctx to *parity*
with a zero-annotation BM25 baseline, at the cost of human annotation. Markers help
authority/gating/verification; they do **not** fix base retrieval.

## Decision

**Reject `task → ContextPack` as a primary task-to-code retriever.** Do not attempt to save it
with weights or heuristics — the deficiency is that it does not read content.

Graph traversal is **retained**, in a strictly different role:

- **impact analysis** — the blast radius of a *known* change (`verify diff`);
- **justification** — explaining why a surfaced node matters (edges + provenance);
- **gating** — authority, invariants, contradictions, verification sufficiency.

Graph traversal is **not** used as the primary task-to-code retriever unless it sits behind a
**content-retrieval front end** (BM25/embeddings) that supplies the base candidate set. That
front end is out of scope for the shipped product and is tracked as a separate research spike
(`ROADMAP.md` → research; branch `research/content-first-context-retrieval`) with an explicit
kill criterion.

The product is repositioned as a **repository change-impact analyzer** built around
`verify diff` (see README, `docs/architecture/overview.md`).

## Consequences

- `verify diff` and `semctx_verify_change` (MCP) become the first-class surface. They are
  marker-independent and were confirmed precise on real code.
- `context prepare` remains in the tree (it is the impact/justification engine `verify`
  reuses) but is **demoted to experimental** and is no longer advertised as a retriever. It
  must not be presented as competitive with code search.
- The comparative benchmark is committed (`benchmarks/change-impact-eval/`) as a standing,
  reproducible artifact — the project can prove what it does not yet do.
- The README's "How it differs / semantic control plane" retriever framing is withdrawn.
- Any future retriever must **beat** BM25+embeddings on the committed benchmark before it
  ships (kill criterion in `ROADMAP.md`); the null result here is the baseline it must clear.
