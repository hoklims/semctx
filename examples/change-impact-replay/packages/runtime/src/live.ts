import { matchesProtocolPin } from "../../protocol/src/pins";

/** Live runtime: act on a server message only when the pinned build allows it. */
export function runLiveFight(build: string, incoming: readonly string[]): string[] {
  return incoming.filter((name) => matchesProtocolPin(build, name));
}
