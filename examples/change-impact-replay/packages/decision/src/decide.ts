import { LIVE_PINS } from "../../protocol/src/pins";

/** Decision engine: choose an action among the messages the pinned build exposes. */
export function decideAction(build: string): string | undefined {
  return (LIVE_PINS[build] ?? [])[0];
}
