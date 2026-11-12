import { readAt } from "./t00-ts7-q-syntax-core.js";

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((entry: unknown) => entry === null || typeof entry !== "object" || Array.isArray(entry)))
    throw new Error("graph collection must contain objects");
  return value as Record<string, unknown>[];
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("graph coordinate must be text");
  return value;
}

export function logicalCallEdges(value: unknown): unknown[] {
  const nodes = records(readAt(value, ["nodes"]));
  const symbols = records(readAt(value, ["symbols"]));
  const edges = records(readAt(value, ["edges"]));
  const coordinate = (id: unknown): Record<string, unknown> => {
    const key = text(id);
    const matches = nodes.filter(node => node.id === key);
    if (matches.length !== 1) throw new Error("graph endpoint must identify one node");
    const node = matches[0]!;
    const path = text(node.filePath);
    if (node.kind === "module") return { path, module_node: true };
    if (node.kind === "test") return { path, test_node: true };
    const owners = symbols.filter(symbol => symbol.id === key);
    if (owners.length !== 1) throw new Error("graph endpoint must identify one symbol");
    const symbol = owners[0]!;
    if (!Array.isArray(symbol.scope)) throw new Error("symbol scope must be array");
    const names = (symbol.scope as unknown[]).map(text);
    return { path, symbol_path: [...names, text(symbol.name)].join(".") };
  };
  return edges.filter(edge => text(edge.kind) === "calls")
    .map(edge => ({ kind: "calls", from: coordinate(edge.from), to: coordinate(edge.to) }))
    .sort((left, right) => {
      const a = JSON.stringify(left); const b = JSON.stringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
}
