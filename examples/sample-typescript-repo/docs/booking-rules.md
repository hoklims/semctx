---
type: doc
boundedContext: booking
status: current
capabilities: [reservation-confirmation, capacity-accounting]
invariants: [confirmed-never-exceeds-capacity]
---

# Booking rules (current)

A slot has a fixed capacity. A reservation moves through the lifecycle
`pending -> confirmed -> cancelled`.

**Only confirmed reservations consume capacity.** Pending reservations do not hold any
capacity. Confirmation must enforce the invariant
`confirmed-never-exceeds-capacity`: the sum of seats over confirmed reservations for a
slot may never exceed the slot capacity.
