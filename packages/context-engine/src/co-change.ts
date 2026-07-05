import { normalizePath } from "@semantic-context/core";

/** Record separator (0x1e) used with `git log --format=%x1e` to delimit commits. */
const COMMIT_SEP = "\x1e";

/** A file that historically changed together with a changed file, and how many commits back it. */
export interface CoChangedFile {
  file: string;
  commits: number;
}

/** Files historically co-changed with one file from the diff, ranked by support. */
export interface CoChange {
  file: string;
  coChanged: CoChangedFile[];
}

export interface CoChangeOptions {
  /** Minimum number of shared commits to report a pair (default 2). */
  minSupport?: number;
  /** Max co-changed files reported per changed file (default 8). */
  maxPerFile?: number;
}

/**
 * Parse `git log --no-merges --name-only --format=%x1e` output into one file-list per commit.
 * The record separator (0x1e) starts each commit; a commit's files are the non-empty lines.
 */
export function parseNameOnlyLog(logText: string): string[][] {
  const commits: string[][] = [];
  for (const chunk of logText.split(COMMIT_SEP)) {
    const files = chunk
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => normalizePath(s));
    if (files.length > 0) commits.push([...new Set(files)]);
  }
  return commits;
}

/**
 * Historical co-change signal: for each changed file, the OTHER files (not in the diff) that
 * appeared in the same commits at least `minSupport` times. Deterministic, no LLM — a structural
 * impact axis the static graph cannot see (two files that change together without a code edge).
 */
export function computeCoChanges(
  commits: readonly (readonly string[])[],
  changedFiles: readonly string[],
  options: CoChangeOptions = {},
): CoChange[] {
  const minSupport = options.minSupport ?? 2;
  const maxPerFile = options.maxPerFile ?? 8;
  const changed = new Set(changedFiles.map((f) => normalizePath(f)));

  const counts = new Map<string, Map<string, number>>();
  for (const commit of commits) {
    const files = [...new Set(commit.map((f) => normalizePath(f)))];
    const changedHere = files.filter((f) => changed.has(f));
    if (changedHere.length === 0) continue;
    const others = files.filter((f) => !changed.has(f));
    for (const cf of changedHere) {
      let row = counts.get(cf);
      if (row === undefined) {
        row = new Map<string, number>();
        counts.set(cf, row);
      }
      for (const other of others) row.set(other, (row.get(other) ?? 0) + 1);
    }
  }

  const result: CoChange[] = [];
  for (const file of [...changed].sort()) {
    const row = counts.get(file);
    if (row === undefined) continue;
    const coChanged = [...row.entries()]
      .filter(([, n]) => n >= minSupport)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, maxPerFile)
      .map(([f, n]) => ({ file: f, commits: n }));
    if (coChanged.length > 0) result.push({ file, coChanged });
  }
  return result;
}
