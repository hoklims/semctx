/** Server message names the live client is allowed to act on, keyed by protocol build. */
export const LIVE_PINS: Readonly<Record<string, readonly string[]>> = {
  "build-6801": ["s2c.gameFightTurnStart", "s2c.gameActionFight", "s2c.gameFightEnd"],
};

/**
 * Live gate: a server message is actionable only when the pinned build lists it.
 *
 * @invariant live-pins-are-authoritative: the live client never acts on a message name absent from the pinned build
 */
export function matchesProtocolPin(build: string, name: string): boolean {
  return (LIVE_PINS[build] ?? []).includes(name);
}

/** Replay-only keys: recorded server frames that analysis tools may canonicalize. */
const REPLAY_SAFE_KEYS = [
  "s2c.gameFightTurnStart",
  "s2c.completedAchievements",
  "s2c.gameFightEnd",
] as const;

export function isReplaySafe(name: string): boolean {
  return (REPLAY_SAFE_KEYS as readonly string[]).includes(name);
}

/**
 * Replay adapter: map a recorded frame name to the canonical name used by analysis scripts.
 *
 * @invariant replay-never-feeds-live: replay canonicalization is consumed by analysis tools only, never by the live client
 */
export function canonicalReplayName(recorded: string): string | undefined {
  const name = recorded.trim();
  if (!isReplaySafe(name)) return undefined;
  return name;
}
