import type { Reservation, Slot } from "../domain/reservation";

/**
 * Persistence port for the booking context.
 *
 * @boundedContext booking
 * @contract reservation-repository-port: exposes getSlot, getReservation, listReservations, save
 */
export interface ReservationRepository {
  getSlot(slotId: string): Promise<Slot>;
  getReservation(reservationId: string): Promise<Reservation>;
  listReservations(slotId: string): Promise<Reservation[]>;
  save(reservation: Reservation): Promise<void>;
}

/** In-memory adapter used by tests and the reference handler. */
export class InMemoryReservationRepository implements ReservationRepository {
  private readonly slots = new Map<string, Slot>();
  private readonly reservations = new Map<string, Reservation>();

  constructor(slots: Slot[], reservations: Reservation[]) {
    for (const slot of slots) this.slots.set(slot.id, slot);
    for (const reservation of reservations) this.reservations.set(reservation.id, reservation);
  }

  async getSlot(slotId: string): Promise<Slot> {
    const slot = this.slots.get(slotId);
    if (!slot) throw new Error(`unknown slot ${slotId}`);
    return slot;
  }

  async getReservation(reservationId: string): Promise<Reservation> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new Error(`unknown reservation ${reservationId}`);
    return reservation;
  }

  async listReservations(slotId: string): Promise<Reservation[]> {
    return [...this.reservations.values()].filter((r) => r.slotId === slotId);
  }

  async save(reservation: Reservation): Promise<void> {
    this.reservations.set(reservation.id, reservation);
  }
}
