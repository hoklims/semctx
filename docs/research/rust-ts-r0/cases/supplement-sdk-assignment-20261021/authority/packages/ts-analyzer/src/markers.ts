/**
 * Parse explicit, machine-readable semantic markers out of a JSDoc comment.
 *
 * Markers are the ONLY way code declares semantic intent to semctx. Nothing here is
 * inferred: a capability/invariant/contract exists because the author wrote a tag.
 *
 *   @capability checkout-payment
 *   @invariant payment-applied-at-most-once: applying a payment must be idempotent
 *   @contract payment-gateway-port: charge / refund / ...
 *   @risk double-apply-on-retry: read-then-write without a guard
 *   @boundedContext payments
 *   @tag critical
 */

import { DIVERGENT_STATEMENT_TAG, compareIds, slugify } from "@semantic-context/core";
import type { MetadataValue } from "@semantic-context/core";
import type { PlaneAFact } from "@semantic-context/plane-a-internal";

export type MarkerTag = "capability" | "invariant" | "contract" | "risk" | "boundedContext" | "tag";

export interface ParsedMarker {
  tag: MarkerTag;
  slug: string;
  /** Free text after the colon, if any. Single logical line (multi-line not yet supported). */
  statement?: string;
}

const MARKER_RE =
  /@(capability|invariant|contract|risk|boundedcontext|tag)[ \t]+([A-Za-z0-9][A-Za-z0-9_-]*)[ \t]*(?::[ \t]*([^\r\n*][^\r\n]*))?/gi;

function normalizeTag(raw: string): MarkerTag {
  const lower = raw.toLowerCase();
  if (lower === "boundedcontext") return "boundedContext";
  return lower as MarkerTag;
}

/** Strip JSDoc opening, closing, and leading-asterisk framing so tags are easy to scan. */
export function stripJsDoc(comment: string): string {
  return comment
    .replace(/^\s*\/\*\*?/, "")
    .replace(/\*\/\s*$/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*[ \t]?/, "").trimEnd())
    .join("\n");
}

export function parseMarkers(commentText: string): ParsedMarker[] {
  const text = stripJsDoc(commentText);
  const markers: ParsedMarker[] = [];
  MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null = MARKER_RE.exec(text);
  while (match !== null) {
    const rawTag = match[1];
    const slug = match[2];
    if (rawTag !== undefined && slug !== undefined) {
      const statement = match[3]?.trim();
      const marker: ParsedMarker = { tag: normalizeTag(rawTag), slug };
      if (statement !== undefined && statement.length > 0) marker.statement = statement;
      markers.push(marker);
    }
    match = MARKER_RE.exec(text);
  }
  return markers;
}

/** A marker declaration with the coordinate that declared it. */
export interface MarkerDeclaration {
  tag: MarkerTag;
  slug: string;
  statement?: string;
  relPath: string;
  startLine: number;
}

export interface MarkerDivergence {
  tag: MarkerTag;
  slug: string;
  /** Every distinct statement written for this slug, sorted. */
  statements: string[];
  /** Where each divergent declaration lives, sorted by path then line. */
  declaredAt: { relPath: string; startLine: number; statement: string }[];
}

/** Marker declarations counted by tag, so coverage is a number rather than an impression. */
export interface MarkerCoverage {
  tag: MarkerTag;
  declarations: number;
  distinctSlugs: number;
  withStatement: number;
}

/**
 * The graph keys a marker node by its *canonical* slug (`slugify`, same as `capabilityId` /
 * `invariantId` / `contractId` / `riskId`): NFKD-folded, lowercased, punctuation-collapsed and
 * length-bounded. Two raw slugs that only differ in case, punctuation, accents or beyond the
 * 60-character truncation point still land on one graph node, so grouping on the raw slug would
 * miss exactly the collisions that actually reach the graph.
 */
function divergenceKey(declaration: MarkerDeclaration): string {
  return `${declaration.tag}\0${slugify(declaration.slug)}`;
}

/**
 * Find slugs declared more than once with different statements.
 *
 * The graph keys these nodes by slug, so a second declaration used to overwrite the first and the
 * disagreement disappeared. Two authors asserting different invariants under one name is a fact
 * about the repository; deciding which one is right is not something a builder may do silently.
 * Declarations that merely repeat the same statement are not a divergence.
 */
