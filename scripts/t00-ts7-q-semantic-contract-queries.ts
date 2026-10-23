import { record } from "./t00-ts7-q-semantic-core";

type Projection = { status: "projected" | "unsupported"; gaps: string[]; queries?: unknown[] };

export function resolveContractQueries<T extends Projection>(initial: unknown, project: (oracle: unknown) => T, capture: (queries: unknown[], round: number) => unknown): { oracle: unknown; projection: T; rounds: number } {
  let oracle = initial;
  let projection = project(oracle);
  const requested = new Map<string, unknown>();
  for (let round = 1; round < 64; round += 1) {
    if (projection.status === "projected" || !projection.queries?.length) return { oracle, projection, rounds: round };
    for (const query of projection.queries) {
      const id = record(query)["id"];
      const gap = typeof id !== "string" || id.length === 0 ? "NATIVE_QUERY_INVALID_ID"
        : requested.has(id) ? `${JSON.stringify(requested.get(id)) === JSON.stringify(query) ? "NATIVE_QUERY_NO_PROGRESS" : "NATIVE_QUERY_ID_CONFLICT"}:${id}` : undefined;
      if (gap !== undefined) return { oracle, projection: { ...projection, status: "unsupported", gaps: [...projection.gaps, gap] }, rounds: round };
      requested.set(id as string, query);
    }
    oracle = capture([...requested.values()], round);
    projection = project(oracle);
  }
  return { oracle, projection: projection.status === "projected" ? projection : { ...projection, gaps: [...projection.gaps, "NATIVE_QUERY_ROUND_LIMIT:64"] }, rounds: 64 };
}
