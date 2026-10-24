import { expect, test } from "bun:test";
import { parseCampaignArguments } from "./t00-ts7-q-boundary-campaign";

const args = ["--candidate", "/tmp/candidate.json", "--platform", "macos", "--out", "/tmp/out"];
test("boundary selection rejects empty, duplicate, foreign and malformed obligations", () => {
  for (const indices of ["", "0,0", "999", "0,,1", "-1", "1.5", "01"]) {
    expect(() => parseCampaignArguments([...args, "--indices", indices])).toThrow();
  }
  expect(() => parseCampaignArguments([...args, "--indices", "0", "--indices", "1"])).toThrow();
  expect(parseCampaignArguments([...args, "--indices", "0,1,232,233,234,236,237,238"]).indices).toEqual([0, 1, 232, 233, 234, 236, 237, 238]);
  expect(parseCampaignArguments(args).indices.length).toBeGreaterThan(8);
});
