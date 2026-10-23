import { expect, test } from "bun:test";
import { compareReceiptGuard } from "./t00-ts7-q-boundary-refusals";
import type { Execution, Json } from "./t00-ts7-q-boundary-common";

const subjects = [{ path: "src/main.ts", moduleConfigurationObservations: { retainedWithoutSource: { reasons: [] } } }];
const accepted: Json = { controlRoot: "/fixture", observedRoot: "/fixture", restoredRoot: "/fixture", received: true, contextAvailable: true, controlContextAvailable: true, controlSubjects: subjects, subjects, restoredSubjects: subjects, restoredContextAvailable: true, reason: null, phase: "revalidate_after_receipt", globalAdmissionInferred: false };
const execution = (value: Json): Execution => ({ value, exitCode: 0, stdout: JSON.stringify(value), stderr: "", evidence: [] });

test("receipt oracle requires both the rejected mutation and consumed/restored positive controls", () => {
  const rejected = { ...accepted, contextAvailable: false, subjects: null, reason: "IdentityMismatch" };
  expect(compareReceiptGuard("post-receipt-graph-mutation", execution(rejected), "/fixture").every(item => item.pass)).toBe(true);
  expect(compareReceiptGuard("fresh-valid", execution(accepted), "/fixture").every(item => item.pass)).toBe(true);
  for (const mutation of [{ contextAvailable: true }, { reason: undefined }, { reason: "" }, { subjects: [] }, { controlSubjects: [{ path: "wrong.ts" }] }, { restoredSubjects: [] }, { received: false }, { controlSubjects: [] }, { subjects: [{}] }, { restoredContextAvailable: false }, { reason: null }, { phase: "receive" }, { globalAdmissionInferred: true }]) {
    expect(compareReceiptGuard("post-receipt-graph-mutation", execution({ ...rejected, ...mutation }), "/fixture").every(item => item.pass)).toBe(false);
  }
  expect(() => compareReceiptGuard("unknown", execution(accepted), "/fixture")).toThrow();
});

test("root mismatch observes the native scope root against the independently selected fixture root", () => {
  const rejected = { ...accepted, contextAvailable: false, subjects: null, reason: "IdentityMismatch", observedRoot: "/foreign-root" };
  expect(compareReceiptGuard("root-mismatch", execution(rejected), "/fixture").every(item => item.pass)).toBe(true);
  for (const mutation of [{ observedRoot: "/fixture" }, { controlRoot: "T00_REPOSITORY_ROOT" }, { restoredRoot: "/foreign-root" }, { observedRoot: undefined }]) {
    expect(compareReceiptGuard("root-mismatch", execution({ ...rejected, ...mutation }), "/fixture").every(item => item.pass)).toBe(false);
  }
});
