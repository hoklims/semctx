import { expect, test } from "bun:test";
import { compareRuntimeReasons, projectRuntimeReasons } from "./t00-ts7-q-config-emit-helpers";

const oracle = { compilerVersion: "7.1.0-dev", sourceRevision: "780dc512d64f40afebffa6a7028207649fb7ed1c", sdkLibraryCount: 115, observation: { helpers: [{ name: "typescript:awaiter", scoped: false }], imports: ["tslib"], jsxSpans: [], jsxTokenSpans: [], calls: [], automaticImportBase: "", diagnostics: [] } };

test("helper refusal requires enabled imports, a non scoped helper and the exact tslib specifier", () => {
  expect(projectRuntimeReasons(oracle, true)).toEqual(["SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED"]);
  expect(projectRuntimeReasons(oracle, false)).toEqual([]);
  for (const observation of [{ ...oracle.observation, helpers: [] }, { ...oracle.observation, helpers: [{ name: "scoped", scoped: true }] }, { ...oracle.observation, imports: ["tslib/decoy"] }]) expect(projectRuntimeReasons({ ...oracle, observation }, true)).toEqual([]);
});

test("missing observations and mismatching owning operation cannot pass", () => {
  const expected = ["SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED"];
  expect(compareRuntimeReasons({ executed: true, unsupported: [], reasons: expected }, expected)).toBe(true);
  for (const value of [{}, { executed: false, unsupported: [], reasons: expected }, { executed: true, unsupported: ["not executed"], reasons: expected }, { executed: true, unsupported: [], reasons: [] }, { executed: true, unsupported: [], reasons: [...expected, "SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED"] }]) expect(compareRuntimeReasons(value, expected)).toBe(false);
});

test("foreign compiler and malformed oracle fail closed", () => {
  expect(() => projectRuntimeReasons({ ...oracle, compilerVersion: "5.9.3" }, true)).toThrow();
  expect(() => projectRuntimeReasons({ ...oracle, observation: {} }, true)).toThrow();
});

test("classic calls must be synthesized and match native JSX token spans", () => {
  const jsx = { ...oracle.observation, helpers: [], imports: [], jsxSpans: [[2, 12]], jsxTokenSpans: [[4, 12]], calls: [{ synthetic: true, pos: 4, end: 12 }] };
  expect(projectRuntimeReasons({ ...oracle, observation: jsx }, false)).toEqual(["SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED"]);
  for (const calls of [[{ synthetic: false, pos: 4, end: 12 }], [{ synthetic: true, pos: 5, end: 12 }], []]) expect(projectRuntimeReasons({ ...oracle, observation: { ...jsx, calls } }, false)).toEqual([]);
  expect(projectRuntimeReasons({ ...oracle, observation: { ...jsx, automaticImportBase: "react" } }, false)).toEqual(["SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED"]);
  expect(projectRuntimeReasons({ ...oracle, observation: { ...jsx, jsxSpans: [], jsxTokenSpans: [], automaticImportBase: "react" } }, false)).toEqual([]);
});

import { runEmitHelpers, emitHelpersIndices } from "./t00-ts7-q-config-emit-helpers";

test("missing API artifact leaves all selected obligations unqualified without executing a substitute", async () => {
  const results = await runEmitHelpers({ producer: "/missing", helper: "/missing", sdk: "/missing", oracle: "/missing", out: "/missing", platform: "macos", run: () => { throw Error("unexpected execution"); } }, emitHelpersIndices);
  expect(results).toHaveLength(8);
  expect(results.every(row => row.status === "not_qualified" && row.properties[0]?.status === "not_qualified")).toBe(true);
});

import { compareRuntimeOwners } from "./t00-ts7-q-config-emit-helpers";

test("TSX runtime compares its module configuration owner without requiring a JavaScript operation", () => {
  const expected = ["SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED"];
  const subject = { moduleConfigurationObservations: { retainedWithoutSource: { executed: true, reasons: expected, unsupported: [] } }, javascriptObservation: { executed: false, reasons: [], unsupported: ["COMPONENT_JAVASCRIPT_SOURCE_REQUIRED"] } };
  expect(compareRuntimeOwners(subject, expected, "moduleConfiguration")).toBe(true);
  expect(compareRuntimeOwners(subject, expected, "javascript")).toBe(false);
  expect(compareRuntimeOwners({ ...subject, moduleConfigurationObservations: {} }, expected, "moduleConfiguration")).toBe(false);
});
