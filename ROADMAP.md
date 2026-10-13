# Semctx roadmap

> Revised 2026-10-12. Source baseline: **v0.4.5** (candidate). Publication and host delivery are gated separately.
> Future versions are outcome targets, not available features or promised dates.

## Understand the risk of a change before running the checks

Semctx helps a maintainer or coding agent answer three questions: **what could this diff affect,
why does it matter, and what should I verify next?** It connects repository facts to declared
contracts and invariants, explains findings, and keeps missing evidence visible.

Our first audience is TypeScript maintainers using a CLI, Codex, or Claude Code. They should get
useful advice without adopting an ontology, writing semantic declarations, or installing another
service first. Authored contracts, replay, and policy controls form a progressive path beyond the
first useful report.

The adoption thesis: make one real risk understandable, make the next action easy, and make
repeated use cheaper than rediscovering the same context. We will measure that thesis.

## Current release line

[v0.3.3](https://github.com/hoklims/semctx/releases/tag/v0.3.3) provides local change-impact
analysis, explainable PASS/WARN/BLOCK reports, source-bound index health, authored intent and
contracts, read-only control/replay surfaces, and Codex/Claude integrations. Version 0.3.0 added
explicit index recovery, source-backed continuation reports, process lifecycle tests and
opt-in configuration migration with exact restoration; version 0.3.1 carries the guarded content
proof into project-managed Git hook chains (Lefthook, husky) and makes hook bypass
non-authorizing in guarded mode; version 0.3.3 adds `semctx impact diff`, a versioned
`ChangeImpact` report that states what a change can affect and where the modeled reach stops,
without deciding any proof. The release briefs for [0.3.0](docs/releases/v0.3.0.md),
[0.3.1](docs/releases/v0.3.1.md) and [0.3.3](docs/releases/v0.3.3.md) state the delivered scope. Incremental indexing, full resource
budgets, Mac/lobby performance and independent human outcomes remain open; publication does not
complete the whole 0.3 roadmap.

The current npm release and `latest` channel are **0.4.2**, with registry `gitHead`
`745bac21925dd96c936e99ad62dd6b6b266525b0` observed on 2026-10-12. Its patch fixes Codex
installation metadata, native cache selection and Windows launchers. This registry observation
establishes npm publication, not that a host installed it or an active session loaded it.
The source candidate is **0.4.5**; it is not public until its own release workflow, registry
read-back and fresh-host delivery complete.

TypeScript is the semantic baseline. Python support is bounded through Python 3.12; Markdown and
SQL provide structural facts, not equivalent semantic analysis. Suggested tests are inferred from
static links, not measured coverage. PASS does not prove that a program works. Installation evidence
does not prove that an already-open agent session loaded the update. See the
[current capability matrix](README.md#current-delivery-status).

The old task-to-context retriever failed its comparison. Its
[negative result](benchmarks/change-impact-eval/RESULTS.md) remains published. That result neither
refutes the current impact analyzer nor demonstrates its practical benefit.

## Version progression

| Target | User outcome | Evidence required |
| --- | --- | --- |
| **0.4 — Refuse rather than pass** | Malformed, unreadable, unsafe, stale or unsealed inputs cannot become success. | Focused negative cases, exact-source release gates, independent proof review and public artifact replay. |
| **0.5 — Know what to verify** | Turn an observed change into bounded, explainable verification obligations without granting execution authority. | Calibrated recommendations, explicit unknowns and comparison with simpler baselines. |
| **0.6 — Incremental indexes under budget** | Reuse indexes across supported edits and worktrees with declared CPU, memory and freshness budgets. | Incremental/full equivalence, drift and crash recovery, cancellation, generation binding and measured limits. |
| **0.7 — Sources and provenance** | Combine useful sources while preserving identity, revision, coverage, confidence and authority boundaries. | Provider conformance, failure cases, source seals and independent replay across supported hosts. |
| **1.0 — A dependable supported contract** | Adopt the proven workflow with predictable compatibility, upgrades and support boundaries. | Support policy, migration/rollback tests, repeated independent use and evidence for every advertised capability. |

Patch releases correct shipped behavior. Minor releases add a coherent capability and disclose
pre-1.0 breaking changes. Future work cannot be assigned retroactively to a published version.
Product versions, machine schemas and index generations remain distinct. Closed-issue percentages
are not release-readiness scores.

## 0.4: refuse rather than pass

The 0.4 line makes boundary failures explicit. Corrupt workspace or semantic inputs, unusable
Action reports, invalid blocking-hook input, unsealed control queries, analyzer I/O failures,
provider failures and invalid reconciliation artifacts must not be projected as successful work.
Historical capsules and their schemas remain unchanged; recovery admissibility stays separate.

## 0.5: know what to verify

Connect impact to the smallest useful verification obligation. Keep recommendations explainable,
bounded and advisory until their evidence and authority are explicit. A green recommendation must
not imply that execution, CI, review, publication or runtime activation occurred.

## 0.6: incremental indexes under budget

Expose scope, freshness, changed inputs, CPU, memory and the smallest safe recovery action.
Incremental outputs must match supported full rebuilds; unsupported changes fall back visibly.
A watcher or daemon requires measured benefit, bounded lifetime, cancellation and crash recovery.

## 0.7: sources and provenance

Reuse native language tooling, structural sources and optional retrieval providers without
collapsing their authority. Report provider identity, revision, coverage and confidence separately;
an attestation establishes attribution and integrity, not semantic truth. Keep source and LSP
fallbacks, and retain existing providers until a replacement is independently proven.

Qualified provider profiles remain capped by HOK-892. They have no assigned product version here;
qualification requires observed cross-host evidence rather than a roadmap promise.

## 1.0 and beyond

1.0 stabilizes the demonstrated product scope. It does not require native search, replacement of
every index, or an executor. Publish supported platforms/languages, compatibility/deprecation
windows, migration guarantees, limits and resource budgets. Test upgrades from supported previous
versions, not only fresh installs. Review adoption and support evidence after each minor release.

Stronger automatic enforcement and persisted execution remain a separate decision after accepted
P4 evidence, explicit authority, rollback and kill-switch validation. P4 is the independent evaluation
of change authorization: compare impact alone, added authored intent, and added control/replay with
simpler baselines, then have the maintainer accept a scoped positive, negative or inconclusive verdict.
It is separate from the early adoption pilot and retrieval research. Read-only replay is useful on
its own. This roadmap grants no new execution authority.

## Tooling and execution

Reuse Bun, Python and the existing GitHub Actions verification/release stack. Build the missing
product instruments: a reproducible demo, impact-pilot runner, compatibility manifest, public
evidence report and index lifecycle/resource matrix. Basic use needs no hosted telemetry, paid
service or model API.

The [adoption plan](docs/product/adoption-plan.md) defines measurements and sequencing.
The [tooling plan](docs/product/tooling-plan.md) records reuse/build/evaluate/defer choices.
These planning documents do not change current runtime or release gates.
