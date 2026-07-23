# Roadmap

This roadmap is ordered by dependency. A later milestone must not be pulled forward because its
interface looks useful: each milestone establishes the trust boundary required by the next one.

**Shipping** is a product promise. **Research** is a bet with an explicit exit condition. Nothing in
Research is implied by the product until it clears its own gate.

Baseline audited on `main` at `1bedd1b` (2026-07-23).

---

## Shipped baseline

- [x] **Plane A — deterministic repository facts and `verify diff`** — impact, contracts,
      invariants, tests, co-change advice and versioned `PASS` / `WARN` / `BLOCK` reports.
- [x] **Diff range ergonomics** — working tree, staged, file-provided and merge-base
      `--base <ref>` / `--head <ref>` comparisons.
- [x] **CI integration** — committed GitHub Action, preset and copyable recipe.
- [x] **Plane B — authored semantic intent** — Git-versioned `.sem` declarations, explicit links,
      semantic slices, proof-carrying change contracts, composed verification and handoff/resume.
- [x] **Plane C — read-only control kernel** — L0-L6 coordinate model, bounded traversal library,
      architecture comparison, migration DAG and fail-closed proof/deletion policy.
- [x] **Codex / Claude Code parity** — shared `semctx-control` workflow semantics and bundled MCP
      runtime, with host-specific installation and guards.

The Plane C milestone above is a kernel, not yet an end-to-end top-down compiler. L0 has no mapped
coordinates, changes remain cross-cutting control artifacts, `lift` / `lower` do not yet use a
dedicated refinement relation policy, and the public transports expose only trace and plan. The
ordered programme below closes that gap before any executor is considered.

---

## Market leadership thesis and evidence policy

