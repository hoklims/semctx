import { expect, test } from "bun:test";
import { compareOpaquePhases, validateOpaqueCampaign } from "./t00-lot1-opaque";

const source = { beforeAnalysis: ["SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"], afterAnalysis: [], afterGraphEdgesRemoved: ["SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"] };
const native = { executed: true, unsupported: [], ...Object.fromEntries(Object.entries(source).map(([key, reasons]) => [key, { executed: true, unsupported: [], reasons }])) };

test("compares every observed ownership phase against the independent oracle", () => {
  expect(compareOpaquePhases(source, native)).toEqual({ compared: 3, pass: true, differences: [] });
});

test("cannot pass with missing, empty, skipped or unsupported component observations", () => {
  for (const value of [undefined, {}, { ...native, executed: false }, { ...native, unsupported: ["missing"] }, { ...native, afterAnalysis: undefined }, { ...native, beforeAnalysis: { executed: true, unsupported: [], reasons: [] } }]) {
    expect(compareOpaquePhases(source, value).pass).toBe(false);
  }
});

test("cannot hide an extra or missing reason in any ownership phase", () => {
  for (const phase of Object.keys(source)) {
    const altered = { ...native, [phase]: { executed: true, unsupported: [], reasons: ["unexpected"] } };
    expect(compareOpaquePhases(source, altered)).toMatchObject({ compared: 3, pass: false });
  }
});

test("requires the exact unique fixture set and an activated ownership refusal restored after edge removal", () => {
  const expected = ["inline-call", "returned-value", "constant-return", "unknown-return"].map(id => ({ id, phases: id === "inline-call" ? source : { beforeAnalysis: ["SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"], afterAnalysis: ["SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"], afterGraphEdgesRemoved: ["SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"] } }));
  expect(() => validateOpaqueCampaign(expected)).not.toThrow();
  expect(() => validateOpaqueCampaign([])).toThrow();
  expect(() => validateOpaqueCampaign([...expected, expected[0]])).toThrow();
  expect(() => validateOpaqueCampaign(expected.map(unit => ({ ...unit, phases: { beforeAnalysis: [], afterAnalysis: [], afterGraphEdgesRemoved: [] } })))).toThrow();
});
