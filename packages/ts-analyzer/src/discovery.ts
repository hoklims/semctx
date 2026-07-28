import { readdirSync, lstatSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { normalizePath, SemctxError } from "@semantic-context/core";
import type { SemctxConfig } from "@semantic-context/core";

export type FileRole = "source" | "test" | "document" | "migration" | "other";
export type SourceLanguage = "typescript" | "python" | "markdown" | "sql" | "unknown";

export interface DiscoveredFile {
  absPath: string;
  /** Normalised path relative to the repository root. */
  relPath: string;
  role: FileRole;
  content: string;
  /**
   * Present for the explicit v2 selection path. Omitted in legacy v1 so the historical discovery
   * object shape and analysis-input fingerprint remain unchanged.
   */
  language?: Exclude<SourceLanguage, "unknown">;
}

export interface DiscoveryCandidate {
  relPath: string;
  language: SourceLanguage;
  selectionDecision: "selected" | "excluded";
  /**
   * Discovery can close outcomes that require no producer. Enabled selected files are finalized
   * by the Plane-A producer ledger after analysis.
   */
  analysisOutcome?: "not_applicable" | "disabled" | "unsupported" | "failed";
  reason:
    | "LEGACY_UNSUPPORTED_EXTENSION"
    | "INCLUDE_MISS"
    | "EXCLUDE_MATCH"
    | "LANGUAGE_DISABLED"
    | "LANGUAGE_UNSUPPORTED"
    | "READ_FAILED"
    | "SELECTED";
}

export interface DiscoveryResult {
  files: DiscoveredFile[];
  candidates: DiscoveryCandidate[];
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
const PYTHON_FILE_RE = /\.py$/;
const MARKDOWN_RE = /\.mdx?$/;
const SQL_RE = /\.sql$/;
const PYTHON_TEST_FILENAME_RE = /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/;

function segments(relPath: string): string[] {
  return relPath.split("/").filter((s) => s.length > 0);
}

function isExcludedLegacy(relPath: string, config: SemctxConfig): boolean {
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

  if (PYTHON_FILE_RE.test(relPath)) {
    const isTest =
      PYTHON_TEST_FILENAME_RE.test(relPath) ||
      parts.some((part) => TEST_DIR_SEGMENTS.has(part));
    return isTest ? "test" : "source";
  }

  if (TS_FILE_RE.test(relPath)) {
    const isTest =
      TEST_FILENAME_RE.test(relPath) ||
      parts.some((p) => TEST_DIR_SEGMENTS.has(p)) ||
      TEST_IMPORT_RE.test(content);
    return isTest ? "test" : "source";
  }
  return "other";
}

export function sourceLanguage(relPath: string): SourceLanguage {
  if (TS_FILE_RE.test(relPath)) return "typescript";
  if (PYTHON_FILE_RE.test(relPath)) return "python";
  if (MARKDOWN_RE.test(relPath)) return "markdown";
  if (SQL_RE.test(relPath)) return "sql";
  return "unknown";
}

function matchesAny(relPath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new Bun.Glob(pattern.replaceAll("\\", "/")).match(relPath));
}

/** Pure path-selection predicate shared by discovery and changed-file preflights. */
export function isPathSelected(config: SemctxConfig, inputPath: string): boolean {
  const relPath = normalizePath(inputPath);
  if (config.version === 1) {
    return !isExcludedLegacy(relPath, config)
      && (TS_FILE_RE.test(relPath) || MARKDOWN_RE.test(relPath) || SQL_RE.test(relPath));
  }
  return config.include.length > 0
    && matchesAny(relPath, config.include)
    && !matchesAny(relPath, config.exclude);
}

function enabledLanguage(
  config: Extract<SemctxConfig, { version: 2 }>,
  language: SourceLanguage,
): "on" | "off" | undefined {
  if (language === "unknown") return undefined;
  return config.languages[language];
}

function walk(dir: string, root: string, acc: string[], strict = false): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch (error) {
    if (strict) {
      throw new SemctxError("IO_ERROR", "repository discovery could not read a directory", {
        path: normalizePath(relative(root, dir)) || ".",
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  for (const entry of entries) {
    if (IGNORED_SEGMENTS.has(entry)) continue;
    const abs = join(dir, entry);
    let stat;
    try {
      stat = lstatSync(abs);
    } catch (error) {
      if (strict) {
        throw new SemctxError("IO_ERROR", "repository discovery could not inspect a candidate", {
          path: normalizePath(relative(root, abs)),
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    // Containment: never follow symlinks — they could point outside the repository root
    // and leak external file content into the graph/pack (CWE-59).
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walk(abs, root, acc, strict);
    } else if (stat.isFile()) {
      acc.push(abs);
    }
  }
}

/**
 * Fast count of the TypeScript files the analyzer will actually parse — the same whole-repo walk
 * and ignore rules as `discoverFiles`, but without reading file contents. Used to announce the
 * index scale before the (blocking) analysis. NOTE: discovery walks the whole tree and honours
 * `config.exclude`/ignored dirs, not `config.include`.
 */
export function countTypeScriptFiles(config: SemctxConfig): number {
  if (config.version === 2) {
    return discoverRepository(config).files.filter((file) => file.language === "typescript").length;
  }
  const root = config.repositoryRoot;
  const absPaths: string[] = [];
  walk(root, root, absPaths);
  let count = 0;
  for (const absPath of absPaths) {
    const relPath = normalizePath(relative(root, absPath));
    if (isExcludedLegacy(relPath, config)) continue;
    if (TS_FILE_RE.test(relPath)) count += 1;
  }
  return count;
}

/**
 * Discover and classify repository files, deterministically (sorted order).
 * Only source, test, document and migration files are returned; "other" is dropped.
 */
export function discoverFiles(config: SemctxConfig): DiscoveredFile[] {
  if (config.version === 2) return discoverRepository(config).files;
  const root = config.repositoryRoot;
  const absPaths: string[] = [];
  walk(root, root, absPaths);
  absPaths.sort();

  const files: DiscoveredFile[] = [];
  for (const absPath of absPaths) {
    const relPath = normalizePath(relative(root, absPath));
    if (isExcludedLegacy(relPath, config)) continue;
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

/**
 * Discover repository candidates with an explicit, deterministic selection ledger.
 *
 * Version 1 preserves the historical selected file set. Version 2 applies normalized include
 * globs first, then lets excludes win. Producer execution finalizes enabled selected candidates.
 */
export function discoverRepository(config: SemctxConfig): DiscoveryResult {
  if (config.version === 1) {
    const files = discoverFiles(config);
    const selected = new Set(files.map((file) => file.relPath));
    const absPaths: string[] = [];
    walk(config.repositoryRoot, config.repositoryRoot, absPaths);
    const candidates = absPaths
      .map((absPath) => normalizePath(relative(config.repositoryRoot, absPath)))
      .filter((relPath) => !isExcludedLegacy(relPath, config))
      .sort()
      .map((relPath): DiscoveryCandidate => {
        const language = sourceLanguage(relPath);
        return selected.has(relPath)
          ? { relPath, language, selectionDecision: "selected", reason: "SELECTED" }
          : {
              relPath,
              language,
              selectionDecision: "excluded",
              analysisOutcome: "not_applicable",
              reason: "LEGACY_UNSUPPORTED_EXTENSION",
            };
      });
    return { files, candidates };
  }

  const root = config.repositoryRoot;
  const absPaths: string[] = [];
  walk(root, root, absPaths, true);
  const files: DiscoveredFile[] = [];
  const candidates: DiscoveryCandidate[] = [];

  for (const absPath of absPaths.sort()) {
    const relPath = normalizePath(relative(root, absPath));
    const language = sourceLanguage(relPath);
    const included = config.include.length > 0 && matchesAny(relPath, config.include);
    const excluded = matchesAny(relPath, config.exclude);
    if (!included || excluded) {
      candidates.push({
        relPath,
        language,
        selectionDecision: "excluded",
        analysisOutcome: "not_applicable",
        reason: excluded ? "EXCLUDE_MATCH" : "INCLUDE_MISS",
      });
      continue;
    }

    const mode = enabledLanguage(config, language);
    if (mode === undefined) {
      candidates.push({
        relPath,
        language,
        selectionDecision: "selected",
        analysisOutcome: "unsupported",
        reason: "LANGUAGE_UNSUPPORTED",
      });
      continue;
    }
    if (mode === "off") {
      candidates.push({
        relPath,
        language,
        selectionDecision: "selected",
        analysisOutcome: "disabled",
        reason: "LANGUAGE_DISABLED",
      });
      continue;
    }

    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      candidates.push({
        relPath,
        language,
        selectionDecision: "selected",
        analysisOutcome: "failed",
        reason: "READ_FAILED",
      });
      continue;
    }
    const role = classify(relPath, content, config);
    if (role === "other" || language === "unknown") {
      candidates.push({
        relPath,
        language,
        selectionDecision: "selected",
        analysisOutcome: "unsupported",
        reason: "LANGUAGE_UNSUPPORTED",
      });
      continue;
    }
    candidates.push({ relPath, language, selectionDecision: "selected", reason: "SELECTED" });
    files.push({ absPath, relPath, role, content, language });
  }

  return { files, candidates };
}
