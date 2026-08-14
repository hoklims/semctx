# SEM Context product roadmap

> Public narrative snapshot: 2026-08-14

This document explains where SEM Context is going and why it matters. It deliberately stays at
product level and remains self-contained for readers outside the project team. Public delivery
status and technical evidence are available through the repository, its releases and its tests.

## The promise

Coding agents are increasingly good at producing code. The harder problem is deciding whether a
change should be trusted.

SEM Context turns a proposed code change into a reviewable decision:

- what outcome the change is meant to deliver;
- what parts of the product it is allowed to affect;
- what is known, uncertain or outside the analysis;
- which evidence supports the change;
- whether the available evidence is sufficient to proceed.

The goal is not to replace Codex, Claude Code, code search, CI or human review. The goal is to give
all of them a shared, deterministic and independently verifiable basis for change authorization.

## Who it is for

- **Maintainers** who want fewer silent regressions and a clearer review trail.
- **Teams using several coding agents** who need consistent rules across hosts and sessions.
- **Reviewers and auditors** who need to understand why a change was accepted, refused or sent
  back for more evidence.
- **Tool builders** who need a local, versioned control layer without granting it execution
  authority.

## Product principles

1. **Evidence before confidence.** A green test or a plausible explanation is not enough on its
   own.
2. **Unknown stays unknown.** Missing, stale or contradictory information must never become an
   optimistic verdict.
3. **Intent survives the implementation.** The expected outcome, constraints and accepted scope
   must remain visible from planning through review.
4. **Same inputs, same decision.** Supported hosts must reach the same bounded verdict from the
   same sealed task and repository state.
5. **Advisory before enforcement.** SEM Context must first demonstrate useful, low-noise guidance
   before it is allowed to block work.
6. **No executor before proof.** Execution and rollback are a later product decision, not an
   assumed destination.

## What users can rely on today

SEM Context already provides a local-first foundation for governed change:

- deterministic repository analysis and change-impact reports;
- Git-versioned semantic intent, invariants and change contracts;
- read-only planning, reconciliation and handoff contracts;
- explicit freshness and source-state binding;
- shared Codex and Claude Code plugin contracts;
- multi-language repository facts with honest capability limits;
- a publicly released and reproducible [v0.1.17](https://github.com/hoklims/semctx/releases/tag/v0.1.17).

The product still has important limits: host lifecycle integration remains mainly shadow-mode,
competitive evidence has not been produced, and SEM Context has no authority to execute changes.

## Roadmap at a glance

| Stage | User-visible outcome | Public status on 2026-08-14 |
| --- | --- | --- |
| **M1 — Reliable distribution** | Install and update the same product across supported hosts, with portable configuration and reproducible artifacts. | Core v0.1.17 outcome delivered; operational hardening continues. |
| **M2 — Trustworthy change decisions** | Keep intent, source state, scope and evidence aligned across agents before any enforcement. | Active. |
| **M3 — Independent product proof** | Demonstrate, on reproducible and independent cases, whether SEM Context improves change quality without unacceptable cost or false blocks. | Queued behind M2. |
| **M4 — Decide whether to enforce or execute** | Make an explicit `GO`, `DEFER` or `NO-GO` decision from the M3 evidence and a credible rollback contract. | Gated by M3 evidence. |

## Now — make the trust foundation dependable

The current product focus is M2. Three visible workstreams carry it:

### Stable semantic identity

This work ensures that harmless code movement does not invalidate meaning, while real ambiguity or
removal still fails safely.

**Expected user outcome:** fewer false stale warnings, no silent rebinding, and migration guidance
that never rewrites authored intent from uncertain evidence.

### Portable host connection

This work removes assumptions that prevent some hosts from starting the SEM Context connection
reliably.

### Native Grok integration

The Grok integration builds on the portable connection work so Grok can use the same governed
workflow without depending on a global CLI.

**Expected user outcome for both host workstreams:** a supported host either connects through the
same product contract or fails with a clear, bounded reason. It must never appear healthy while
using the wrong repository or runtime.

## Next — measure the workflow before blocking anyone

Once the current trust work is closed, the next outcome is automatic Codex and Claude Code
lifecycle checkpoints in measured shadow mode.

This stage observes what SEM Context would have advised without interrupting the user. It must
measure:

- useful warnings versus false blocks;
- missed risks and unsupported cases;
- consistency between hosts;
- added latency, token cost and operator effort;
- whether handoffs preserve intent and evidence across long-running work.

Only measured, acceptable results may justify enforcement.

## After that — create an independently verifiable decision record

The next major product capability after stable anchors and measured host workflows is a versioned,
evidence-bound change decision.

Its outcome is a versioned change-authorization record that binds:

- the requested outcome and accepted scope;
- the exact repository and tool state;
- known, approximated and unknown impacts;
- tests, runtime observations and human approvals with provenance;
- the policy used to reach `ALLOW`, `DENY` or `REQUIRE_EVIDENCE`.

The first version remains read-only. An independent verifier must be able to replay the decision;
the record itself grants no permission to modify a repository.

## Then — prove whether the product is actually better

M3 is an evidence programme, not a marketing milestone.

This stage will compare SEM Context with strong, reproducible alternatives on real change tasks.
The protocol, datasets, budgets and success thresholds must be fixed before results are observed.

The product must demonstrate that it can:

- preserve intended outcomes and constraints;
- keep changes inside the accepted scope;
- refuse stale, forged or insufficient evidence;
- avoid degrading the functional result;
- stay within declared false-block, latency, token and operator-effort budgets;
- provide value on independent repositories, not only on SEM Context itself.

Null and negative results are part of the deliverable. No state-of-the-art or market-leadership
claim is allowed before this gate clears.

## Only after proof — decide on enforcement and execution

M4 is a decision gate, not a promised feature. Persisted control state, blocking enforcement or an
isolated executor may be explored only if M3 is independently accepted and a rollback, cutover and
kill-switch contract is explicit.

Until then, `executionAuthority` remains `none`.

## Separate research track

This track tests whether SEM Context adds measurable value on top of strong content retrieval. It is
deliberately separate from the shipping path.

SEM Context is not positioned as a generic code-search replacement. If the graph and authority
layers do not improve a strong content-first baseline, the retrieval direction will close with a
documented null result.

## Operational follow-ups

The v0.1.17 product outcome is delivered, but follow-up work remains and should not be mistaken for
a new release promise:

- independent stable-delivery proof across Codex and Claude Code;
- Windows cache-lock reconciliation after successful updates;
- additional configuration-sharing robustness;
- dependency upgrades reviewed by compatibility risk rather than merged blindly.

These tasks are prioritized by user risk and the evidence needed to close them.

## How progress is judged

Roadmap progress is based on observed outcomes, not volume of code or number of closed tickets.

A stage is complete only when its own evidence is available. In particular:

- local code and targeted tests do not prove a shipped product;
- a shipped package does not prove that every active host loaded it;
- `FRESH` does not mean complete analysis or sufficient evidence;
- a signed or sealed assertion proves integrity and provenance, not semantic truth;
- a successful internal demonstration does not prove independent product value.

GitHub is the public technical history and contribution surface. The repository, tests, release
artifacts and target environments carry delivery evidence; this roadmap records the public product
direction and its proof gates.

## References

- [GitHub repository](https://github.com/hoklims/semctx)
- [Current product status and limits](README.md#current-delivery-status)
- [Architecture overview](docs/architecture/overview.md)
- [Research decisions](docs/research/)
