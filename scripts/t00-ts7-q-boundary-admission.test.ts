import { describe, expect, test } from "bun:test";
import { compareAdmission, compareSnapshot, ts5WitnessSdk } from "./t00-ts7-q-boundary-admission";
import type { Execution } from "./t00-ts7-q-boundary-common";

const execution = (value: Record<string, unknown>, exitCode = 3): Execution => ({ value, exitCode, stdout: JSON.stringify(value), stderr: "", evidence: [] });
const expected = { status: "rejected" as const, coverage: [{ path: "src/main.ts", status: "unsupported" }], reasonPrefix: "DEPENDENCY_SCOPE_" };
const rejected = { analysisAdmission: { status: "rejected", reasons: ["DEPENDENCY_SCOPE_UNSUPPORTED:src/main.ts"], changeCoverage: { expected: ["src/main.ts"], files: expected.coverage } }, verdict: "BLOCK", global_admission_inferred: false };

test("TS7 SDK migration keeps the TS5 witness input explicit and never relabels candidate libraries", () => {
  const sdk5 = { version: "5.9.3", files: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`/sdk/lib/${index}`, "input"])) };
  const sdk7 = { version: "7.1.0-dev", files: Object.fromEntries(Array.from({ length: 115 }, (_, index) => [`/sdk/lib/${index}`, "input"])) };
  expect(ts5WitnessSdk({ sdk: sdk7 })).toBeUndefined();
  expect(ts5WitnessSdk({ sdk: sdk7, sdk5 })).toBe(sdk5);
  expect(ts5WitnessSdk({ sdk: sdk5 })).toBe(sdk5);
  expect(ts5WitnessSdk({ sdk: sdk5, sdk5: sdk7 })).toBeUndefined();
  expect(ts5WitnessSdk({ sdk: sdk7, sdk5: { version: "5.9.3", files: {} } })).toBeUndefined();
});

describe("independent admission observation", () => {
  test("accepts the required structured rejection and exact coverage", () => {
    expect(compareAdmission("computed", expected, execution(rejected)).every(property => property.pass)).toBe(true);
  });
  test("refuses an operational error masquerading as a structured rejection", () => {
    const properties = compareAdmission("computed", expected, execution({ error: "dependency unsupported" }, 1));
    expect(properties.length).toBeGreaterThan(0);
    expect(properties.every(property => property.pass)).toBe(false);
  });
  test("refuses positive exit, missing reasons and an omitted obligated path", () => {
    for (const result of [execution(rejected, 0), execution({ ...rejected, analysisAdmission: { ...rejected.analysisAdmission, reasons: [] } }), execution({ ...rejected, analysisAdmission: { ...rejected.analysisAdmission, changeCoverage: { expected: [], files: [] } } })]) {
      expect(compareAdmission("computed", expected, result).every(property => property.pass)).toBe(false);
    }
  });
  test("refuses snapshot error accompanied by successful analysis", () => {
    const result = execution({ error: "SOURCE_SNAPSHOT_MISMATCH: src/main.ts", native_analysis: {} }, 1);
    expect(compareSnapshot("mutation", result, "SOURCE_SNAPSHOT_MISMATCH: src/main.ts").every(property => property.pass)).toBe(false);
  });
  test("accepts exact fail-closed snapshot process shape", () => {
    const result = { ...execution({}, 1), stdout: "", stderr: '{"error":"SOURCE_SNAPSHOT_MISMATCH: src/main.ts"}\n' };
    expect(compareSnapshot("mutation", result, "SOURCE_SNAPSHOT_MISMATCH: src/main.ts").every(property => property.pass)).toBe(true);
  });
});
