/**
 * Deterministic, human-readable identifier helpers.
 *
 * Every id is a pure function of its inputs: no randomness, no timestamps, no
 * process state. Two runs over identical source produce identical ids. This is a
 * hard requirement so that graphs, claims and context packs diff and cache cleanly.
 */

/** Normalise a path to forward slashes and strip a leading "./". */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Lowercase kebab slug, ASCII-folded, bounded length. Stable for a given input. */
export function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .normalize("NFKD")
    // The control-code lower bound is intentional: retain all ASCII before slug normalization.
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base.slice(0, 60) : "empty";
}

/**
 * Deterministic tie-breaker for stable ordering. Compares by UTF-16 code unit
 * (like SQLite's default BINARY collation), NOT `localeCompare` — the latter is
 * locale/ICU-dependent and would break byte-identical output across environments.
 * Returns -1/0/1 so it composes with a primary key via `||`.
 */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** FNV-1a 32-bit hash as zero-padded hex. Disambiguates long or opaque keys. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function repositoryId(root: string): string {
  const leaf = root.split(/[\\/]/).filter(Boolean).pop() ?? "repository";
  return `repo:${slugify(leaf)}`;
}

export function moduleId(relPath: string): string {
  return `mod:${normalizePath(relPath)}`;
}

/**
 * Identify a symbol by what it *is*, never by where it currently sits.
 *
 * `scope` names the enclosing declarations, outermost first, so two homonyms in different scopes
 * stay distinct without a line number arbitrating between them. A start line used to occupy that
 * role, which meant inserting a comment above a function renamed it and every anchor pointing at it
 * reported the symbol as gone. Line ranges survive as evidence on the node; they no longer decide
 * identity.
 *
 * The result has exactly four `:`-separated fields, which is how a legacy five-field id (whose last
 * field is a start line) stays mechanically distinguishable — see `parseLegacySymbolId`.
 */
export function symbolId(
  kind: string,
  relPath: string,
  name: string,
  scope?: readonly string[],
): string;
/**
 * Pre-HOK-79 compatibility overload: a caller still passing the old positional `startLine`
 * is accepted and the line is explicitly ignored, so it produces the same canonical
 * (scope-empty) id as calling with no fourth argument at all — never a line-bearing id.
 */
export function symbolId(kind: string, relPath: string, name: string, startLine: number): string;
export function symbolId(
  kind: string,
  relPath: string,
  name: string,
  scopeOrStartLine: readonly string[] | number = [],
): string {
  const scope = typeof scopeOrStartLine === "number" ? [] : scopeOrStartLine;
  return `sym:${kind}:${normalizePath(relPath)}:${[...scope, name].join(".")}`;
}

export interface ParsedSymbolId {
  kind: string;
  relPath: string;
  /** Enclosing declarations, outermost first. Empty for a file-scoped symbol. */
  scope: string[];
  /** Declared name, with any `#N` collision disambiguator stripped. */
  name: string;
  /**
   * Present only for the second and later members of a genuine collision — two same-named function
   * declarations that each carry a body, which nested blocks permit. Kept out of `name` so that a
   * lookup by name finds *every* member: an anchor that could mean either of them must read as
   * ambiguous, not silently resolve to the one that happens to hold the bare id.
   */
  ordinal?: number;
}

/** The scope-qualified tail of a canonical symbol id (`outer.helper`), without re-deriving it. */
export function symbolScopePath(scope: readonly string[], name: string): string {
  return [...scope, name].join(".");
}

