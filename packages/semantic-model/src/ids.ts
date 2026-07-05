/**
 * Deterministic identifiers for authored semantic nodes.
 *
 * A semantic id is the authored, already-namespaced label (`goal.checkout.reliable-payment`).
 * These helpers validate the id shape, infer a node kind from its prefix, and infer how a
 * `RepositoryLink` should resolve from its `ref` prefix. No randomness, no timestamps.
 */

import { slugify } from "@semantic-context/core";
import type { SemanticNodeKind, RepositoryLink, RepositoryLinkKind } from "./types";

/** Canonical id prefix per node kind. Evidence also accepts the `proof.` alias on input. */
export const SEMANTIC_ID_PREFIX: Record<SemanticNodeKind, string> = {
  goal: "goal.",
  invariant: "invariant.",
  decision: "decision.",
  assumption: "assumption.",
  unknown: "unknown.",
  change: "change.",
  evidence: "evidence.",
};

/** Alias prefixes accepted on input and normalised to a canonical kind. */
const ALIAS_PREFIX: Record<string, SemanticNodeKind> = { "proof.": "evidence" };

const ID_BODY_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** Infer the node kind from an id prefix, honouring aliases. Undefined when no prefix matches. */
export function kindOfSemanticId(id: string): SemanticNodeKind | undefined {
  for (const [kind, prefix] of Object.entries(SEMANTIC_ID_PREFIX) as [SemanticNodeKind, string][]) {
    if (id.startsWith(prefix)) return kind;
  }
  for (const [prefix, kind] of Object.entries(ALIAS_PREFIX)) {
    if (id.startsWith(prefix)) return kind;
  }
  return undefined;
}

/** True when `id` carries the expected prefix for `kind` and a well-formed dotted-slug body. */
export function isValidSemanticId(kind: SemanticNodeKind, id: string): boolean {
  const inferred = kindOfSemanticId(id);
  if (inferred !== kind) return false;
  const prefix = matchedPrefix(id);
  if (prefix === undefined) return false;
  return ID_BODY_RE.test(id.slice(prefix.length));
}

function matchedPrefix(id: string): string | undefined {
  if (id.startsWith(SEMANTIC_ID_PREFIX.evidence) || id.startsWith("proof.")) {
    return id.startsWith("proof.") ? "proof." : SEMANTIC_ID_PREFIX.evidence;
  }
  for (const prefix of Object.values(SEMANTIC_ID_PREFIX)) if (id.startsWith(prefix)) return prefix;
  return undefined;
}

/**
 * Build a canonical semantic id from a kind and a free label. Idempotent when the label is already
 * a valid id. Segments are slugged individually so dots survive as separators.
 */
export function semanticId(kind: SemanticNodeKind, label: string): string {
  const prefix = SEMANTIC_ID_PREFIX[kind];
  const withoutPrefix = label.startsWith(prefix) ? label.slice(prefix.length) : label;
  const body = withoutPrefix
    .split(".")
    .map((segment) => slugify(segment))
    .filter((segment) => segment !== "empty" && segment.length > 0)
    .join(".");
  return `${prefix}${body.length > 0 ? body : "unnamed"}`;
}

/** Repository-link id prefixes → link kind (Plane A id namespaces from `@semantic-context/core`). */
const LINK_PREFIX: Array<[string, RepositoryLinkKind]> = [
  ["sym:", "symbol"],
  ["inv:", "invariant"],
  ["contract:", "contract"],
  ["cap:", "capability"],
  ["test:", "test"],
  ["mig:", "migration"],
  ["claim:", "claim"],
  ["ev:", "evidence"],
];

/**
 * Build a `RepositoryLink` from a raw `ref`, inferring the kind from a Plane-A id prefix. A `file:`
 * prefix (stripped) or any unprefixed value is treated as a repo-relative file path.
 */
export function repositoryLinkFromRef(ref: string): RepositoryLink {
  const trimmed = ref.trim();
  if (trimmed.startsWith("file:")) return { kind: "file", ref: trimmed.slice("file:".length) };
  for (const [prefix, kind] of LINK_PREFIX) {
    if (trimmed.startsWith(prefix)) return { kind, ref: trimmed };
  }
  return { kind: "file", ref: trimmed };
}

/** Render a `RepositoryLink` back to its canonical `.sem` `link:` value. */
export function repositoryLinkToRef(link: RepositoryLink): string {
  return link.kind === "file" ? `file:${link.ref}` : link.ref;
}
