# ADR 0003 — Authority is task-relative and gate-based

- Status: accepted
- Date: 2026-07-04

## Context

The importance of a source is not global. An exported TypeScript contract, a historical
test, and a stale README must not carry equal weight — and their relative weight depends
on the *question*. "What is the public API?" ranks exported types and contract tests
first; "why is this constrained?" ranks ADRs and decisions first.

Purely numeric scoring lets a lexically-similar but obsolete document win by resemblance.

## Decision

Selection is `priority(source, task)`, computed by:

1. A per-question `AuthorityPolicy` (preferred claim kinds, required/disallowed
   verification statuses).
2. A set of **gates** evaluated *before* scoring. A failed gate makes a source
   ineligible regardless of its score: deprecated, unresolved contradiction, outside
   the selected bounded context, insufficient verification for a security claim, not
   reachable from a relevant entrypoint.
3. A transparent weighted score over role match, authority, graph reachability,
   verification strength and freshness, minus a contradiction penalty.

Every decision emits a `PriorityExplanation` (component scores + gate outcomes + prose).

## Consequences

- No black box: each inclusion/exclusion is inspectable and traceable to evidence.
- Deprecated/contradicted sources appear in the pack only as **non-normative**
  contradictions, never as authoritative claims.
- Adding a new question kind = adding a policy row, not rewriting the ranker.
