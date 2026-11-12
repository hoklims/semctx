import { expect, test } from "bun:test";
import { ownerObservationMatches } from "./t00-lot3-owner";

const clear = { reasons: [], executed: true, unsupported: [] };
const refused = { ...clear, reasons: ["SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"] };
const expected = { beforeAnalysis: refused, afterAnalysis: clear, afterGraphEdgesRemoved: refused, semanticReasons: [] };
const observed = { opaqueCallbackOwnership: { executed: true, unsupported: [], ...expected }, semanticObservation: clear };

test("owner comparison requires complete executed phases and exact independent reasons", () => {
  expect(ownerObservationMatches(expected, observed)).toBe(true);
  expect(ownerObservationMatches(expected, {})).toBe(false);
  expect(ownerObservationMatches(expected, { ...observed, semanticObservation: { executed: true, unsupported: [] } })).toBe(false);
  expect(ownerObservationMatches(expected, { ...observed, opaqueCallbackOwnership: { ...observed.opaqueCallbackOwnership, afterAnalysis: { executed: true, unsupported: [] } } })).toBe(false);
  expect(ownerObservationMatches(expected, { ...observed, semanticObservation: { ...clear, executed: false } })).toBe(false);
  expect(ownerObservationMatches(expected, { ...observed, semanticObservation: refused })).toBe(false);
  expect(ownerObservationMatches(expected, { ...observed, opaqueCallbackOwnership: { ...observed.opaqueCallbackOwnership, afterGraphEdgesRemoved: clear } })).toBe(false);
  expect(ownerObservationMatches(expected, { ...observed, opaqueCallbackOwnership: { ...observed.opaqueCallbackOwnership, unsupported: ["not-run"] } })).toBe(false);
});
