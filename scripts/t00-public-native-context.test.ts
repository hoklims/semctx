import { expect, test } from "bun:test";
import { rawContextChecks, validatePublicUnits } from "../tools/rust-ts-r0/qualification/public-closure-20261022/public-native-context.mjs";

test("public proof refuses empty, duplicate and unsafe unit identities", () => {
  validatePublicUnits({ units: [{ id: "public" }] });
  for (const input of [{}, { units: [] }, { units: [{ id: "same" }, { id: "same" }] }, { units: [{ id: "../outside" }] }]) {
    expect(() => validatePublicUnits(input)).toThrow("PUBLIC_PROOF_INPUT_INVALID");
  }
});

test("public native context binds request, SDK and complete root observations", () => {
  const request = { id: "public", cwd: "/public", sdk_directory: "/sdk/lib", case_sensitive: true, roots: ["/public/main.ts"], files: { "/public/main.ts": "export const a=1;" }, options: {}, retained: true, qualified: false, roles: {}, selection: {}, disabled: [], utf16_files: {}, raw_files: {} };
  const sdk = { version: "5.9.3", archive_sha256: "public-sdk", files: { "/sdk/lib/lib.d.ts": "declare const x: number;" } };
  const observed = { request: "public", request_id: "sha256:fe0a5faa6e83e06062e640eee336694da4a71757cf613125424b06f4f397e7f0", input_manifest_id: "sha256:67d369c0bd613cbaaae387a9658549d50b3f2583dfc92d5436697a3569388451", sdk_version: "5.9.3", complete: true, global_admission_inferred: false, subjects: [{ path: "main.ts", outcome: "analyzed", unimplemented: [] }] };
  const passed = (actual: unknown, input = request, compiler = sdk) => Object.values(rawContextChecks(actual, input, compiler)).every(Boolean);
  expect(passed(observed)).toBe(true);
  expect(passed({ ...observed, request_id: "foreign" })).toBe(false);
  expect(passed({ ...observed, request: "foreign" })).toBe(false);
  expect(passed({ ...observed, input_manifest_id: "foreign" })).toBe(false);
  expect(passed({ ...observed, complete: false })).toBe(false);
  expect(passed({ ...observed, global_admission_inferred: true })).toBe(false);
  expect(passed({ ...observed, subjects: [] })).toBe(false);
  expect(passed({ ...observed, subjects: [{ path: "main.ts", outcome: "unknown", unimplemented: [] }] })).toBe(false);
  expect(passed({ ...observed, subjects: [{ path: "main.ts", outcome: "analyzed", unimplemented: ["fault"] }] })).toBe(false);
  expect(passed(observed, request, { ...sdk, archive_sha256: "foreign" })).toBe(false);
});
