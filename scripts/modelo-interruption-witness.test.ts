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

test.each([
  ["a string instead of an array", "INDEX_BUILD_INCOMPLETE"],
  ["a substring-bearing string instead of an array", "PREFIX_INDEX_BUILD_INCOMPLETE_SUFFIX"],
  ["an array containing a non-string reason", ["INDEX_BUILD_INCOMPLETE", null]],
  ["an array-like object instead of an array", { 0: "INDEX_BUILD_INCOMPLETE", length: 1 }],
  ["a null reasons container", null],
])("rejects interrupted admission with %s", (_description, reasons) => {
  expect(() => assertInterruptedAdmission({ code: 3, stdout: JSON.stringify({ verdict: "BLOCK", analysisAdmission: { status: "rejected", reasons } }), stderr: "" })).toThrow();
});

test("rejects an array containing only a lookalike incomplete-build reason", () => {
  expect(() => assertInterruptedAdmission({ code: 3, stdout: JSON.stringify({ verdict: "BLOCK", analysisAdmission: { status: "rejected", reasons: ["PREFIX_INDEX_BUILD_INCOMPLETE_SUFFIX"] } }), stderr: "" })).toThrow();
});
