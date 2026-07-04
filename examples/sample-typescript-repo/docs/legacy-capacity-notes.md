---
type: doc
boundedContext: booking
status: deprecated
contradicts: [docs/booking-rules.md]
capabilities: [capacity-accounting]
---

# Legacy capacity notes (OUTDATED - DO NOT RELY ON)

Historically, a **pending reservation immediately reserved capacity** the moment it was
created, and confirmation only flipped a flag. Under this old model, capacity accounting
counted pending and confirmed reservations alike.

This note talks about reservation, confirmation and capacity in detail, but it describes
behaviour that no longer holds. The current code, migration and tests all show that only
confirmed reservations consume capacity.