/** Parse a canonical (line-free) symbol id. Undefined for anything else, legacy ids included. */
export function parseSymbolId(id: string): ParsedSymbolId | undefined {
  const parts = id.split(":");
  if (parts.length !== 4 || parts[0] !== "sym") return undefined;
  const [, kind, relPath, qualified] = parts as [string, string, string, string];
  if (kind.length === 0 || relPath.length === 0 || qualified.length === 0) return undefined;
  const segments = qualified.split(".");
  const last = segments[segments.length - 1];
  if (last === undefined || last.length === 0) return undefined;
  const collision = /^(.+)#(\d+)$/.exec(last);
  const name = collision?.[1] ?? last;
  if (name.length === 0) return undefined;
  const ordinal = collision === null ? undefined : Number.parseInt(collision[2]!, 10);
  return {
    kind,
    relPath,
    scope: segments.slice(0, -1),
    name,
    ...(ordinal === undefined ? {} : { ordinal }),
  };
}

export interface ParsedLegacySymbolId {
  kind: string;
  relPath: string;
  name: string;
  startLine: number;
}

/**
 * Parse the pre-HOK-79 line-bearing form (`sym:function:src/a.ts:run:12`).
 *
 * Recognising it is not the same as honouring it: the caller decides whether a legacy id may still
 * resolve, and under which deprecation. Undefined for a canonical id, so the two never overlap.
 */
export function parseLegacySymbolId(id: string): ParsedLegacySymbolId | undefined {
  const parts = id.split(":");
  if (parts.length !== 5 || parts[0] !== "sym") return undefined;
  const [, kind, relPath, name, line] = parts as [string, string, string, string, string];
  if (kind.length === 0 || relPath.length === 0 || name.length === 0) return undefined;
  if (!/^\d+$/.test(line)) return undefined;
  return { kind, relPath, name, startLine: Number.parseInt(line, 10) };
}

/** True for the deprecated line-bearing form only. */
export function isLegacySymbolId(id: string): boolean {
  return parseLegacySymbolId(id) !== undefined;
}

export function testId(relPath: string): string {
  return `test:${normalizePath(relPath)}`;
}

export function documentId(relPath: string): string {
  return `doc:${normalizePath(relPath)}`;
}

export function migrationId(relPath: string): string {
  return `mig:${normalizePath(relPath)}`;
}

export function capabilityId(name: string): string {
  return `cap:${slugify(name)}`;
}

export function invariantId(name: string): string {
  return `inv:${slugify(name)}`;
}

export function contractId(name: string): string {
  return `contract:${slugify(name)}`;
}

export function decisionId(name: string): string {
  return `dec:${slugify(name)}`;
}

export function riskId(name: string): string {
  return `risk:${slugify(name)}`;
}

export function boundedContextId(name: string): string {
  return `bc:${slugify(name)}`;
}

export function edgeId(kind: string, from: string, to: string): string {
  return `edge:${kind}:${fnv1a(`${from}->${to}`)}`;
}

export function evidenceId(sourceKind: string, filePath: string, startLine?: number, endLine?: number): string {
  return `ev:${sourceKind}:${normalizePath(filePath)}:${startLine ?? 0}:${endLine ?? 0}`;
}

export function claimId(kind: string, statement: string, subjectNodeIds: readonly string[]): string {
  const key = `${subjectNodeIds.join("|")}::${statement}`;
  return `claim:${kind}:${slugify(statement).slice(0, 40)}-${fnv1a(key)}`;
}

export function taskFrameId(rawTask: string): string {
  return `task:${fnv1a(rawTask)}`;
}

export function hypothesisId(taskFrameIdValue: string, statement: string): string {
  return `hyp:${fnv1a(`${taskFrameIdValue}::${statement}`)}`;
}

/**
 * Tag carried by a marker node whose slug was given contradictory statements.
 *
 * The graph keys capability, invariant, contract and risk nodes by slug, so two authors writing
 * different statements under one name produce a single node that can hold only one of them — and
 * which one depends on traversal order. The analyzer therefore strips the statement and adds this
 * tag, and every surface that could grant authority reads the tag rather than the survivor.
 *
 * It lives here because it is a property of the graph vocabulary, not of any one analyzer: the
 * producer that sets it and the consumer that must refuse to authorize on it are in packages that
 * share only this one.
 */
export const DIVERGENT_STATEMENT_TAG = "statement-divergent";
