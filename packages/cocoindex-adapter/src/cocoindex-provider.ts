import { normalizePath } from "@semantic-context/core";
import type { SemanticCandidate, SemanticCandidateProvider, SemanticSearchInput } from "./provider";

export interface CocoIndexOptions {
  /** CLI command to invoke (default: "ccc"). */
  command?: string;
}

/**
 * Isolated CocoIndex adapter. Shells out to the `ccc` CLI (cocoindex-code) if present,
 * and degrades gracefully to zero candidates when it is not installed or errors.
 *
 * The exact result mapping is tolerant: it accepts a JSON array, a `{ results: [...] }`
 * object, or newline-delimited JSON, and reads common field aliases. This keeps the
 * adapter robust across `ccc` versions without the core ever depending on it.
 */
export class CocoIndexCandidateProvider implements SemanticCandidateProvider {
  readonly name = "cocoindex";
  private readonly command: string;

  constructor(options: CocoIndexOptions = {}) {
    this.command = options.command ?? "ccc";
  }

  async version(): Promise<string | null> {
    try {
      const proc = Bun.spawnSync([this.command, "--version"], { stdout: "pipe", stderr: "pipe" });
      if (proc.exitCode !== 0) return null;
      const stdout = new TextDecoder().decode(proc.stdout).trim();
      const stderr = new TextDecoder().decode(proc.stderr).trim();
      const version = stdout.length > 0 ? stdout : stderr;
      return version.length > 0 ? version.split(/\r?\n/, 1)[0] ?? null : null;
    } catch {
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    return (await this.version()) !== null;
  }

  async search(input: SemanticSearchInput): Promise<SemanticCandidate[]> {
    let proc;
    try {
      proc = Bun.spawnSync(
        [this.command, "search", input.query, "--json", "--limit", String(input.limit)],
        { cwd: input.repositoryRoot, stdout: "pipe", stderr: "pipe" },
      );
    } catch {
      return [];
    }
    if (proc.exitCode !== 0) return [];
    return this.parse(new TextDecoder().decode(proc.stdout).trim());
  }

  /** Parse raw `ccc` output into candidates. Exposed for testing. */
  parse(text: string): SemanticCandidate[] {
    if (text.length === 0) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return this.parseLines(text);
    }
    const rows = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { results?: unknown[] }).results)
        ? ((raw as { results: unknown[] }).results)
        : [];
    return rows.map((row) => this.toCandidate(row)).filter((c): c is SemanticCandidate => c !== undefined);
  }

  private parseLines(text: string): SemanticCandidate[] {
    const out: SemanticCandidate[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const candidate = this.toCandidate(JSON.parse(trimmed));
        if (candidate !== undefined) out.push(candidate);
      } catch {
        // skip non-JSON noise
      }
    }
    return out;
  }

  private toCandidate(row: unknown): SemanticCandidate | undefined {
    if (typeof row !== "object" || row === null) return undefined;
    const obj = row as Record<string, unknown>;
    const filePath = pickString(obj, ["filePath", "file", "path"]);
    if (filePath === undefined) return undefined;
    const candidate: SemanticCandidate = {
      filePath: normalizePath(filePath),
      score: pickNumber(obj, ["score", "similarity", "relevance"]) ?? 0.5,
      provider: this.name,
    };
    const symbol = pickString(obj, ["symbolName", "symbol", "name"]);
    if (symbol !== undefined) candidate.symbolName = symbol;
    const snippet = pickString(obj, ["snippet", "content", "text"]);
    if (snippet !== undefined) candidate.snippet = snippet;
    const start = pickNumber(obj, ["startLine", "start_line", "start"]);
    if (start !== undefined) candidate.startLine = start;
    const end = pickNumber(obj, ["endLine", "end_line", "end"]);
    if (end !== undefined) candidate.endLine = end;
    return candidate;
  }
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pickNumber(obj: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}
