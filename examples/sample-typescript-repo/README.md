# sample-booking-repo (semctx fixture)

A deliberately realistic TypeScript repo used to demonstrate and test semctx.

It contains, on purpose:

- a **domain** (`src/domain`): reservations against capacity-limited slots;
- a **business rule / invariant**: `confirmed-never-exceeds-capacity`
  (only confirmed reservations consume capacity);
- a **confirmation path** (`src/app/confirm-reservation-handler.ts`) with a
  **reproducible overbooking bug** under concurrency (`src/domain/confirmation.ts`);
- a **migration** (`migrations/0001_create_reservations.sql`);
- **Vitest tests** proving the contract (`test/`);
- an **ADR** explaining the lifecycle decision (`docs/adr/0001-status-lifecycle.md`);
- a **deprecated, contradictory doc** (`docs/legacy-capacity-notes.md`) that is
  lexically very close to the task but no longer true;
- a **lexical decoy** (`src/app/notification-templates.ts`) that mentions
  "reservation" and "confirmation" heavily but holds no capacity logic.

The task in `tasks/overbooking-bug.md` asks to fix the concurrent-confirmation
overbooking. A correct Context Pack must surface the invariant, the confirmation path,
the migration and the tests, cite the ADR, and mark the deprecated doc as
non-normative while keeping the decoy out of the authoritative set.
