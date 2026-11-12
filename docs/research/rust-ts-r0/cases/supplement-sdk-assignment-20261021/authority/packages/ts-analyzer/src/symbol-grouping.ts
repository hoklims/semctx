/**
 * Fold extracted declarations into the logical symbols a reader would name.
 *
 * Three TypeScript declarations can be one function (an overload set), and two declarations that
 * share a name and a scope path can still be two functions (block-scoped duplicates). Identity is
 * decided here, once, so the graph builder never has to guess — and so the rule is testable without
 * standing up a repository.
 */

import { compareIds, symbolId } from "@semantic-context/core";
import type { ExtractedSymbol } from "./ts-symbols";
import type { ParsedMarker } from "./markers";

export interface SymbolDeclarationRange {
  startLine: number;
  endLine: number;
}

/**
 * A marker together with the declaration that actually carried it.
 *
 * Grouping merges identity, never proof: an overload set is one symbol, but a marker written on its
 * third signature was written on its third signature. Attributing the whole group's markers to its
 * first declaration sends an author to a line that carries nothing, and makes a divergence report
 * name one coordinate twice instead of the two that disagree.
 */
export interface SymbolMarkerDeclaration extends ParsedMarker {
  /** The `startLine` of the contributing declaration whose doc comment held this marker. */
  startLine: number;
}

export interface LogicalSymbol {
  id: string;
  name: string;
  kind: ExtractedSymbol["kind"];
  relPath: string;
  scope: string[];
  exported: boolean;
  /**
   * Every declaration that contributes to this symbol, in source order. An overload set keeps all
   * of its signatures here: grouping merges identity, never proof.
   */
  declarations: SymbolDeclarationRange[];
  /** In source order, each keeping the coordinate of the declaration that carried it. */
  markers: SymbolMarkerDeclaration[];
  jsdoc?: string;
}

function groupKey(symbol: ExtractedSymbol): string {
  return [symbol.kind, symbol.relPath, symbol.scope.join("."), symbol.name].join("\0");
}

function markerKey(marker: ParsedMarker): string {
  return [marker.tag, marker.slug, marker.statement ?? ""].join("\0");
}

function byPosition(left: ExtractedSymbol, right: ExtractedSymbol): number {
  return left.startLine - right.startLine || left.endLine - right.endLine;
}

/**
 * Distinct declarations, not an overload set.
 *
 * An overload set has exactly one member carrying an implementation. Two or more implementations
 * under one key means two functions that merely share a scope path — legal in nested blocks — and
 * merging them would attach one function's evidence to the other.
 */
function isCollision(members: readonly ExtractedSymbol[]): boolean {
  if (members.length < 2) return false;
  if (members[0]!.kind !== "function") return false;
  return members.filter((member) => member.signatureOnly !== true).length > 1;
}

function fold(
  members: readonly ExtractedSymbol[],
  id: string,
): LogicalSymbol {
  const first = members[0]!;
  const markers: SymbolMarkerDeclaration[] = [];
  const seenMarkers = new Set<string>();
  for (const member of members) {
    for (const marker of member.markers) {
      // The declaring line is part of the key. Two signatures of one overload set repeating the same
      // marker are two declarations a human wrote in two places, and collapsing them on text alone
      // under-counted coverage and left the second coordinate unreachable. Only a marker repeated at
      // *one* coordinate is dropped, because nothing downstream could tell those two apart.
      const key = `${markerKey(marker)}\0${member.startLine}`;
      if (seenMarkers.has(key)) continue;
      seenMarkers.add(key);
      markers.push({ ...marker, startLine: member.startLine });
    }
  }
  const jsdoc = members.find((member) => member.jsdoc !== undefined)?.jsdoc;
  return {
    id,
    name: first.name,
    kind: first.kind,
    relPath: first.relPath,
    scope: [...first.scope],
    exported: members.some((member) => member.exported),
    declarations: members.map((member) => ({ startLine: member.startLine, endLine: member.endLine })),
    markers,
    ...(jsdoc !== undefined ? { jsdoc } : {}),
  };
}

/**
 * Group declarations into logical symbols, sorted by id.
 *
 * The ordinal suffix in the collision branch is the one place position leaks back into an id, and
 * it is therefore the one place identity cannot be promised. Two same-named declarations that each
 * carry a body are told apart only by source order, so inserting a third or swapping two moves
 * every ordinal after it.
 *
 * Two rules keep that from turning into a silent rebinding. **No member keeps the bare id**: the
 * unqualified coordinate stays unowned, so an anchor written against it resolves to "several, pick
 * one" instead of to whichever declaration happens to come first today. And every ordinal-bearing
 * id is refused by the resolver as an address, so it can serve as a graph fact — where the evidence
 * for each body is — without ever serving as a durable reference.
 *
 * Overload sets are unaffected: they are one logical symbol, they keep the bare id, and every
 * signature's range stays on the node.
 */
export function groupSymbols(symbols: readonly ExtractedSymbol[]): LogicalSymbol[] {
  const groups = new Map<string, ExtractedSymbol[]>();
  for (const symbol of symbols) {
    const key = groupKey(symbol);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [symbol]);
    else bucket.push(symbol);
  }

  const out: LogicalSymbol[] = [];
  for (const members of groups.values()) {
    const ordered = [...members].sort(byPosition);
    const first = ordered[0]!;
    const baseId = symbolId(first.kind, first.relPath, first.name, first.scope);
    if (!isCollision(ordered)) {
      out.push(fold(ordered, baseId));
      continue;
    }
    ordered.forEach((member, index) => {
      out.push(fold([member], `${baseId}#${index + 1}`));
    });
  }
  return out.sort((left, right) => compareIds(left.id, right.id));
}
