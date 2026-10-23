import { expect, test } from "bun:test";
import { receiverAccepted } from "./t00-ts7-q-boundary-identity-runtime";

test("receiver controls require actual analyzed acceptance and refuse absent or contradictory evidence", () => {
  expect(receiverAccepted({})).toBe(false);
  expect(receiverAccepted({ accepted: false, rejection: "IdentityMismatch" })).toBe(false);
  expect(receiverAccepted({ accepted: true, disposition: "Analyzed", rejection: "IdentityMismatch" })).toBe(false);
  expect(receiverAccepted({ accepted: true, disposition: "Analyzed", rejection: null })).toBe(true);
});
