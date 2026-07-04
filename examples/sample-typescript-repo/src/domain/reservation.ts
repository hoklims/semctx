/**
 * Booking domain: reservations placed against capacity-limited slots.
 *
 * @boundedContext booking
 * @capability reservation-lifecycle
 */

export type ReservationStatus = "pending" | "confirmed" | "cancelled";

export interface Slot {
  id: string;
  capacity: number;
}

export interface Reservation {
  id: string;
  slotId: string;
  seats: number;
  status: ReservationStatus;
}

/** A reservation only occupies capacity once it is confirmed. */
export function isCapacityConsuming(reservation: Reservation): boolean {
  return reservation.status === "confirmed";
}
