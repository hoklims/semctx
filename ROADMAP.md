# Semctx roadmap

> Revised 2026-09-12. Released baseline: **v0.2.1**.
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

## Available today

[v0.2.1](https://github.com/hoklims/semctx/releases/tag/v0.2.1) provides local change-impact
analysis, explainable PASS/WARN/BLOCK reports, source-bound index health, authored intent and
contracts, read-only control/replay surfaces, and Codex/Claude integrations.

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
| **0.1.20 — Reliable first contact** | Install, diagnose and update without contradictory health messages or destructive recovery advice. | Tested compatibility; stale-index diagnosis; configuration preservation; registry availability and delivery proof. |
| **0.2 — Useful in ten minutes** | Try an example, understand a risk and choose the next check, then repeat on your repository. | Reproducible demo and contributor journey, concise report, frozen replay of thirty public changes with raw results and limits; human studies waived and their outcomes unmeasured. |
| **0.3 — Indexes you can live with** | Keep useful context across edits, branches and worktrees within a declared resource budget. | Cold/warm/update measurements; supported incremental paths match full rebuilds; drift/crash/recovery tests; matching source, artifact and consumer generations. |
| **0.4 — Connected, evidence-aware context** | Reuse useful symbol, build, test and retrieval sources with provenance and limits. | Scoped provider conformance, failure cases, native-only comparison and independent replay evidence. Native retrieval remains a conditional research track. |
| **1.0 — A dependable supported contract** | Adopt the proven workflow with predictable compatibility, upgrades and support boundaries. | Support policy, migration/rollback tests, repeated independent use and evidence for every advertised capability. |

Patch releases correct shipped behavior. Minor releases add a coherent capability and disclose
pre-1.0 breaking changes. Future work cannot be assigned retroactively to a published version.
Product versions, machine schemas and index generations remain distinct. Closed-issue percentages
are not release-readiness scores.

## 0.1.20: remove reasons to give up

- Align doctor, index health and control readiness while preserving their different meanings.
- Publish one tested Bun/host compatibility matrix; reconcile docs and package metadata.
- Give existing installations configuration-preserving upgrade/recovery instructions.
- Handle delayed npm availability before plugin-channel promotion, without duplicate publication.

A supported host minimum is an explicit support decision, distinct from the oldest historically
compatible binary. Untested versions stay unknown. No new control layer is needed for these fixes.

## 0.2: make first use and evidence reproducible

Provide a public example with a harmless change, a meaningful risk, and an unresolved case. Show
source, explanation, suggested checks and limits together. Pilot a frozen packaged candidate first
(or an opt-in prerelease when supported); never move the stable channel for an experiment. After
publication, regenerate the public demo from the exact release. Record both artifact identities;
changed behavior requires new measurements. Screenshots alone are not evidence.

The first report should make the next action obvious. Detailed contracts and machine output remain
accessible. Existing configured gates retain their behavior; this roadmap neither disables them
nor authorizes new automatic blocking.

Distribution starts with the README, a lightweight documentation/demo page, task-focused recipes
for CLI/Codex/Claude, and release notes explaining a before/after outcome. Collect opt-in feedback
on confusing or ignored findings. Public case studies require consent and reproducible examples
or an explicit explanation of unavailable private evidence.

On 2026-09-08 the maintainer explicitly waived external participant studies for this release.
The proposed five-maintainer trial, two-contributor trial and fourteen-day follow-up are therefore
not release gates. Adoption, retention, comprehension and human completion time remain
**NOT_MEASURED**. Automated journeys and technical review do not substitute for human observations.

Evaluate at least thirty real changes across three independent repositories against changed-files-only
and simple dependency-neighborhood advice. Freeze source pairs, protocol, runner and package before
replay; retain infrastructure and product failures. Cases without independent ground truth remain
UNKNOWN and cannot produce accuracy, recall or effort-saving claims. The runner supports later
adjudicated evaluation, but this release does not claim independent value from unlabelled changes.
This early impact pilot does not replace P4 or unlock enforcement.

## 0.3: make indexes an understandable capability

An index must be current for the question, affordable to maintain and recoverable. Expose scope,
freshness, changed inputs, resource cost and the smallest safe recovery action. An updated artifact
does not prove that a stateful consumer loaded it.

| Need | Direction |
| --- | --- |
| Exact text or known path | Keep direct source search available without a persistent index. |
| Definitions and references | Reuse native language tooling; evaluate portable SCIP artifacts where useful. |
| Dependencies and architectural neighbors | Bounded structural traversal with provenance. |
| Intent, invariants and change impact | Semctx's source-bound semantic index and authored declarations, within their scope. |
| Discovery by meaning | Existing content retrievers remain usable; investigate optional content-first retrieval separately. |

Prioritize memory, safe reuse, update cost and worktree isolation before increasing worker counts.
Incremental outputs must match supported full rebuilds; unsupported changes fall back visibly.
A watcher/daemon needs measured benefit, bounded lifetime, cancellation and crash recovery.
No global background service is required to try Semctx.

## 0.4: connect tools before replacing them

Start with one provider selected from an observed pilot need. Reuse interchange formats and existing
indexers; avoid building a universal language server, vector database or execution platform.
Report provider identity, revision, coverage and confidence separately. An attestation establishes
attribution and integrity, not semantic truth.

Native retrieval follows [ADR 0005](docs/adr/0005-context-retrieval-pipeline-rejected.md) and the
[content-first protocol](docs/research/content-first-context-retrieval.md): CONTINUE permits only the
measured capability; NULL RESULT closes the direction without delaying impact/index improvements.

Replacing CCC, Graphify or another persistent provider requires **REPLACEMENT_READY**, first
claimable in 1.0 or later: 30–50 tasks on three independent repositories, every replaced use case
measured, supported OS/host parity, generation safety, acceptable total cost, and an independently
reproduced migration. Inventory actual tools, preview cutover, verify backups/restoration, run both
paths in shadow, switch atomically and retain rollback through a predefined stability window.
Keep source/LSP fallbacks. The existing provider stays until its replacement is proven.

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
