import { expect, test } from "bun:test";
import { compareLiveConfigurationDiscovery } from "./t00-ts7-q-config-diag-boundaries";

const expected = [{ path: "/root/child/tsconfig.json", found: false }, { path: "/root/tsconfig.json", found: true }];
const observed = { executed: true, profile: "live_configuration", error: null, reasons: [], read_errors: {}, probes: expected.map(probe => ({ ...probe, operation: "configuration_discovery_file_exists" })) };

test("accepts the exact live ancestor search ending at its governing configuration", () => {
  expect(compareLiveConfigurationDiscovery(observed, expected, [], "/root/child/main.ts")).toBe(true);
});

test("a missing negative ancestor or an extra fallback search fails discovery evidence", () => {
  expect(compareLiveConfigurationDiscovery({ ...observed, probes: observed.probes.slice(1) }, expected, [], "/root/child/main.ts")).toBe(false);
  expect(compareLiveConfigurationDiscovery({ ...observed, probes: [...observed.probes, { operation: "configuration_discovery_file_exists", path: "/tsconfig.json", found: false }] }, expected, [], "/root/child/main.ts")).toBe(false);
});

test("captured selection, undeclared read errors and a read of an omitted source cannot prove the live source-free branch", () => {
  expect(compareLiveConfigurationDiscovery({ ...observed, profile: "captured" }, expected, [], "/root/child/main.ts")).toBe(false);
  expect(compareLiveConfigurationDiscovery({ ...observed, read_errors: { "/root/tsconfig.json": "failure" } }, expected, [], "/root/child/main.ts")).toBe(false);
  expect(compareLiveConfigurationDiscovery({ ...observed, probes: [...observed.probes, { operation: "read_file", path: "/root/child/main.ts", found: true }] }, expected, [], "/root/child/main.ts")).toBe(false);
});
