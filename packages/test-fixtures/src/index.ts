import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { createDefaultConfig } from "@semantic-context/core";
import type { SemctxConfig } from "@semantic-context/core";

/** Absolute path to the monorepo root (packages/test-fixtures/src -> ../../..). */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** The sample booking repo that semctx analyses in tests and demos. */
export const SAMPLE_REPO = join(REPO_ROOT, "examples", "sample-typescript-repo");

export function sampleConfig(): SemctxConfig {
  return createDefaultConfig(SAMPLE_REPO);
}

export function sampleTaskMarkdown(): string {
  return readFileSync(join(SAMPLE_REPO, "tasks", "overbooking-bug.md"), "utf8");
}

/** Assert a value is defined and narrow it. Keeps tests strict-safe. */
export function must<T>(value: T | undefined | null, message = "expected a value, got undefined/null"): T {
  if (value === undefined || value === null) throw new Error(message);
  return value;
}

/** Stable slugs the fixture is expected to expose (used by assertions). */
export const EXPECTED = {
  capabilities: ["reservation-confirmation", "capacity-accounting", "reservation-lifecycle"],
  invariant: "confirmed-never-exceeds-capacity",
  boundedContext: "booking",
  confirmationPath: [
    "handleConfirmReservation",
    "confirmReservation",
    "remainingCapacity",
    "confirmedSeats",
  ],
  migration: "migrations/0001_create_reservations.sql",
  deprecatedDoc: "docs/legacy-capacity-notes.md",
  decoyModule: "src/app/notification-templates.ts",
  tests: ["test/capacity.test.ts", "test/confirmation.test.ts"],
} as const;
