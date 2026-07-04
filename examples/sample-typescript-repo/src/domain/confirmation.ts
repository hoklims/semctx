import type { Reservation, Slot } from "./reservation";
import { remainingCapacity } from "./capacity";

/**
 * Confirm a pending reservation, enforcing slot capacity.
 *
 * @capability reservation-confirmation
 * @boundedContext booking
 * @invariant confirmed-never-exceeds-capacity: confirming must never push confirmed seats above slot.capacity
 * @risk overbooking-on-concurrency: capacity is read then written without a guard, so two concurrent confirmations can both pass the check and overbook the slot
 */
export function confirmReservation(
  slot: Slot,
  reservation: Reservation,
  existing: readonly Reservation[],
): Reservation {
  const remaining = remainingCapacity(slot, existing);
  if (reservation.seats > remaining) {
    throw new Error(`insufficient capacity for slot ${slot.id}`);
  }
  return { ...reservation, status: "confirmed" };
}
