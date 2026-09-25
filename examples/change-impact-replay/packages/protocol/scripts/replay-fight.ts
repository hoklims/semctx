import { canonicalReplayName } from "../src/pins";

/** Replay a recorded fight for offline inspection. */
export function replayFight(frames: readonly string[]): number {
  return frames.filter((frame) => canonicalReplayName(frame) !== undefined).length;
}
