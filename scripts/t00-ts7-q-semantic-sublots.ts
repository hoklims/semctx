import * as a from "./t00-ts7-q-semantic-sem-a";
import * as b from "./t00-ts7-q-semantic-sem-b";
import * as c from "./t00-ts7-q-semantic-sem-c";
import { semanticSublotIndices, type SemanticSublotName } from "./t00-ts7-q-semantic-sublot-scope";

export const semanticSublots = { a, b, c };

export function semanticSublotFor(index: number) {
  return (Object.keys(semanticSublotIndices) as SemanticSublotName[]).map(name => ({ name, indices: semanticSublotIndices[name], ...semanticSublots[name] })).find(sublot => (sublot.indices as readonly number[]).includes(index));
}

export function selectSemanticSublot<T extends { index: number }>(rows: T[], name: string): T[] {
  if (!Object.hasOwn(semanticSublotIndices, name)) throw Error("INVALID_SEMANTIC_SUBLOT");
  const indices: readonly number[] = semanticSublotIndices[name as SemanticSublotName];
  const selected = rows.filter(row => indices.includes(row.index));
  if (selected.length !== indices.length || new Set(selected.map(row => row.index)).size !== indices.length) throw Error("SEMANTIC_SUBLOT_INVENTORY_INCOMPLETE");
  return selected;
}
