import { readFileSync } from "node:fs";
import { SemctxError, type VerifyReport } from "@semantic-context/core";
import { loadConfig } from "@semantic-context/repository-store";
import {
  GraphIndex,
  analyzeDiff,
  buildVerifyReport,
  computeCoChanges,
  parseNameStatusLog,
  type CoChange,
  type VerifyReportGitMeta,
  type VerifyResult,
} from "@semantic-context/context-engine";
import { openReadyRepository } from "./readiness";

export type VerifySource =
  | { kind: "working-tree"; head?: string }
  | { kind: "staged"; head?: string }
  | { kind: "range"; base: string; head?: string }
  | { kind: "file"; path: string }
  | { kind: "provided"; diffText: string };

export interface VerifyComputation {
  result: VerifyResult;
  report: VerifyReport;
  git: VerifyReportGitMeta;
  coChanges: CoChange[];
}

interface ResolvedVerifySource {
  diffText: string | null;
  git: VerifyReportGitMeta;
  includeCoChanges: boolean;
}

function git(root: string, args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode ?? 1,
    out: new TextDecoder().decode(proc.stdout),
    err: new TextDecoder().decode(proc.stderr),
  };
}

function validateRef(ref: string, role: "base" | "head"): void {
  if (ref.startsWith("-")) {
    throw new SemctxError("GIT_ERROR", `invalid ${role} ref "${ref}": refs must not start with "-"`, { [role]: ref });
  }
}

function requireRef(root: string, ref: string, role: "base" | "head"): string {
  validateRef(ref, role);
  const resolved = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`, "--"]);
  if (resolved.code === 0) return resolved.out.trim();
  if (role === "base") {
    throw new SemctxError(
      "GIT_BASE_UNAVAILABLE",
      `base ref "${ref}" is not available locally. In CI, check out with full history (fetch-depth: 0); semctx never fetches implicitly.`,
      { base: ref },
    );
  }
  throw new SemctxError("GIT_ERROR", `head ref "${ref}" does not exist locally.`, { head: ref });
}

function resolveSource(root: string, source: VerifySource, dryRun: boolean): ResolvedVerifySource {
  if (source.kind === "provided") {
    return { diffText: dryRun ? null : source.diffText, git: { base: null, head: "(provided)", mergeBase: null, range: null }, includeCoChanges: false };
  }
  if (source.kind === "file") {
    return { diffText: dryRun ? null : readFileSync(source.path, "utf8"), git: { base: null, head: "(from-file)", mergeBase: null, range: null }, includeCoChanges: false };
  }
  const head = source.head ?? "HEAD";
  validateRef(head, "head");
  if (source.kind === "range") {
    requireRef(root, source.base, "base");
    const headSha = requireRef(root, head, "head");
    const merge = git(root, ["merge-base", "--", source.base, head]);
    if (merge.code !== 0 || merge.out.trim() === "") {
      throw new SemctxError("GIT_ERROR", `could not compute a merge-base between "${source.base}" and "${head}"`, { stderr: merge.err.trim() });
    }
    const mergeBase = merge.out.trim();
    const meta: VerifyReportGitMeta = { base: source.base, head, mergeBase, range: `${mergeBase.slice(0, 12)}..${headSha.slice(0, 12)}` };
    if (dryRun) return { diffText: null, git: meta, includeCoChanges: true };
    const diff = git(root, ["diff", "--relative", "--unified=0", "--no-color", mergeBase, head, "--"]);
    if (diff.code !== 0) throw new SemctxError("GIT_ERROR", "git diff failed", { stderr: diff.err.trim() });
    return { diffText: diff.out, git: meta, includeCoChanges: true };
  }
  const meta: VerifyReportGitMeta = { base: null, head, mergeBase: null, range: null };
  if (dryRun) return { diffText: null, git: meta, includeCoChanges: true };
  const args = source.kind === "staged"
    ? ["diff", "--staged", "--relative", "--unified=0", "--no-color"]
    : ["diff", "HEAD", "--relative", "--unified=0", "--no-color"];
  const diff = git(root, args);
  if (diff.code !== 0) throw new SemctxError("GIT_ERROR", "git diff failed (is this a git repository?)", { stderr: diff.err.trim() });
  return { diffText: diff.out, git: meta, includeCoChanges: true };
}

function historicalCoChanges(root: string, files: readonly string[], head: string): CoChange[] {
  if (files.length === 0) return [];
  const log = git(root, ["log", "--no-merges", "--name-status", "--find-renames", "--format=%x1e", "-n", "400", head, "--"]);
  return log.code === 0 ? computeCoChanges(parseNameStatusLog(log.out), files) : [];
}

export function planVerify(root: string, source: VerifySource): VerifyReportGitMeta {
  return resolveSource(root, source, true).git;
}

/** Shared CLI/MCP verification use case. Always returns the ADR-0008 report. */
export function runVerify(root: string, source: VerifySource): VerifyComputation {
  const store = openReadyRepository(root);
  try {
    const config = loadConfig(root);
    const resolved = resolveSource(root, source, false);
    const result = analyzeDiff({ index: new GraphIndex(store.loadGraph()), claims: store.loadClaims(), config, diffText: resolved.diffText ?? "" });
    const coChanges = resolved.includeCoChanges ? historicalCoChanges(root, result.changedFiles, resolved.git.head) : [];
    return { result, report: buildVerifyReport(result, resolved.git, config.blockingRules, coChanges), git: resolved.git, coChanges };
  } finally {
    store.close();
  }
}