Tracking epic: [#24 — prove Semctx as the market-leading semantic change-control
plane](https://github.com/hoklims/semctx/issues/24).

Semctx is competing to become the strongest **proof-carrying semantic change-control plane for
coding agents**. It is not competing to be a generic code-search replacement. Its defensible wedge
is the combination of typed intent-to-patch refinement, explicit authority boundaries,
source-state-bound evidence, fail-closed freshness and deterministic agent governance.

The competitive bar is split by capability so that one strong subsystem cannot hide a weak one:

| Capability | Bar to clear | Roadmap gate |
| --- | --- | --- |
| Repository orientation | Integrate or sit behind strong content retrieval; construct and freeze the fused BM25 + content embeddings baseline in #30, then never weaken it to make the semantic graph look better. | Research [#30](https://github.com/hoklims/semctx/issues/30) |
| Vertical semantic control | Preserve goal, invariants and permitted scope from L6 to L0 and back with typed, evidence-bearing relations. | P1 [#26](https://github.com/hoklims/semctx/issues/26), P2 [#27](https://github.com/hoklims/semctx/issues/27) |
| Proof and freshness integrity | Refuse stale, unsealed, contradictory or insufficient evidence without converting advisory inference into authority. | P0 [#25](https://github.com/hoklims/semctx/issues/25), P4 [#29](https://github.com/hoklims/semctx/issues/29) |
| Agent workflow | Produce the same bounded verdict and resumable semantic state across supported hosts, with measured false-block and operator-overhead budgets. | P3 [#28](https://github.com/hoklims/semctx/issues/28), P4 [#29](https://github.com/hoklims/semctx/issues/29) |
| Safe transformation | Execute only pre-authorized, reconciled steps in isolation with independently verifiable rollback and proof collection. | P5, only after P4 clears |

Claims unlock in order:

1. **Differentiated architecture** — documented authority boundaries and deterministic contracts.
2. **Verified vertical product** — a reproducible L6 → L0 → L6 change on Semctx itself.
3. **Competitive advantage** — replay beats the skill-only baseline on intent retention and scope
   precision without weakening proof honesty.
4. **State-of-the-art governed semantic change** — a pre-registered head-to-head suite wins on
   the primary governance metrics and stays inside every safety/cost budget.
5. **Market leadership** — technical evidence is joined by repeatable installation, reliability,
   adoption and operator-value results on independent projects.

No unqualified state-of-the-art or market leadership claim is allowed from architecture alone,
private demos, stars, or a single dogfood repository. External products and models move too quickly
for a static feature matrix to remain authoritative; P4 must record the exact versions, adapters,
prompts, budgets and raw outputs used in each comparison.

---

## Ordered shipping programme — semantic refinement control

### P0 — Trustworthy inputs and freshness ([#25](https://github.com/hoklims/semctx/issues/25))

No architecture-to-patch conclusion is authoritative until every input belongs to the same known
repository state.

- [x] **Control freshness seal** — bind repository root, `HEAD`, index commit, repository-graph
      hash, semantic-model hash, working-diff hash, schema version and tool version.
- [x] **Explicit freshness verdict** — add a read-only `semctx status` / MCP preflight returning
      `FRESH`, `DIRTY_KNOWN`, `STALE` or `UNSEALED`; high-risk control operations fail closed on
      stale or unsealed inputs.
- [x] **Cross-plane link consistency** — Plane B link checks and Plane C coordinate construction
      must share the same file/node resolver and report the same dangling or stale references.
- [ ] **Honest semantic scaffold** — generate comments/placeholders rather than active
      `goal.example.*` / `invariant.example.*` truths; examples must never enter a project model
      unless explicitly activated.
- [ ] **Lifecycle hygiene** — detect obsolete active changes, stale evidence baselines and active
      working pointers that no longer match the selected contract.
- [ ] **Derived-provider seal** — optional graphs or candidate providers may orient discovery, but
      Plane C accepts their facts only with an exact source-state seal and provenance.

**Gate:** every acceptance criterion in [#25](https://github.com/hoklims/semctx/issues/25) is green.
On Semctx itself, initialization creates no active example truths; stale lifecycle/evidence/pointer
states are diagnosed; unsealed or mismatched provider facts remain non-authoritative; CLI and MCP
return the same canonical negative-path reason codes; a stale index is rejected before traversal;
and rebuilding the index produces a commit-bound seal.

### P1 — Typed vertical refinement (L6 to L0) ([#26](https://github.com/hoklims/semctx/issues/26))

Levels must represent abstraction, while relations determine whether a traversal is a refinement,
an impact path, a rationale or a proof path.

- [ ] **Correct the level ontology** — L6 strategy/constraints, L5 product intent, L4
      invariants/policies, L3 capabilities, L2 components/boundaries, L1 symbols/tests/schemas and
      L0 syntax/hunks/AST transformations. Repository/system scope is not itself a strategy.
- [ ] **Separate kind from level** — decisions and policies carry an explicit `appliesAtLevel`
      rather than being forced into one universal level by source kind.
- [ ] **First-class refinement edges** — add typed, evidence-bearing relations such as `realizes`,
      `implements`, `decomposes_to`, `constrained_by` and `proved_by`, with epistemic status.
- [ ] **Traversal policies by question** — `lift` / `lower` use only refinement edges; `impact`
      uses dependency/data/contract edges; `explainWhy` uses rationale edges; proof queries use
      test/trace/attestation edges. Imports must never become architectural justification merely
      because they cross levels.
- [ ] **L0 patch projection** — represent hunks or AST edit operations as observed L0 coordinates.
      A `ChangeSet` remains cross-level and references those coordinates; it is not collapsed into
      L0.
- [ ] **Refinement coverage report** — expose missing levels, unjustified skips, ambiguous edges,
      unsupported artifacts, stale references and load-bearing LLM-only relations.
- [ ] **Public control transports** — expose bounded `impact`, `explainWhy`, architecture compare
      and authorization reports through the same versioned CLI/MCP contracts as trace and plan.
- [ ] **Actionable empty-trace diagnostics** — distinguish unknown coordinate, missing mapping,
      disconnected refinement, stale index and traversal-budget exhaustion.

**Gate:** using a fixed, sealed observed-patch fixture (not yet a TaskEnvelope),
`goal.semctx.reconstructive-control` lowers through an authored capability and structural boundary
to the relevant symbols, tests and L0 coordinates; lifting those coordinates returns to the same
goal and invariants without following unrelated import paths. The full planned-change/actual-diff
round trip remains P2.

### P2 — Task envelope, target authoring and diff reconciliation ([#27](https://github.com/hoklims/semctx/issues/27))

The agent must manipulate a semantic change object before producing a patch, while normal code
search remains responsible for discovering the initial implementation anchors.

- [ ] **Semantic TaskEnvelope** — join the existing `TaskFrame`, `ChangeContract` and coordinate
      graph with required abstraction altitude, explicit anchors, parent intent, preserved
      invariants, non-goals, allowed scope, expected behaviour delta, proof obligations and seals.
- [ ] **Separate framing from scope binding** — raw text may classify mode/risk/required altitude,
      but repository files and symbols become authoritative only after explicit discovery and
      binding.
- [ ] **Versioned target architecture artifacts** — author proposed targets in Git, retain
      `hypothetical` provenance until reviewed, and let plans consume a stable `targetId` instead
      of requiring callers to construct raw snapshot JSON.
- [ ] **General refinement planner** — support local patch, refactor, feature, redesign and
      migration profiles. The current shadow/cutover/deletion DAG remains the migration
      specialization, not the default for every change.
- [ ] **Semantic ChangeSet** — record the planned cross-level delta, ordered refinement steps,
      permitted repository scope, rollback and acceptance evidence.
- [ ] **`reconcile diff`** — lift the actual working diff, compare it with the envelope and target,
      report unplanned coordinates, missing planned edits, invariant drift and unexpected
      abstraction-level changes.
- [ ] **Round-trip properties** — verify relevant forms of `x ∈ lower(lift(x))` and ensure that
      invariants discovered while lifting are included in the patch proof obligations.

**Gate:** a non-trivial change cannot be called complete when its actual diff escapes the permitted
scope, fails to realize the target or lifts to an undeclared goal/invariant impact.

### P3 — Agent workflow and host governance ([#28](https://github.com/hoklims/semctx/issues/28))

Integrate only after the read-only machine contracts above are stable. Start advisory, measure false
positives, then enforce by risk/altitude.

- [ ] **Shared vertical workflow contract** — keep one canonical policy/schema for Codex and
      Claude Code; generate or test host-specific adapters rather than duplicating semantic rules.
- [ ] **Agent primitives** — provide focused tools for `frame_task`, `bind_scope`, `refine`,
      `target_propose`, `reconcile_diff` and `status` instead of making the model assemble raw
      control-plane payloads.
- [ ] **Required-altitude policy** — L0-L1 may remain autonomous, L2 is constrained, L3 requires a
      reviewed plan/rollback, and L4-L6 require explicit human authority appropriate to the change.
- [ ] **Codex lifecycle integration** — route eligible prompts, preflight before the first L2+
      write, accumulate touched coordinates after edits, capture a sealed pre-compaction handoff,
      resume it, and reconcile/verify before Stop.
- [ ] **Claude Code lifecycle integration** — preserve the same verdicts and envelope semantics
      using the host surfaces actually available; keep the existing commit/push diff-hash guard as
      a Plane A gate rather than presenting it as a Plane C executor.
- [ ] **Handoff v2** — carry TaskEnvelope id, current abstraction level, completed refinement step,
      seals, touched coordinates, diff hash, proofs obtained and next valid transition.
- [ ] **Shadow enforcement rollout** — emit advisories and telemetry first; enable blocking only
      after replay demonstrates an acceptable false-block rate.

**Gate:** Codex and Claude Code produce the same machine verdict and semantic handoff for the same
sealed task/diff, while repositories without Semctx retain a clean no-op path.

### P4 — Competitive evidence, replay and evaluation ([#29](https://github.com/hoklims/semctx/issues/29))

- [ ] **Pre-registered benchmark contract** — freeze dataset selection, train/dev/holdout splits,
      environments, models/tools, prompts, budgets, primary metrics, safety constraints and kill
      thresholds before scoring.
- [ ] **Comparator and statistical protocol** — set a dated comparator-selection cutoff; define
      independent ground-truth adjudication, contamination checks, repeated runs for stochastic
      systems, effect-size/non-inferiority margins, uncertainty intervals and a multiplicity rule.
      Thirty tasks are the minimum harness/corpus gate, not automatically sufficient for SOTA;
      claim power must be justified before evaluation.
- [ ] **Reproducible baseline matrix** — compare skill-only, repository-graph-assisted and Semctx
      ablations; add external systems only when their license, interface and captured version permit
      an honest rerun. Content retrieval remains the orientation baseline, not a weak straw man.
- [ ] **Golden vertical replay corpus** — at least 30 anonymized real tasks across Semctx and
      independent projects, with known goal ↔ invariant ↔ capability ↔ component ↔ symbol/test ↔
      patch chains and accepted outcomes.
- [ ] **Top-down evaluation metrics** — pre-register abstraction recall, scope precision,
      refinement continuity, round-trip consistency, invariant/proof recall, stale-refusal rate,
      false-block rate, functional outcome, latency and token cost; report per-task results,
      aggregate scores and uncertainty rather than only means.
- [ ] **Adversarial governance suite** — stale seals, forged or insufficient evidence,
      contradictory intent, scope escape, unsupported relations, replay tampering and degraded
      providers must fail with the correct bounded reason rather than a generic error.
- [ ] **Planner replay** — compare versioned architecture/plan/reconciliation reports across real
      migrations and ordinary changes; identical sealed inputs must produce byte-stable machine
      reports.
- [ ] **Runtime proof collectors** — observe dependency traffic, behaviour replay and shadow
      equivalence without silently upgrading authored claims.
- [ ] **Proof promotion rules** — an inferred relation becomes load-bearing only through explicit
      static, test, runtime or human evidence accepted by policy.
- [ ] **Transparent evidence release** — commit the runner, schemas, environment manifest,
      per-task outputs, aggregate report, failed cases and null results. Private source may remain
      private, but ground-truth derivation and anonymization must be auditable.
- [ ] **Independent pilot proof** — measure installation success, time-to-first-value, retained
      usage, accepted advice, overrides, false blocks and operator effort on at least three
      non-Semctx repositories before using a market leadership claim; pre-register numeric budgets
      and a minimum observation window before the first pilot starts.

**Competitive gate:** on a held-out set, the vertical workflow beats the skill-only baseline on
intent retention and scope precision, does not regress functional outcome, preserves perfect
stale/insufficient-proof refusal on the adversarial set, and stays inside the pre-registered
false-block, latency and token budgets. A state-of-the-art claim additionally requires the strongest
reproducible comparison available at evaluation time, not merely Semctx's internal ablations.

**Market gate:** technical superiority is necessary but insufficient. Installation, reliability,
upgrade safety and operator-value evidence from independent pilots must also clear their
pre-registered budgets.

### P5 — Persisted control state and executor (last)

No executor issue is opened yet. Create it only after the explicit P4 competitive gate is
independently verified and [#29](https://github.com/hoklims/semctx/issues/29) records the complete
supporting evidence; issue closure alone is insufficient. This prevents execution work from
outrunning the authority model.

- [ ] **Versioned migration runner** for SQLite/config state before any persisted Plane C state.
- [ ] **Persisted execution ledger** keyed by TaskEnvelope, plan, step, commit and proof seal; the
      authored Plane B model and regenerable Plane A index remain separate authorities.
- [ ] **Isolated worktree executor** as a separate component consuming already-authorized steps.
- [ ] **Structured transformations and rollback** — prefer bounded AST/data migrations and tested
      rollback points over unrestricted writes.
- [ ] **Cutover/deletion authorization** — retain the current fail-closed proof matrix; no executor
      may bypass runtime-zero, invariant, behaviour-delta, migration and rollback obligations.

**Gate:** a replayed migration can introduce, shadow, reconcile, cut over, observe and remove a
legacy path in an isolated worktree, with every state transition and rollback independently
verifiable. Until then, the executor remains out of the product.

---

## Parallel hardening backlog

These improve an existing plane but do not replace the ordered programme above. Pull an item forward
only when a milestone depends on it.

### Plane A — `verify diff`

- [ ] **Freshness from Git history** — use `tested_by` recency and churn as an advisory verdict
      signal. This is distinct from the P0 commit/index seal.
- [ ] **Multi-line marker statements** — `@invariant` / `@contract` bodies spanning lines.
- [ ] **Richer contract detection** — exported function signatures and breaking signature deltas,
      not only marker/interface/type contracts.
- [ ] **Incremental indexing** — re-index changed files with deterministic invalidation.
- [ ] **More languages** behind the analyzer interface.

### Plane B — authored intent

- [ ] **Multi-line `.sem` statements** while retaining deterministic formatting.
- [ ] **Evidence corroboration advisory** — show that a linked test exists and covers the change
      without auto-upgrading authored proof status.
- [ ] **Merge-aware duplicate diagnostics** — report both files/lines and resolution guidance.
- [ ] **Optional compiled semantic index** for large models; Git remains authoritative.
- [ ] **Opt-in lifecycle write-back** derived from composed verification, never from a caller claim.

Definition of done for every shipping item: deterministic, versioned, tested, documented, compatible
with the fixture and committed benchmarks, and no more optimistic than its evidence.

---

## Research — content-first context retrieval (spike, not a promise) ([#30](https://github.com/hoklims/semctx/issues/30))

Branch: **`research/content-first-context-retrieval`**. Protocol:
[`docs/research/content-first-context-retrieval.md`](docs/research/content-first-context-retrieval.md).

ADR 0005 rejected the current `seed-by-name → graph → scoring` retriever because it never reads
file content. The open question is whether the graph and authority layers add **anything** on top of
a real content retriever. This remains separate from the semantic-refinement programme.

**Baseline to construct, freeze and beat:** fused BM25 + content embeddings on
`benchmarks/change-impact-eval`, extended to at least 30 commits. The committed frozen result
currently contains separate BM25 and embedding runs, not this fused baseline.

**Minimum bar to continue (all):**

- do not degrade Recall@10 by more than 2 points versus baseline;
- improve MRR or precision@5;
- reduce the number of files a consumer must read;
- deliver at least one measurable extra: causal justification, invariant coverage, contradiction
  detection or a validation plan.

**Kill criterion:** if graph + authority do not produce a net gain over BM25 + embeddings on 30
commits, abandon the retriever as a product axis. Do not reopen it without a new thesis.

No research implementation lands on a shipping branch before the spike clears its own gate.
