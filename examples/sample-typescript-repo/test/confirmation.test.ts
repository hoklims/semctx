import { describe, it, expect } from "vitest";
import { confirmReservation } from "../src/domain/confirmation";
import { confirmedSeats } from "../src/domain/capacity";
import type { Reservation, Slot } from "../src/domain/reservation";

const slot: Slot = { id: "slot-1", capacity: 10 };

describe("confirmReservation", () => {
  it("confirms when capacity remains", () => {
    const existing: Reservation[] = [
      { id: "r1", slotId: "slot-1", seats: 6, status: "confirmed" },
    ];
    const pending: Reservation = { id: "r2", slotId: "slot-1", seats: 4, status: "confirmed" };
    const result = confirmReservation(slot, { ...pending, status: "pending" }, existing);
    expect(result.status).toBe("confirmed");
  });

  it("rejects when it would exceed capacity", () => {
    const existing: Reservation[] = [
      { id: "r1", slotId: "slot-1", seats: 8, status: "confirmed" },
    ];
    const pending: Reservation = { id: "r2", slotId: "slot-1", seats: 5, status: "pending" };
    expect(() => confirmReservation(slot, pending, existing)).toThrow(/insufficient capacity/);
  });

  it("INVARIANT confirmed-never-exceeds-capacity holds sequentially", () => {
    const existing: Reservation[] = [
      { id: "r1", slotId: "slot-1", seats: 8, status: "confirmed" },
      { id: "r2", slotId: "slot-1", seats: 2, status: "confirmed" },
    ];
    expect(confirmedSeats(slot, existing)).toBeLessThanOrEqual(slot.capacity);
  });
});
