import { describe, expect, test } from "bun:test";
import { compareLiveConfigurationObservation } from "./t00-ts7-q-config-live";

const expectation = { reasons: ["SOURCE_CONFIGURATION_INVALID:5083:Cannot read file '/repo/tsconfig.json'."], inputs: { "/repo/tsconfig.json": null }, forbiddenReads: ["/outside.json"] };
const valid = { profile: "live_configuration", executed: true, error: null, reasons: expectation.reasons, inputs: expectation.inputs, probes: [{ operation: "read_file", path: "/repo/tsconfig.json", found: false, content_id: null }], global_admission_inferred: false };

describe("live configuration witness comparison", () => {
  test("requires an attributed undefined read and the complete native diagnostic", () => {
    expect(compareLiveConfigurationObservation(valid, expectation)).toBe(true);
    expect(compareLiveConfigurationObservation({ ...valid, inputs: {} }, expectation)).toBe(false);
    expect(compareLiveConfigurationObservation({ ...valid, reasons: [] }, expectation)).toBe(false);
    expect(compareLiveConfigurationObservation({ ...valid, error: "configuration disappeared from capture" }, expectation)).toBe(false);
    expect(compareLiveConfigurationObservation(valid, { ...expectation, discoveredConfiguration: "/repo/tsconfig.json" })).toBe(false);
    expect(compareLiveConfigurationObservation({ ...valid, probes: [...valid.probes, { operation: "configuration_discovery_file_exists", path: "/repo/tsconfig.json", found: true, content_id: null }] }, { ...expectation, discoveredConfiguration: "/repo/tsconfig.json" })).toBe(true);
  });
  test("refuses delegation beyond the configuration boundary", () => {
    expect(compareLiveConfigurationObservation({ ...valid, inputs: { ...valid.inputs, "/outside.json": "secret" } }, expectation)).toBe(false);
    expect(compareLiveConfigurationObservation({ ...valid, executed: false }, expectation)).toBe(false);
    expect(compareLiveConfigurationObservation({ ...valid, global_admission_inferred: true }, expectation)).toBe(false);
    expect(compareLiveConfigurationObservation({ ...valid, profile: "retained" }, expectation)).toBe(false);
  });
  test("binds successful read bytes rather than a found flag alone", () => {
    const expected = { reasons: [], inputs: { "/repo/tsconfig.json": "{}" }, forbiddenReads: [] };
    const probe = { operation: "read_file", path: "/repo/tsconfig.json", found: true, content_id: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" };
    const observed = { ...valid, reasons: [], inputs: expected.inputs, probes: [probe] };
    expect(compareLiveConfigurationObservation(observed, expected)).toBe(true);
    expect(compareLiveConfigurationObservation({ ...observed, probes: [{ ...probe, content_id: null }] }, expected)).toBe(false);
    expect(compareLiveConfigurationObservation({ ...observed, probes: [{ ...probe, content_id: "sha256:wrong" }] }, expected)).toBe(false);
  });
  test("preserves input spelling while matching native insensitive probe keys", () => {
    const expected = { reasons: expectation.reasons, inputs: { "/Repo/tsconfig.json": null }, forbiddenReads: [], caseSensitive: false };
    const observed = { ...valid, inputs: expected.inputs };
    expect(compareLiveConfigurationObservation(observed, expected)).toBe(true);
    expect(compareLiveConfigurationObservation({ ...observed, inputs: { "/repo/tsconfig.json": null } }, expected)).toBe(false);
  });
  test("requires content and undefined probes to agree with attributed inputs", () => {
    expect(compareLiveConfigurationObservation({ ...valid, probes: [] }, expectation)).toBe(false);
    expect(compareLiveConfigurationObservation({ ...valid, probes: [{ ...valid.probes[0], found: true }] }, expectation)).toBe(false);
  });
});
