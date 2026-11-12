import { expect, test } from "bun:test";
import { compareScope } from "./t00-lot1-scope";

const limitation = "Opaque external static module boundaries: none";
const component = { executed: true, unsupported: [] };
const analysis = { global_admission_inferred: false, subjects: [{ path: "src/main.ts", retainedScopeSyntaxObservation: component, sourceParsingObservation: component, moduleConfigurationObservations: { retainedWithSource: component } }] };
const oracle = { retainedPaths: ["src/main.ts"], admission: { status: "admitted", reasons: [] as string[], limitations: [limitation], changeCoverage: { expected: ["src/main.ts"], files: [{ path: "src/main.ts", status: "analyzed", reasons: [] }] } }, scope: { links: [], reasons: [], unresolvedImports: [], externalModuleSpecifiers: [] } };
const native = { analysisAdmission: { status: "admitted", reasons: [] as string[], limitations: [limitation], externalModuleSpecifiers: [], changeCoverage: { expected: ["src/main.ts"], files: [{ path: "src/main.ts", status: "analyzed" }] } }, links: [], scopeReasons: [], unresolvedImports: [], selected_analysis: structuredClone(analysis), broad_analysis: structuredClone(analysis), indexed_extraction_received: true };

test("scope comparison accepts the complete independently represented projection", () => {
  expect(Object.values(compareScope(oracle, native, 0)).every(Boolean)).toBe(true);
});

test("scope comparison cannot replace a missing execution with an empty object", () => {
  expect(() => compareScope(oracle, {}, 0)).toThrow();
  expect(() => compareScope({}, native, 0)).toThrow();
});

test("scope comparison rejects empty subject inventories and skipped components", () => {
  const empty = structuredClone(native); empty.selected_analysis.subjects = [];
  expect(compareScope(oracle, empty, 0).executed).toBe(false);
  const skipped = structuredClone(native);
  skipped.broad_analysis.subjects[0]!.retainedScopeSyntaxObservation.executed = false;
  expect(compareScope(oracle, skipped, 0).executed).toBe(false);
});

test("scope comparison requires every retained source subject", () => {
  const source = structuredClone(oracle); source.retainedPaths.push("src/target.ts");
  expect(compareScope(source, native, 0).executed).toBe(false);
});

test("scope comparison retains unequal reasons, coverage, limitation and process outcome", () => {
  const altered = structuredClone(native);
  altered.analysisAdmission.reasons = ["foreign"];
  altered.analysisAdmission.changeCoverage.files = [];
  altered.analysisAdmission.limitations = [];
  altered.indexed_extraction_received = false;
  const result = compareScope(oracle, altered, 1);
  expect(result.completeAdmissionReasons).toBe(false);
  expect(result.changeCoverage).toBe(false);
  expect(result.opaqueLimitation).toBe(false);
  expect(result.cliExit).toBe(false);
  expect(result.executed).toBe(false);
});
