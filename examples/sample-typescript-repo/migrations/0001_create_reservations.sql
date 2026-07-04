-- Booking schema. Slots have a fixed capacity; reservations reference a slot.
-- @constraint confirmed-never-exceeds-capacity: status lifecycle is stored here; the
--   capacity invariant is enforced at the application layer on confirmation.
CREATE TABLE slots (
  id       TEXT PRIMARY KEY,
  capacity INTEGER NOT NULL CHECK (capacity >= 0)
);

CREATE TABLE reservations (
  id      TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL REFERENCES slots (id),
  seats   INTEGER NOT NULL CHECK (seats > 0),
  status  TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled'))
);

CREATE INDEX idx_reservations_slot ON reservations (slot_id, status);
