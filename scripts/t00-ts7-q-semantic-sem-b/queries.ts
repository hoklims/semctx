import { createHash } from "node:crypto";
import { record } from "../t00-ts7-q-semantic-core";
import type { ContractProjection } from "../t00-ts7-q-semantic-contract-projector";

const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];

export function batchSdkSyntax(projection: ContractProjection, oracle: unknown, path: string): ContractProjection {
  if (projection.status === "projected" || !projection.queries?.length) return projection;
  const requestedFiles = new Set(projection.queries.filter(query => query.operation === "node").map(query => record(record(query.route)["anchor"])["path"]).filter(file => typeof file === "string" && file.startsWith("/sdk/lib/")));
  if (requestedFiles.size === 0) return projection;
  const file = records(record(oracle)["files"]).find(file => file["path"] === path);
  const nodes = records(record(file?.["factsGraph"])["nodes"]);
  const key = (anchor: Record<string, unknown>): string => JSON.stringify([anchor["path"], anchor["kind"], anchor["start"], anchor["end"]]);
  const captured = new Set(nodes.map(node => key(record(node["anchor"] ?? node))));
  const queries = [...projection.queries];
  const seen = new Set(queries.map(query => query.id));
  for (const node of nodes) {
    if (!requestedFiles.has(node["path"])) continue;
    for (const child of records(node["children"])) {
      const anchor = record(child["anchor"] ?? child);
      if (!requestedFiles.has(anchor["path"]) || typeof anchor["kind"] !== "string" || !Number.isSafeInteger(anchor["start"]) || !Number.isSafeInteger(anchor["end"]) || Number(anchor["start"]) < 0 || Number(anchor["end"]) < Number(anchor["start"]) || captured.has(key(anchor))) continue;
      const payload = { file: path, route: { anchor, steps: [] }, operation: "node" as const };
      const id = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      if (seen.has(id)) continue;
      seen.add(id);
      queries.push({ id, ...payload });
      if (queries.length >= projection.queries.length + 64) return { ...projection, queries };
    }
  }
  return { ...projection, queries };
}
