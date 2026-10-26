import { describe, expect, test } from "bun:test";
import { configuredSourceModeMatches, evaluateResolutionHost } from "./t00-ts7-q-config-resolution-alternatives";

describe("configured resolution host matrix evidence", () => {
  const fault = { system: "physical", operation: "file_exists", path: "/repo/value.json", outcome: "false" };
  const expected = {
    results: [{ operation: "read_file", path: "/repo/value.json", value: null }],
    trace: [
      { system: "admission", operation: "admitted", path: "/repo/value.json", value: true },
      { system: "physical", operation: "file_exists", path: "/repo/value.json", value: false },
    ],
    faultsActivated: [fault],
    nativeFailures: [],
  };
  const valid = {
    executed: true, unsupported: [], source: "native", ...expected,
    request_descriptor_id: "request", producer_artifact_id: "producer",
  };
  test("accepts an exact finite contract projection bound to its executable and request", () => {
    expect(evaluateResolutionHost(valid, expected, "request", "producer")).toBe(true);
  });
  test("an empty projection cannot stand in for a matrix witness", () => {
    const empty = { results: [], trace: [], faultsActivated: [], nativeFailures: [] };
    expect(evaluateResolutionHost({ ...valid, ...empty }, empty, "request", "producer")).toBe(false);
  });
  test("rejects missing execution, failure and stale artifact bindings", () => {
    for (const patch of [
      { executed: false }, { unsupported: ["missing"] },
      { source: "captured_unit_control" }, { source: undefined },
      { request_descriptor_id: "other" }, { producer_artifact_id: "other" },
      { nativeFailures: [{ path: "/repo/value.json", reason: "unrequested" }] },
    ]) expect(evaluateResolutionHost({ ...valid, ...patch }, expected, "request", "producer")).toBe(false);
  });
  test("a requested fault and a correct returned value cannot replace the consumed fault trace", () => {
    expect(evaluateResolutionHost({ ...valid, faultsActivated: [], faultsRequested: [fault] }, expected, "request", "producer")).toBe(false);
    expect(evaluateResolutionHost({ ...valid, trace: [] }, expected, "request", "producer")).toBe(false);
    expect(evaluateResolutionHost({ ...valid, trace: [...expected.trace, { system: "configuration", operation: "read_file", path: "/repo/value.json", value: null }] }, expected, "request", "producer")).toBe(false);
  });
  test("rejects partial, reordered and substituted result rows", () => {
    for (const patch of [
      { results: [] }, { results: [...expected.results, ...expected.results] },
      { results: [{ ...expected.results[0], value: "captured" }] },
      { results: [{ ...expected.results[0], path: "/repo/other.json" }] },
      { trace: expected.trace.toReversed() },
    ]) expect(evaluateResolutionHost({ ...valid, ...patch }, expected, "request", "producer")).toBe(false);
  });
});

describe("native configured source mode acquisition", () => {
  const source = "/repo/main.mts";
  const contentId = "sha256:independent-authored-source";
  const valid = { resolutionObservations: { implied_modes: { [source]: "import" }, source_acquisition: { [source]: contentId } } };
  test("requires both the real getter mode and the exact separately ingested source", () => {
    expect(configuredSourceModeMatches(valid, source, "import", contentId)).toBe(true);
    for (const patch of [
      { implied_modes: {} }, { implied_modes: { [source]: "require" } },
      { source_acquisition: {} }, { source_acquisition: { [source]: "sha256:substituted" } },
      { source_acquisition: { [source]: contentId, "/repo/unrelated.ts": contentId } },
    ]) expect(configuredSourceModeMatches({ resolutionObservations: { ...valid.resolutionObservations, ...patch } }, source, "import", contentId)).toBe(false);
  });
  test("an explicit caller mode cannot claim the omitted-mode getter executed", () => {
    expect(configuredSourceModeMatches({ resolutionObservations: { implied_modes: {}, source_acquisition: {} } }, source, null, contentId)).toBe(true);
    expect(configuredSourceModeMatches(valid, source, null, contentId)).toBe(false);
  });
});
