import { expect, test } from "bun:test";
import { compareResolution } from "./t00-lot3-resolution";

const identity = { request: "request", sdk: "sdk", producer: "producer" };
const observed = { executed: true, unsupported: [], resolved_file_name: "/repo/a.ts", native_error: null, native_diagnostics: [], request_descriptor_id: "request", sdk_input_id: "sdk", producer_artifact_id: "producer", configuration: { executed: true, unsupported: [] } };

test("resolution evidence requires the complete owning result and executed bound native context", () => {
  expect(compareResolution(observed, "/repo/a.ts", identity)).toBe(true);
  expect(compareResolution(observed, "/repo/b.ts", identity)).toBe(false);
  expect(compareResolution({ ...observed, executed: false }, "/repo/a.ts", identity)).toBe(false);
  expect(compareResolution({ ...observed, unsupported: ["missing"] }, "/repo/a.ts", identity)).toBe(false);
  expect(compareResolution({ ...observed, native_error: "failed" }, "/repo/a.ts", identity)).toBe(false);
  expect(compareResolution({ ...observed, native_diagnostics: [{}] }, "/repo/a.ts", identity)).toBe(false);
  expect(compareResolution({ ...observed, configuration: { executed: false, unsupported: [] } }, "/repo/a.ts", identity)).toBe(false);
  expect(compareResolution({ ...observed, request_descriptor_id: "foreign" }, "/repo/a.ts", identity)).toBe(false);
  expect(compareResolution({ ...observed, sdk_input_id: "foreign" }, "/repo/a.ts", identity)).toBe(false);
  expect(compareResolution({ ...observed, producer_artifact_id: "foreign" }, "/repo/a.ts", identity)).toBe(false);
  expect(compareResolution({}, null, identity)).toBe(false);
});
