import type { Reservation } from "../domain/reservation";
import type { ReservationRepository } from "../infra/reservation-repository";
import { confirmReservation } from "../domain/confirmation";

/**
 * Application entrypoint for confirming a reservation. This is the confirmation path.
 *
 * @capability reservation-confirmation
 * @boundedContext booking
 */
export async function handleConfirmReservation(
  repo: ReservationRepository,
  slotId: string,
  reservationId: string,
): Promise<Reservation> {
  const slot = await repo.getSlot(slotId);
  const reservation = await repo.getReservation(reservationId);
  const existing = await repo.listReservations(slotId);
  const confirmed = confirmReservation(slot, reservation, existing);
  await repo.save(confirmed);
  return confirmed;
}
