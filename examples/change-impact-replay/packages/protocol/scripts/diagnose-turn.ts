import { canonicalReplayName } from "../src/pins";

/** Analysis-only: summarize the recorded frames of one turn. */
export function diagnoseTurn(frames: readonly string[]): string[] {
  return frames.map((frame) => canonicalReplayName(frame) ?? "(unknown)");
}

diagnoseTurn(["s2c.gameFightTurnStart"]);
