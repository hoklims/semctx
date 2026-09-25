import { runLiveFight } from "./live";

export function orchestrate(build: string, incoming: readonly string[]): number {
  return runLiveFight(build, incoming).length;
}
