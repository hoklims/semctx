# Fix overbooking on concurrent reservation confirmation

mode: bugfix
capability: reservation-confirmation
invariant: confirmed-never-exceeds-capacity
bounded context: booking

Observed: two concurrent confirmations for the same slot both pass the capacity check
and are saved, so the slot ends up with more confirmed seats than its capacity.

Expected: confirming a reservation must never let confirmed seats exceed slot capacity,
even under concurrent confirmations.

Non-goal: changing how pending reservations behave.
Risk: the confirmation path reads remaining capacity and writes without a guard.
