/**
 * Keep `.semctx/semantic/**` tracked in Git while the rest of `.semctx/` stays local.
 *
 * A blanket `.semctx/` rule excludes the directory itself, and Git cannot re-include a path whose
 * parent dir is excluded. So the policy is `.semctx/*` (ignore direct children) + `!.semctx/semantic/`
 * (re-include the authored source). This helper migrates a bare `.semctx/` line and is idempotent.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IGNORE_CHILDREN = ".semctx/*";
const TRACK_SEMANTIC = "!.semctx/semantic/";
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
] as const;

export interface GitignoreResult {
  path: string;
  action: "create" | "update" | "present";
}

export function computeGitignore(existing: string | undefined): { content: string; changed: boolean } {
  const original = existing ?? "";
  const lines = original.length === 0 ? [] : original.replace(/\n+$/, "").split(/\r?\n/);
  const trimmedLines = new Set(lines.map((line) => line.trim()));
  if (PROJECT_ONLY_POLICY.every((line) => trimmedLines.has(line))) {
    const content = normalizeTrailing(original);
    return { content, changed: content !== original };
  }
  const out: string[] = [];
  let sawIgnore = false;
  let sawTrack = false;
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
    out.push(line);
  }
  if (!sawIgnore) {
    out.push(IGNORE_CHILDREN);
    out.push(TRACK_SEMANTIC);
  } else if (!sawTrack) {
    // ignore rule present but no track rule: insert it right after the ignore rule.
    const at = out.indexOf(IGNORE_CHILDREN);
    out.splice(at + 1, 0, TRACK_SEMANTIC);
  }
  const content = `${out.join("\n")}\n`;
  return { content, changed: content !== normalizeTrailing(original) };
}

function normalizeTrailing(text: string): string {
  if (text.length === 0) return "";
  return `${text.replace(/\n+$/, "")}\n`;
}

/** Ensure `.gitignore` tracks `.semctx/semantic/`. Non-destructive; returns the action taken. */
export function ensureSemanticGitignore(root: string, dryRun = false): GitignoreResult {
  const path = join(root, ".gitignore");
  const existed = existsSync(path);
  const existing = existed ? readFileSync(path, "utf8") : undefined;
  const { content, changed } = computeGitignore(existing);
  const action: GitignoreResult["action"] = !existed ? "create" : changed ? "update" : "present";
  if (!dryRun && action !== "present") writeFileSync(path, content, "utf8");
  return { path: ".gitignore", action };
}
