# Roadmap

Two lanes, kept explicitly separate. **Shipping** is a promise; **research** is a bet with an
exit condition. Nothing in Research is implied by the product until it clears its own gate.

---

## Shipping — `verify diff` as the product

The confirmed, marker-independent surface (ADR 0005). These are hardening/extension items on a
capability that already works.

- [ ] **Freshness from git history** — `tested_by` recency and churn as verdict signal.
- [ ] **Multi-line marker statements** — `@invariant`/`@contract` bodies spanning lines.
- [ ] **Diff range ergonomics** — `verify diff --base <ref>` (merge-base compare) as a first-class
      flag alongside `--staged` / `--from-file`.
- [ ] **Richer contract detection** — exported function signatures as contracts (not only
      interfaces/types), so a breaking signature change is a contract finding.
- [ ] **Incremental indexing** — re-index only changed files so the pre-commit hook can refresh
      the graph cheaply.
- [ ] **More languages** behind the analyzer interface (the graph/verify layers are
      language-agnostic; only `ts-analyzer` is TS-specific).
- [ ] **CI recipes** — ready-made GitHub Actions / GitLab CI jobs around `verify diff`.

Definition of done for a shipping item: deterministic, tested, documented, and it does not
regress the committed benchmark or the fixture.

---

## Shipping — semantic layer (Plane B)

Authored intent beside the derived graph (ADR 0009). v1 is implemented (model, `.sem` DSL, links +
stale, slice, proof-carrying change contracts, composed `change verify`, handoff/resume, CLI, MCP +
skill). Hardening/extension items on that base:

- [ ] **Multi-line `.sem` statements** — same limitation as `@markers`; single-line today.
- [ ] **Evidence corroboration from the graph** — surface that a linked test exists and covers the
      change (advisory), without ever auto-upgrading a `declared` proof to proven (stays honest).
- [ ] **Merge-aware duplicate-id resolution** — richer diagnostics when two `.sem` files declare an id.
- [ ] **Optional compiled semantic index** — a regenerable SQLite cache for large models (Git stays
      the source of truth; not required for correctness).
- [ ] **`change verify` lifecycle write-back** — opt-in `--set-status` to persist the verdict's
      lifecycle onto the contract.

Definition of done is unchanged: deterministic, tested, documented, no regression to `verify diff`.

---

## Shipping — reconstruction control plane (Plane C)

The read-only v1 coordinates Plane A+B without conflating their authority. It adds bounded L0-L6
traversal, explicit current/target architecture comparison, shadow-first migration plans and
fail-closed proof admission. It does not execute changes.

- [x] **Typed read-only vertical slice** — coordinates, coverage, architecture delta, migration DAG,
      state/risk policy, deletion denial, CLI and MCP reports.
- [ ] **Golden replay corpus** — compare planner/report output across real repository migrations.
- [ ] **Runtime proof collectors** — observe dependency traffic and shadow equivalence without
      upgrading authored claims implicitly.
- [ ] **Persisted Plane C state** — only after a versioned SQLite/config migration runner exists.
- [ ] **Worktree executor** — separate component, gated on replay and shadow evidence; never part of
      the read-only engine.

Definition of done remains deterministic, versioned, proof-honest and non-regressive.

---

## Research — content-first context retrieval (spike, not a promise)

Branch: **`research/content-first-context-retrieval`**. Protocol:
[`docs/research/content-first-context-retrieval.md`](docs/research/content-first-context-retrieval.md).

ADR 0005 rejected the current `seed-by-name → graph → scoring` retriever because it never reads
file content. The open question is whether the graph and authority layers add **anything** on
top of a real content retriever. This is a spike to answer that, with a pre-registered exit.

**Baseline to beat**: BM25 + content embeddings, on `benchmarks/change-impact-eval` (extended to
≥ 30 commits).

**Minimum bar to continue (all of):**
- do not degrade Recall@10 by more than 2 points vs the baseline;
- improve MRR **or** precision@5;
- reduce the number of files a consumer must read;
- deliver at least one *measurable* extra: causal justification, invariant coverage,
  contradiction detection, or a validation plan.

**Kill criterion**: if graph + authority do not produce a **net gain over BM25 + embeddings on
30 commits**, abandon the retriever as a product axis. Do not re-open it without a new thesis.

No `(b)` code lands on a shipping branch. The spike proves its bar on its own branch first.
