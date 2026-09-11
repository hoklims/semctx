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

import { existsSync, readFileSync } from "node:fs";
import { SemctxError } from "@semantic-context/core";
import { isLinkedEntry, writeFileNoFollow } from "@semantic-context/repository-store";
import { join } from "node:path";

const IGNORE_CHILDREN = ".semctx/*";
const TRACK_SEMANTIC = "!.semctx/semantic/";
const TRACK_CONFIG = "!.semctx/config.json";
const IGNORE_SEMANTIC_CHILDREN = ".semctx/semantic/*";
const TRACK_PROJECT = "!.semctx/semantic/project/";
const TRACK_PROJECT_DESCENDANTS = "!.semctx/semantic/project/**";
const BLANKET_RE = /^\.semctx\/?$/;

/** Complete project-only semantic + shareable config policy (early-exit when already present). */
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

function insertAfter(out: string[], marker: string, line: string): void {
  const at = out.indexOf(marker);
  if (at >= 0) {
    out.splice(at + 1, 0, line);
    return;
  }
  out.push(line);
}

export function computeGitignore(existing: string | undefined): { content: string; changed: boolean } {
  const original = existing ?? "";
  const lines = original.length === 0 ? [] : removeTrailingLf(original).split(/\r?\n/);
  const trimmedLines = new Set(lines.map((line) => line.trim()));
  if (PROJECT_ONLY_POLICY.every((line) => trimmedLines.has(line))) {
    const content = normalizeTrailing(original);
    return { content, changed: content !== original };
  }
  const out: string[] = [];
  let sawIgnore = false;
  let sawTrack = false;
  let sawConfig = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (BLANKET_RE.test(trimmed) || trimmed === IGNORE_CHILDREN) {
      if (!sawIgnore) {
        out.push(IGNORE_CHILDREN);
        sawIgnore = true;
        if (!sawTrack) {
          out.push(TRACK_SEMANTIC);
          sawTrack = true;
        }
        if (!sawConfig) {
          out.push(TRACK_CONFIG);
          sawConfig = true;
        }
      }
      continue;
    }
    if (trimmed === TRACK_SEMANTIC) {
      if (!sawTrack) {
        out.push(TRACK_SEMANTIC);
        sawTrack = true;
      }
      continue;
    }
    if (trimmed === TRACK_CONFIG) {
      if (!sawConfig) {
        out.push(TRACK_CONFIG);
        sawConfig = true;
      }
      continue;
    }
    out.push(line);
  }
  if (!sawIgnore) {
    out.push(IGNORE_CHILDREN);
    out.push(TRACK_SEMANTIC);
    out.push(TRACK_CONFIG);
  } else {
    if (!sawTrack) {
      // ignore rule present but no track rule: insert it right after the ignore rule.
      insertAfter(out, IGNORE_CHILDREN, TRACK_SEMANTIC);
    }
    if (!sawConfig) {
      // Prefer config re-include immediately after the semantic re-include.
      // TRACK_SEMANTIC is guaranteed present after the branch above or the loop.
      insertAfter(out, TRACK_SEMANTIC, TRACK_CONFIG);
    }
  }
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
  const existing = existed ? readFileSync(path, "utf8") : undefined;
  const { content, changed } = computeGitignore(existing);
  const action: GitignoreResult["action"] = !existed ? "create" : changed ? "update" : "present";
  if (!dryRun && action !== "present") writeFileNoFollow(root, path, content);
  return { path: ".gitignore", action };
}
