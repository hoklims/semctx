# Research spike — content-first context retrieval

- Status: **not started** (protocol only). No product commitment.
- Branch: `research/content-first-context-retrieval`
- Origin: ADR 0005 (the `seed-by-name → graph → scoring` retriever was rejected).

## Question

Does graph traversal + authority/invariants add net value **on top of** a real content
retriever (BM25 + embeddings), for finding the code a task touches? ADR 0005 showed the current
name-seeded pipeline is net-negative. This spike tests the *inverted* architecture — and is
allowed to conclude "no".

## Hypothesis (the inverted pipeline)

```
content retrieval (BM25 / embeddings over file bodies)   ← base candidate set
  → graph: controlled expansion                          (callers/callees/tests of candidates)
  → graph: justification                                 (why each surfaced node matters)
  → authority / invariants: gates                        (drop deprecated/contradicted, flag unproven)
  → verify-diff: validation                              (once a change exists)
```

The graph never *seeds*; it only expands, justifies, and gates a content-retrieved base.

## Pre-registered protocol (fix before any code)

- **Dataset**: `benchmarks/change-impact-eval`, extended to **≥ 30 commits** (same selection
  rules; keep the anonymization and hunk-header ground truth).
- **Baseline**: BM25 over content **+** content embeddings (fused), measured on the same tasks.
- **System under test**: the inverted pipeline above.
- **Metrics**: Recall@10 (code files), MRR, precision@5, mean files a consumer must read, plus
  the extra-value signal (see below). Report per-commit and aggregate; commit the numbers.

## Minimum bar to continue (ALL must hold)

1. Recall@10 not worse than the baseline by more than **2 points**.
2. **MRR or precision@5** improved over the baseline.
3. **Fewer files** to read than the baseline for equal recall.
4. At least one **measurable** extra value the baseline cannot provide:
   causal justification, invariant coverage, contradiction detection, or a validation plan.

## Kill criterion

If graph + authority do **not** yield a net gain over BM25 + embeddings on the 30-commit set,
**abandon the retriever as a product axis**. Record the null result next to ADR 0005 and do not
re-open without a new thesis. A second null result is a stronger asset than a third attempt.

## Non-goals

- No LLM in the deterministic path (embeddings are precomputed vectors, not generation).
- No change to the shipped `verify diff` surface from this spike.
- No merge to a shipping branch until the bar above is cleared with committed numbers.
