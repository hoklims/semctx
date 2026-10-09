/**
 * Keep versionable `.semctx/` policy tracked while machine state stays local.
 *
 * Tracked:
 * - `.semctx/semantic/**` — authored semantic model
 * - `.semctx/config.json` — selection / blocking policy (shareable across clones; #82)
 *
 * Local (ignored): `semctx.db`, context packs, working state, etc.
 *
 * A blanket `.semctx/` rule excludes the directory itself, and Git cannot re-include a path whose
 * parent dir is excluded. So the base policy is `.semctx/*` + `!.semctx/semantic/` +
 * `!.semctx/config.json`. This helper migrates a bare `.semctx/` line and is idempotent.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { SemctxError } from "@semantic-context/core";
import { isLinkedEntry, writeFileNoFollow } from "@semantic-context/repository-store";
import { join } from "node:path";

const IGNORE_CHILDREN = ".semctx/*";
const TRACK_SEMANTIC = "!.semctx/semantic/";
const TRACK_SEMANTIC_DESCENDANTS = "!.semctx/semantic/**";
const TRACK_CONFIG = "!.semctx/config.json";
const IGNORE_SEMANTIC_CHILDREN = ".semctx/semantic/*";
const TRACK_PROJECT = "!.semctx/semantic/project/";
const TRACK_PROJECT_DESCENDANTS = "!.semctx/semantic/project/**";
const BLANKET_RE = /^\.semctx\/?$/;

const PROJECT_ONLY_POLICY = [
  IGNORE_CHILDREN,
  TRACK_SEMANTIC,
  IGNORE_SEMANTIC_CHILDREN,
  TRACK_PROJECT,
  TRACK_PROJECT_DESCENDANTS,
  TRACK_CONFIG,
] as const;

export interface GitignoreResult {
  path: string;
  action: "create" | "update" | "present";
}

export function computeGitignore(existing: string | undefined): { content: string; changed: boolean } {
  const original = existing ?? "";
  const lines = original.length === 0 ? [] : removeTrailingLf(original).split(/\r?\n/);
  const policyRules = new Set<string>([...PROJECT_ONLY_POLICY, TRACK_SEMANTIC_DESCENDANTS]);
  const trimmedLines = lines.map((line) => line.trim());
  const isManagedRule = (line: string): boolean => policyRules.has(line) || BLANKET_RE.test(line);
  const recognizedRules = trimmedLines.filter(isManagedRule);
  const effectiveRules = lines
    .map((line) => line.replace(/\r$/, "").replace(/ +$/, ""))
    .filter(isManagedRule);
  // Inactive rules cannot override a usable policy; wholly malformed policies retain their intent.
  const variantRules = effectiveRules.some(
    (line) =>
      line === TRACK_SEMANTIC ||
      line === IGNORE_SEMANTIC_CHILDREN ||
      line === TRACK_SEMANTIC_DESCENDANTS ||
      line === TRACK_PROJECT ||
      line === TRACK_PROJECT_DESCENDANTS,
  ) ? effectiveRules : recognizedRules;
  const lastForeignRule = trimmedLines.findLastIndex(
    (line) => line.length > 0 && !line.startsWith("#") && !isManagedRule(line),
  );
  const firstManagedRule = trimmedLines.findIndex(isManagedRule);
  const projectOnly =
    variantRules.lastIndexOf(IGNORE_SEMANTIC_CHILDREN) >
      variantRules.lastIndexOf(TRACK_SEMANTIC_DESCENDANTS);
  const policy = projectOnly
    ? PROJECT_ONLY_POLICY
    : [IGNORE_CHILDREN, TRACK_SEMANTIC, TRACK_SEMANTIC_DESCENDANTS, TRACK_CONFIG];
  const semanticRules = recognizedRules.filter((line) => line !== TRACK_CONFIG);
  const expectedSemanticRules = policy.filter((line) => line !== TRACK_CONFIG);
  const hasEffectivePolicy =
    lines.every((line) => !isManagedRule(line.trim()) || line.replace(/\r$/, "") === line.trim()) &&
    firstManagedRule > lastForeignRule &&
    recognizedRules.length === policy.length &&
    semanticRules.length === expectedSemanticRules.length &&
    semanticRules.every((line, index) => line === expectedSemanticRules[index]) &&
    recognizedRules.indexOf(TRACK_CONFIG) > recognizedRules.indexOf(IGNORE_CHILDREN);
  if (hasEffectivePolicy) {
    const content = normalizeTrailing(original);
    return { content, changed: content !== original };
  }
  const out = lines.filter((line) => !isManagedRule(line.trim()));
  out.push(...policy);
  const content = `${out.join("\n")}\n`;
  return { content, changed: content !== normalizeTrailing(original) };
}

function normalizeTrailing(text: string): string {
  if (text.length === 0) return "";
  return `${removeTrailingLf(text)}\n`;
}

function removeTrailingLf(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}

/** Ensure `.gitignore` tracks `.semctx/semantic/` and `.semctx/config.json`. Non-destructive. */
export function ensureSemanticGitignore(root: string, dryRun = false): GitignoreResult {
  const path = join(root, ".gitignore");
  // A checkout can plant `.gitignore` as a link. Reading through it would make even a dry run an
  // oracle on an outside file (or block on a FIFO), and rewriting through it would land wherever
  // the link points, so it is refused before anything is read.
  if (isLinkedEntry(path)) throw new SemctxError("CONFIG_INVALID", "a linked .gitignore is unsupported", { path });
  const existed = existsSync(path);
  let existing: string | undefined;
  if (existed) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (cause) {
      throw new SemctxError("CONFIG_INVALID", ".gitignore could not be inspected", { path, cause: String(cause) });
    }
    if (!stat.isFile()) {
      throw new SemctxError("CONFIG_INVALID", ".gitignore must be a regular file", { path });
    }
    try {
      existing = readFileSync(path, "utf8");
    } catch (cause) {
      throw new SemctxError("CONFIG_INVALID", ".gitignore could not be read", { path, cause: String(cause) });
    }
  }
  const { content, changed } = computeGitignore(existing);
  const action: GitignoreResult["action"] = !existed ? "create" : changed ? "update" : "present";
  if (!dryRun && action !== "present") writeFileNoFollow(root, path, content);
  return { path: ".gitignore", action };
}
