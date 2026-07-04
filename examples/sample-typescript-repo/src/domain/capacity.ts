import type { Reservation, Slot } from "./reservation";

/**
 * Capacity accounting for a slot.
 *
 * @capability capacity-accounting
 * @boundedContext booking
 * @invariant confirmed-never-exceeds-capacity: the sum of seats across CONFIRMED reservations for a slot must never exceed slot.capacity
 *
 * Note: only confirmed reservations consume capacity. Pending reservations do NOT.
 */
export function confirmedSeats(slot: Slot, reservations: readonly Reservation[]): number {
  return reservations
    .filter((r) => r.slotId === slot.id && r.status === "confirmed")
    .reduce((sum, r) => sum + r.seats, 0);
}

export function remainingCapacity(slot: Slot, reservations: readonly Reservation[]): number {
  return slot.capacity - confirmedSeats(slot, reservations);
}
