---
type: adr
boundedContext: booking
status: accepted
decision: Only confirmed reservations consume slot capacity; pending reservations never do.
capabilities: [reservation-lifecycle, capacity-accounting]
invariants: [confirmed-never-exceeds-capacity]
---

# ADR 0001 - Reservation status lifecycle

## Decision

Reservations are `pending`, `confirmed` or `cancelled`. Capacity is consumed only by
`confirmed` reservations. This makes confirmation the single enforcement point for the
`confirmed-never-exceeds-capacity` invariant.

## Rationale

Reserving capacity on pending caused abandoned carts to starve real bookings. Moving
enforcement to confirmation fixed availability accuracy.
