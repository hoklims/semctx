import { describe, expect, it } from "bun:test";
import { canonicalReplayName, matchesProtocolPin } from "../src/pins";

describe("protocol pins", () => {
  it("accepts pinned live names", () => {
    expect(matchesProtocolPin("build-6801", "s2c.gameFightEnd")).toBe(true);
  });

  it("canonicalizes replay-safe names", () => {
    expect(canonicalReplayName(" s2c.gameFightEnd ")).toBe("s2c.gameFightEnd");
  });
});
