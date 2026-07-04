/**
 * Customer-facing copy for booking notifications. Presentation only.
 * This module talks a lot about "reservation" and "confirmation" but contains
 * NO capacity logic and is NOT part of the booking invariant surface.
 *
 * @boundedContext notifications
 */
export function reservationConfirmationEmail(customerName: string, slotId: string): string {
  return `Hi ${customerName}, your reservation for ${slotId} is confirmed. See you soon!`;
}

export function reservationPendingEmail(customerName: string, slotId: string): string {
  return `Hi ${customerName}, your reservation for ${slotId} is pending confirmation.`;
}

export function reservationCancelledEmail(customerName: string, slotId: string): string {
  return `Hi ${customerName}, your reservation for ${slotId} was cancelled.`;
}
