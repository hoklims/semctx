import { readdirSync, lstatSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { normalizePath } from "@semantic-context/core";
import type { SemctxConfig } from "@semantic-context/core";

export type FileRole = "source" | "test" | "document" | "migration" | "other";

export interface DiscoveredFile {
  absPath: string;
  /** Normalised path relative to the repository root. */
  relPath: string;
  role: FileRole;
  content: string;
}

const IGNORED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".semctx",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
]);

const TEST_FILENAME_RE = /\.(test|spec)\.(ts|tsx|mts|cts)$/;
const TEST_DIR_SEGMENTS = new Set(["test", "tests", "__tests__"]);
const TEST_IMPORT_RE = /from\s+["'](vitest|bun:test|node:test)["']/;
const TS_FILE_RE = /\.(ts|tsx|mts|cts)$/;
const MARKDOWN_RE = /\.mdx?$/;
const SQL_RE = /\.sql$/;

function segments(relPath: string): string[] {
  return relPath.split("/").filter((s) => s.length > 0);
}

function isExcluded(relPath: string, config: SemctxConfig): boolean {
  const parts = segments(relPath);
  if (parts.some((p) => IGNORED_SEGMENTS.has(p))) return true;
  // Config excludes are matched as plain path substrings (simple + predictable).
  return config.exclude.some((pattern) => relPath.includes(pattern.replace(/\*/g, "")));
}

function classify(relPath: string, content: string, config: SemctxConfig): FileRole {
  const parts = segments(relPath);
  const underMigrations =
    parts.some((p) => p === "migrations" || p === "migration") ||
    config.migrationsDirs.some((d) => relPath.startsWith(normalizePath(d)));
  if (SQL_RE.test(relPath)) return "migration";
  if (underMigrations && TS_FILE_RE.test(relPath)) return "migration";

  if (MARKDOWN_RE.test(relPath)) return "document";

  if (TS_FILE_RE.test(relPath)) {
    const isTest =
      TEST_FILENAME_RE.test(relPath) ||
      parts.some((p) => TEST_DIR_SEGMENTS.has(p)) ||
      TEST_IMPORT_RE.test(content);
    return isTest ? "test" : "source";
  }
  return "other";
}

function walk(dir: string, root: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED_SEGMENTS.has(entry)) continue;
    const abs = join(dir, entry);
    let stat;
    try {
      stat = lstatSync(abs);
    } catch {
      continue;
    }
    // Containment: never follow symlinks — they could point outside the repository root
    // and leak external file content into the graph/pack (CWE-59).
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walk(abs, root, acc);
    } else if (stat.isFile()) {
      acc.push(abs);
    }
  }
}

/**
 * Discover and classify repository files, deterministically (sorted order).
 * Only source, test, document and migration files are returned; "other" is dropped.
 */
export function discoverFiles(config: SemctxConfig): DiscoveredFile[] {
  const root = config.repositoryRoot;
  const absPaths: string[] = [];
  walk(root, root, absPaths);
  absPaths.sort();

  const files: DiscoveredFile[] = [];
  for (const absPath of absPaths) {
    const relPath = normalizePath(relative(root, absPath));
    if (isExcluded(relPath, config)) continue;
    if (!TS_FILE_RE.test(relPath) && !MARKDOWN_RE.test(relPath) && !SQL_RE.test(relPath)) continue;
    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }
    const role = classify(relPath, content, config);
    if (role === "other") continue;
    files.push({ absPath, relPath, role, content });
  }
  return files;
}
