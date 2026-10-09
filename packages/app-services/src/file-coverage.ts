import type { ChangedFile, FileCoverage, FileCoverageSummary, SemctxConfig } from "@semantic-context/core";
import { isPathSelected, sourceLanguage } from "@semantic-context/ts-analyzer";

/**
 * Languages named for the coverage report only. Naming a language is not supporting it: only
 * `ANALYZED_LANGUAGES` have a producer, and every other language is reported as unsupported per file.
 */
const NAMED_EXTENSIONS: Record<string, string> = {
  cs: "csharp",
  csproj: "msbuild",
  props: "msbuild",
  targets: "msbuild",
  sln: "visual-studio-solution",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ps1: "powershell",
  psm1: "powershell",
  sh: "shell",
  bash: "shell",
  html: "html",
  css: "css",
  txt: "text",
  xml: "xml",
};

/** Languages semctx has a producer for; any other language is unsupported, file by file. */
const ANALYZED_LANGUAGES = new Set(["typescript", "python", "markdown", "sql"]);

export function fileLanguage(path: string): string {
  const known = sourceLanguage(path);
  if (known !== "unknown") return known;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "unknown";
  return NAMED_EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? "unknown";
}

export interface FileCoverageInput {
  config: SemctxConfig;
  /** Null when the binding is broken: no file can have been joined to the index. */
  bound: { sideOf: (path: string) => "old" | "new"; indexedFiles: ReadonlySet<string> } | null;
}

/**
 * Decide, for one changed file, whether the analysis read it. The precedence is the order a
 * reader needs to act on: no producer for the language, then the configured selection, then the
 * index binding, then what the diff carries, then whether the index holds the file.
 */
export function coverageOf(file: ChangedFile, input: FileCoverageInput): FileCoverage {
  const language = fileLanguage(file.path);
  const notAnalyzed = (reason: string): FileCoverage => ({ status: "not_analyzed", language, reason });
  if (!ANALYZED_LANGUAGES.has(language)) return notAnalyzed("LANGUAGE_UNSUPPORTED");
  if (!isPathSelected(input.config, file.path) && (file.oldPath === undefined || !isPathSelected(input.config, file.oldPath))) {
    return notAnalyzed("OUTSIDE_SELECTION");
  }
  if (input.bound === null) return notAnalyzed("INDEX_BINDING_BROKEN");
  if (file.status === "binary") return notAnalyzed("BINARY_CONTENT");
  if (file.status === "mode_only") return notAnalyzed("METADATA_ONLY");
  if (file.status === "unrecognized") return notAnalyzed("UNRECOGNIZED_DIFF_BLOCK");
  if (file.status === "untracked") return notAnalyzed("UNTRACKED_NOT_DIFFED");
  const side = input.bound.sideOf(file.path);
  const boundPath = side === "old" ? (file.oldPath ?? file.path) : file.path;
  return input.bound.indexedFiles.has(boundPath)
    ? { status: "analyzed", language }
    : notAnalyzed("NOT_INDEXED");
}

export function withFileCoverage(files: readonly ChangedFile[], input: FileCoverageInput): { files: ChangedFile[]; summary: FileCoverageSummary } {
  const covered = files.map((file) => ({ ...file, coverage: coverageOf(file, input) }));
  const reasons: Record<string, number> = {};
  let analyzed = 0;
  for (const file of covered) {
    if (file.coverage.status === "analyzed") analyzed += 1;
    else reasons[file.coverage.reason!] = (reasons[file.coverage.reason!] ?? 0) + 1;
  }
  const sortedReasons = Object.fromEntries(Object.entries(reasons).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  return { files: covered, summary: { files: covered.length, analyzed, notAnalyzed: covered.length - analyzed, reasons: sortedReasons } };
}
