# Claims & Authority

## Claims

A **claim** is a checkable assertion about the repository, derived deterministically from
the graph. Each claim carries:

- a `kind` (contract, invariant, decision, capability, behavior, risk, deprecation, ...);
- a `verificationStatus` computed from *evidence*, never asserted;
- `authority`, `freshness`, `confidence` in `[0,1]` — numeric signals only;
- `subjectNodeIds` and `evidenceIds` linking it back to code and file/line evidence.

How status is derived (see `packages/context-engine/src/claim-builder.ts`):

| Claim source                                   | Status                 |
| ---------------------------------------------- | ---------------------- |
| Exported interface/type / `@contract` marker   | `statically_verified`  |
| Invariant whose constrained symbol has a test  | `tested`               |
| Capability implemented by a tested symbol      | `tested`               |
| Behaviour proven by a test file                | `tested`               |
| Invariant/capability known only from docs      | `documented`           |
| Invariant known only from a code comment       | `inferred`             |
| ADR decision                                   | `documented`           |
| Deprecated document                            | `deprecated`           |
| Document declaring a contradiction             | `contradicted`         |

The numeric authority/freshness for each status are documented constants in
`packages/context-engine/src/scoring.ts` — the single place raw numbers are assigned.

## Authority is task-relative (ADR 0003)

The importance of a claim depends on the **question**. An `AuthorityPolicy`
(`authority-policies.ts`) maps each question kind to preferred claim kinds and to
required/disallowed verification statuses:

| Question             | Prefers                                   | Requires (gate)                       |
| -------------------- | ----------------------------------------- | ------------------------------------- |
| public_api           | contract, capability, behavior            | statically_verified / tested          |
| persistence          | invariant, contract, decision             | —                                     |
| business_rule        | invariant, capability, behavior, decision | —                                     |
| runtime_behavior     | behavior, invariant, capability           | tested / runtime_verified             |
| historical_reason    | decision, capability                      | —                                     |
| style                | capability, behavior, contract            | —                                     |
| security             | invariant, contract, behavior, risk       | statically_verified / tested          |

## Gates run before scoring (numbers are never enough)

Selection is `priority(source, task)`. Before any score is computed, a claim must pass
**every** gate (`priority-engine.ts`); a single failure makes it ineligible regardless of
how much it resembles the task:

1. **status-allowed** — status not in the policy's disallowed set (kills deprecated / contradicted).
2. **contradiction-resolved** — the claim is not part of an unresolved contradiction.
3. **within-bounded-context** — the claim's subject lives in a selected bounded context.
4. **verification-sufficient** — meets the question's required statuses (e.g. security needs proof).
5. **reachable-from-entrypoint** — code-anchored claims must be reachable from a task entrypoint.

Only survivors are scored, by a transparent weighted sum over role match, authority,
graph reachability, verification strength and freshness, minus a contradiction penalty.
Every decision is emitted as a `PriorityExplanation` (component scores + gate outcomes +
prose), so nothing is a black box.

## Why the deprecated lexical neighbour loses

The fixture's `legacy-capacity-notes.md` is lexically almost identical to the task. It is
still never authoritative: its claims are `deprecated`/`contradicted`, so the
**status-allowed** and **contradiction-resolved** gates eliminate them before scoring.
It appears in the pack only under `contradictions`, explicitly non-normative. This is the
central regression test (`packages/context-engine/test/pack.test.ts`).
