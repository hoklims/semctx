import { describe, it, expect } from "vitest";
import { remainingCapacity, confirmedSeats } from "../src/domain/capacity";
import type { Reservation, Slot } from "../src/domain/reservation";

const slot: Slot = { id: "slot-1", capacity: 10 };

describe("capacity accounting", () => {
  it("counts only confirmed reservations toward used capacity", () => {
    const reservations: Reservation[] = [
      { id: "r1", slotId: "slot-1", seats: 4, status: "confirmed" },
      { id: "r2", slotId: "slot-1", seats: 3, status: "pending" },
    ];
    // Pending reservations do NOT consume capacity. This proves the legacy note wrong.
    expect(confirmedSeats(slot, reservations)).toBe(4);
    expect(remainingCapacity(slot, reservations)).toBe(6);
  });
});
