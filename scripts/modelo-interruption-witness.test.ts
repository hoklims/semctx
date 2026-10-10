import { expect, test } from "bun:test";
import { assertInterruptedAdmission } from "./modelo-interruption-witness";

test("rejects an infrastructure failure instead of treating it as interrupted admission", () => {
  expect(() => assertInterruptedAdmission({ code: 1, stdout: '{"reason":"close the writer"}', stderr: "ERROR [STORE_ERROR] active WAL sidecars" })).toThrow();
});

test("accepts structured incomplete-build BLOCK with exit three", () => {
  expect(() => assertInterruptedAdmission({ code: 3, stdout: JSON.stringify({ verdict: "BLOCK", analysisAdmission: { status: "rejected", reasons: ["INDEX_BUILD_INCOMPLETE"] } }), stderr: "" })).not.toThrow();
});

test("rejects a BLOCK that does not identify the incomplete build", () => {
  expect(() => assertInterruptedAdmission({ code: 3, stdout: JSON.stringify({ verdict: "BLOCK", analysisAdmission: { status: "rejected", reasons: ["INDEX_STALE"] } }), stderr: "" })).toThrow();
});
