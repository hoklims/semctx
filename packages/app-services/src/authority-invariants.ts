/**
 * Single-authority invariants: an authored invariant may declare that a literal value (a trust
 * digest, a pinned version, a key id) has exactly one source file. Copies of that value elsewhere,
 * a source that no longer carries it, or a retired value still present anywhere are facts a change
 * can expose; `impact diff` reports them whenever the change touches a file holding the value, its
 * declared source, or the declaration itself. It is a textual scan of the diff's two sides, not an
 * index product, so it holds even when the index binding is broken.
 */

import { compareIds, type AuthorityInvariantImpact, type UnresolvedImpact } from "@semantic-context/core";
import type { SemanticModel, SemanticNode } from "@semantic-context/semantic-model/reconciliation-read";

export const AUTHORITY_VALUE_KEY = "authority.value";
export const AUTHORITY_SOURCE_KEY = "authority.source";
export const AUTHORITY_RETIRED_KEY = "authority.retired";
/** Shorter literals match too much unrelated text to say anything about a single source. */
const MIN_AUTHORITY_VALUE_LENGTH = 8;

/** A diff side: a commit object id, `""` for the Git index, or `null` for the working tree. */
export interface AuthoritySides {
  old: string;
  new: string | null;
}

interface AuthorityDeclaration {
  node: SemanticNode;
  value: string;
  source: string;
  retired: string[];
}

interface Occurrence {
  file: string;
  /** Null for a file Git treats as binary: the bytes match, but no line can be named. */
  line: number | null;
}

function git(root: string, args: string[]): { code: number; out: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode ?? 1, out: new TextDecoder().decode(proc.stdout) };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Every line holding `literal` on one side, outside `.semctx/` (where the declaration itself lives).
 * A side is what a diff can see: a commit's tree, the Git index, or for the worktree its tracked and
 * untracked files minus those Git ignores. An ignored file is on no diff side and is not searched,
 * so the same scope holds for every source. Two passes: text files with their line numbers, then every matching file, so a file Git treats
 * as binary still counts as an occurrence (with no line) instead of disappearing from the report.
 * Values are matched as UTF-8 bytes; a copy stored in another encoding (UTF-16) is not seen.
 */
function scan(root: string, revision: string | null, literal: string): Occurrence[] | undefined {
  const where = revision === null ? ["--untracked"] : revision === "" ? ["--cached"] : [revision];
  const pathspec = ["--", ".", ":(exclude).semctx"];
  const lines = git(root, ["grep", "--no-full-name", "-n", "-I", "-F", "-z", "-e", literal, ...where, ...pathspec]);
  const files = git(root, ["grep", "--no-full-name", "-l", "-F", "-z", "-e", literal, ...where, ...pathspec]);
  if ((lines.code !== 0 && lines.code !== 1) || (files.code !== 0 && files.code !== 1)) return undefined;
  const prefix = revision === null || revision === "" ? "" : `${revision}:`;
  const unprefixed = (rawPath: string): string => normalizePath(rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : rawPath);
  const occurrences: Occurrence[] = [];
  const textFiles = new Set<string>();
  for (const record of lines.out.split("\n")) {
    const [rawPath, rawLine] = record.split("\0");
    if (rawPath === undefined || rawLine === undefined || rawPath.length === 0) continue;
    const line = Number(rawLine);
    if (!Number.isSafeInteger(line)) continue;
    const file = unprefixed(rawPath);
    textFiles.add(file);
    occurrences.push({ file, line });
  }
  for (const rawPath of files.out.split("\0")) {
    if (rawPath.length === 0) continue;
    const file = unprefixed(rawPath);
    if (!textFiles.has(file)) occurrences.push({ file, line: null });
  }
  return occurrences;
}