export function detectMarkerDivergence(
  declarations: readonly MarkerDeclaration[],
): MarkerDivergence[] {
  const groups = new Map<string, MarkerDeclaration[]>();
  for (const declaration of declarations) {
    if (declaration.statement === undefined) continue;
    const key = divergenceKey(declaration);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [declaration]);
    else bucket.push(declaration);
  }

  const out: MarkerDivergence[] = [];
  for (const members of groups.values()) {
    const statements = [...new Set(members.map((member) => member.statement!))].sort(compareIds);
    if (statements.length < 2) continue;
    const first = members[0]!;
    out.push({
      tag: first.tag,
      slug: first.slug,
      statements,
      declaredAt: members
        .map((member) => ({
          relPath: member.relPath,
          startLine: member.startLine,
          statement: member.statement!,
        }))
        .sort((left, right) =>
          compareIds(left.relPath, right.relPath)
          || left.startLine - right.startLine
          || compareIds(left.statement, right.statement)),
    });
  }
  return out.sort((left, right) => compareIds(left.tag, right.tag) || compareIds(left.slug, right.slug));
}

/** Aggregate declarations per tag. Deterministic order: tags sorted by name. */
export function summarizeMarkerCoverage(
  declarations: readonly MarkerDeclaration[],
): MarkerCoverage[] {
  const groups = new Map<MarkerTag, MarkerDeclaration[]>();
  for (const declaration of declarations) {
    const bucket = groups.get(declaration.tag);
    if (bucket === undefined) groups.set(declaration.tag, [declaration]);
    else bucket.push(declaration);
  }
  return [...groups.entries()]
    .map(([tag, members]) => ({
      tag,
      declarations: members.length,
      distinctSlugs: new Set(members.map((member) => member.slug)).size,
      withStatement: members.filter((member) => member.statement !== undefined).length,
    }))
    .sort((left, right) => compareIds(left.tag, right.tag));
}

/** Node id prefix each statement-bearing marker tag maps to in the repository graph. */
const NODE_ID_PREFIX: Partial<Record<MarkerTag, string>> = {
  capability: "cap:",
  invariant: "inv:",
  contract: "contract:",
  risk: "risk:",
};

/**
 * Strip the arbitrarily-chosen statement from every divergent marker node and mark it.
 *
 * This is a *degradation*, not a repair: semctx does not know which author is right and must not
 * decide. Removing the statement means nothing downstream can quote one side as though it were the
 * declaration, and the tag means every surface that could grant authority — claim construction
 * above all — can see that the slug is contested rather than merely unstated.
 */
export function degradeDivergentMarkerNodes(
  nodes: Iterable<{ id: string; tags: string[]; metadata: Record<string, string | number | boolean> }>,
  divergences: readonly MarkerDivergence[],
): void {
  if (divergences.length === 0) return;
  const contested = new Set<string>();
  for (const divergence of divergences) {
    const prefix = NODE_ID_PREFIX[divergence.tag];
    if (prefix === undefined) continue;
    contested.add(`${prefix}${slugify(divergence.slug)}`);
  }
  if (contested.size === 0) return;
  for (const node of nodes) {
    if (!contested.has(node.id)) continue;
    delete node.metadata["statement"];
    if (!node.tags.includes(DIVERGENT_STATEMENT_TAG)) {
      node.tags.push(DIVERGENT_STATEMENT_TAG);
      node.tags.sort(compareIds);
    }
  }
}

/**
 * Same degradation as {@link degradeDivergentMarkerNodes}, applied to a raw fact log instead of an
 * assembled graph.
 *
 * A producer that has not yet reached `DeterministicGraphAssembler.build()` — because, for example,
 * a fact it references (the repository node) lives in another producer's scope and would fail
 * `MISSING_ENDPOINT` in isolation — still has recorded `NodeFact`s it can degrade before handing
 * them to whatever assembler eventually composes every producer together.
 */
export function degradeDivergentPlaneAFacts(
  facts: readonly PlaneAFact[],
  divergences: readonly MarkerDivergence[],
): PlaneAFact[] {
  if (divergences.length === 0) return [...facts];
  const degraded = new Map<string, { id: string; tags: string[]; metadata: Record<string, MetadataValue> }>();
  for (const fact of facts) {
    if (fact.factType !== "node" || degraded.has(fact.id)) continue;
    degraded.set(fact.id, { id: fact.id, tags: [...fact.tags], metadata: { ...fact.metadata } });
  }
  degradeDivergentMarkerNodes(degraded.values(), divergences);
  return facts.map((fact) => {
    if (fact.factType !== "node") return fact;
    const patched = degraded.get(fact.id);
    if (patched === undefined) return fact;
    return { ...fact, tags: patched.tags, metadata: patched.metadata };
  });
}
