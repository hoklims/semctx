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

export function symbolId(kind: string, relPath: string, name: string, startLine: number): string {
  return `sym:${kind}:${normalizePath(relPath)}:${name}:${startLine}`;
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