function declarations(model: SemanticModel): { valid: AuthorityDeclaration[]; gaps: UnresolvedImpact[] } {
  const valid: AuthorityDeclaration[] = [];
  const gaps: UnresolvedImpact[] = [];
  for (const node of model.nodes) {
    const metadata = node.metadata ?? {};
    const value = metadata[AUTHORITY_VALUE_KEY];
    const rawSource = metadata[AUTHORITY_SOURCE_KEY];
    if (value === undefined && rawSource === undefined) continue;
    const source = rawSource === undefined ? undefined : normalizePath(rawSource.trim());
    const retired = (metadata[AUTHORITY_RETIRED_KEY] ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    const problem = node.kind !== "invariant"
      ? "only an invariant can declare a single authority"
      : value === undefined || source === undefined
        ? `a single authority needs both meta ${AUTHORITY_VALUE_KEY} and meta ${AUTHORITY_SOURCE_KEY}`
        : source.length === 0
          ? `meta ${AUTHORITY_SOURCE_KEY} must name the file that holds the value`
          : [value, ...retired].some((literal) => literal.length < MIN_AUTHORITY_VALUE_LENGTH)
            ? `authority values must be at least ${MIN_AUTHORITY_VALUE_LENGTH} characters`
            : retired.includes(value)
              ? "the authority value cannot also be retired"
              : undefined;
    if (problem !== undefined) {
      gaps.push({ code: "AUTHORITY_DECLARATION_INVALID", scope: "node", nodeId: node.id, detail: problem, affects: "claims" });
      continue;
    }
    valid.push({ node, value: value!, source: source!, retired });
  }
  return { valid, gaps };
}

/**
 * The single-authority invariants this change exposes, with every occurrence of their values on
 * both sides. `changedPaths` are the diff's paths (old and new names); `declarationFiles` are the
 * `.sem` files the diff touches.
 */
export function evaluateAuthorityInvariants(
  root: string,
  model: SemanticModel,
  sides: AuthoritySides,
  changedPaths: ReadonlySet<string>,
): { impacts: AuthorityInvariantImpact[]; gaps: UnresolvedImpact[] } {
  const { valid, gaps } = declarations(model);
  const impacts: AuthorityInvariantImpact[] = [];
  for (const declaration of valid) {
    const occurrences: AuthorityInvariantImpact["occurrences"] = [];
    let unreadable = false;
    for (const [side, revision] of [["old", sides.old], ["new", sides.new]] as const) {
      for (const [kind, literal] of [["authority", declaration.value] as const, ...declaration.retired.map((retired) => ["retired", retired] as const)]) {
        const found = scan(root, revision, literal);
        if (found === undefined) {
          unreadable = true;
          continue;
        }
        for (const occurrence of found) {
          occurrences.push({
            file: occurrence.file,
            line: occurrence.line,
            side,
            kind,
            authoritative: occurrence.file === declaration.source,
            changed: changedPaths.has(occurrence.file),
          });
        }
      }
    }
    if (unreadable) {
      gaps.push({ code: "AUTHORITY_SCAN_FAILED", scope: "node", nodeId: declaration.node.id, detail: "a side of the diff could not be searched for the authority value; its occurrences are unknown", affects: "claims" });
      continue;
    }
    const declarationFiles = declaration.node.sourceRefs.map((ref) => normalizePath(ref.file));
    const exposed = changedPaths.has(declaration.source)
      || occurrences.some((occurrence) => occurrence.changed)
      || declarationFiles.some((file) => changedPaths.has(file));
    if (!exposed) continue;

    const current = occurrences.filter((occurrence) => occurrence.side === "new");
    const sourceHolds = current.some((occurrence) => occurrence.kind === "authority" && occurrence.authoritative);
    const copies = current.filter((occurrence) => occurrence.kind === "authority" && !occurrence.authoritative);
    const retired = current.filter((occurrence) => occurrence.kind === "retired");
    const status: AuthorityInvariantImpact["status"] = retired.length > 0 || (!sourceHolds && copies.length > 0)
      ? "diverged"
      : copies.length > 0
        ? "duplicated"
        : sourceHolds
          ? "single_source"
          : "absent";
    impacts.push({
      id: declaration.node.id,
      ...(declaration.node.statement.length > 0 ? { statement: declaration.node.statement } : {}),
      value: declaration.value,
      source: declaration.source,
      ...(declaration.retired.length > 0 ? { retired: [...declaration.retired] } : {}),
      status,
      occurrences: occurrences.sort((left, right) =>
        compareIds(left.side, right.side)
        || compareIds(left.file, right.file)
        || (left.line ?? 0) - (right.line ?? 0)
        || compareIds(left.kind, right.kind)),
    });
  }
  return { impacts: impacts.sort((left, right) => compareIds(left.id, right.id)), gaps };
}
