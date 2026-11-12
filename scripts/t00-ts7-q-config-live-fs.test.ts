import { describe, expect, test } from "bun:test";
import { evaluateLiveObservation, evaluateLiveResolution, resolutionModeFromTrace, configurationReadAttributed } from "./t00-ts7-q-config-live-fs";

describe("live filesystem contract comparison", () => {
  const expected = [{ operation: "read_file", path: "/repo/value.json", value: "physical" }];
  const valid = { executed: true, unsupported: [], results: expected };
  test("accepts the complete independently supplied observation", () => {
    expect(evaluateLiveObservation(valid, expected)).toBe(true);
  });
  test("rejects missing, partial and substituted live reads", () => {
    expect(evaluateLiveObservation({ ...valid, results: [] }, expected)).toBe(false);
    expect(evaluateLiveObservation({ ...valid, executed: false }, expected)).toBe(false);
    expect(evaluateLiveObservation({ ...valid, unsupported: ["unsupported"] }, expected)).toBe(false);
    expect(evaluateLiveObservation({ ...valid, results: [{ ...expected[0], value: "captured" }] }, expected)).toBe(false);
  });
});

describe("live configured resolution comparison", () => {
  const valid = { executed: true, unsupported: [], native_error: null, native_diagnostics: [], resolved_file_name: "/repo/value.ts", request_descriptor_id: "request", producer_artifact_id: "producer", sdk_input_id: "sdk" };
  test("compares the entire result and exact artifact identities", () => {
    expect(evaluateLiveResolution(valid, "/repo/value.ts", "request", "producer", "sdk")).toBe(true);
    expect(evaluateLiveResolution({ ...valid, resolved_file_name: null }, null, "request", "producer", "sdk")).toBe(true);
  });
  test("refuses stale binding, native errors and partial or invented results", () => {
    for (const patch of [{ executed: false }, { unsupported: ["missing"] }, { native_error: "error" }, { native_diagnostics: [{ code: 1 }] }, { request_descriptor_id: "other" }, { producer_artifact_id: "other" }, { sdk_input_id: "other" }, { resolved_file_name: null }]) {
      expect(evaluateLiveResolution({ ...valid, ...patch }, "/repo/value.ts", "request", "producer", "sdk")).toBe(false);
    }
  });
});

describe("independent TS7 usage mode projection", () => {
  test("selects the mode of this exact import and source file", () => {
    const trace = "======== Resolving module 'dual' from '/repo/main.cts'. ========\nResolving in CJS mode with conditions 'require', 'types', 'node'.\n======== Module name 'dual' was successfully resolved to '/repo/require.d.cts'. ========\n======== Resolving module 'other' from '/repo/main.mts'. ========\nResolving in ESM mode with conditions 'import', 'types', 'node'.\n";
    expect(resolutionModeFromTrace(trace, "dual", "/repo/main.cts")).toBe("require");
    expect(resolutionModeFromTrace(trace, "other", "/repo/main.mts")).toBe("import");
  });
  test("missing and contradictory modes cannot silently become an omitted mode", () => {
    expect(() => resolutionModeFromTrace("", "dual", "/repo/main.ts")).toThrow("mode");
    const start = "======== Resolving module 'dual' from '/repo/main.ts'. ========\n";
    expect(() => resolutionModeFromTrace(`${start}Resolving in ESM mode with conditions 'import'.\n${start}Resolving in CJS mode with conditions 'require'.\n`, "dual", "/repo/main.ts")).toThrow("mode");
  });
});

describe("live configuration read activation", () => {
  const path = "/repo/tsconfig.json";
  const text = '{"compilerOptions":{"strict":true}}';
  const contentId = "sha256:e38958736510b3962d8f023832253729dd918fdd4ececbc38e18ffe5f1bbe9d7";
  const readable = { inputs: { [path]: text }, probes: [{ operation: "read_file", path, found: true, content_id: contentId }] };
  test("prefilled acquisition inputs cannot replace an executed read", () => {
    expect(configurationReadAttributed({ ...readable, probes: [] }, path, text)).toBe(false);
    expect(configurationReadAttributed({ inputs: { [path]: text } }, path, text)).toBe(false);
  });
  test("a successful read must bind the exact path and independent content digest", () => {
    expect(configurationReadAttributed(readable, path, text)).toBe(true);
    expect(configurationReadAttributed({ ...readable, inputs: {} }, path, text)).toBe(false);
    expect(configurationReadAttributed({ ...readable, inputs: { [path]: "substituted" } }, path, text)).toBe(false);
    for (const patch of [{ path: "/repo/other.json" }, { operation: "file_exists" }, { found: false }, { content_id: "sha256:substituted" }, { content_id: null }]) {
      expect(configurationReadAttributed({ ...readable, probes: [{ ...readable.probes[0], ...patch }] }, path, text)).toBe(false);
    }
  });
  test("undefined attribution requires an actual failed read while absence retains its discovery gate", () => {
    const unreadable = { inputs: { [path]: null }, probes: [{ operation: "read_file", path, found: false, content_id: null }] };
    expect(configurationReadAttributed(unreadable, path, null)).toBe(true);
    expect(configurationReadAttributed({ ...unreadable, probes: [] }, path, null)).toBe(false);
    expect(configurationReadAttributed({ ...unreadable, probes: [{ ...unreadable.probes[0], found: true }] }, path, null)).toBe(false);
    expect(configurationReadAttributed({}, path, undefined)).toBe(true);
  });
});
