---
type: adr
boundedContext: booking
status: accepted
decision: A reservation is accepted only when confirmed seats remain below total capacity.
capabilities: [reservation-confirmation, capacity-accounting]
invariants: [confirmed-never-exceeds-capacity]
---

# Fixture ADR 0001 — Confirmation capacity

The fixture's `confirm` function is the decision point. It returns `Full` when `confirmed` equals `total`; the capacity calculation saturates at zero. This fixture decision supplies an independent expectation for the integration test and the invariant-violation diff. It does not assert that static indexing proves the business rule.
