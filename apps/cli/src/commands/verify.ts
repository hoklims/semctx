import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { SemctxError } from "@semantic-context/core";
import type { VerifyReport } from "@semantic-context/core";
import { loadConfig, openStore } from "@semantic-context/repository-store";
import { GraphIndex, analyzeDiff, buildVerifyReport, computeCoChanges, parseNameOnlyLog } from "@semantic-context/context-engine";
import type { VerifyResult, VerifyReportGitMeta, CoChange } from "@semantic-context/context-engine";
import type { ParsedArgs } from "../args";
import { flagBool, flagString } from "../args";
import { info, heading, json, c, success, warn, fail, nowIso } from "../output";

type Format = "text" | "json" | "github";
type FailOn = "block" | "warn" | "none";

// --- git (argv arrays only; never a shell string — no injection surface) ---

function git(root: string, gitArgs: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["git", ...gitArgs], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode ?? 1,
    out: new TextDecoder().decode(proc.stdout),
    err: new TextDecoder().decode(proc.stderr),
  };
}

function refExists(root: string, ref: string): boolean {
  return git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).code === 0;
}

/** How many recent commits to mine for the historical co-change signal. */
const CO_CHANGE_DEPTH = 400;

/**
 * Historical co-change signal from `git log` (advisory). Never fails verification: a git error
 * (shallow clone, no history) yields an empty signal rather than throwing.
 */
function computeCoChangeSignal(root: string, changedFiles: readonly string[]): CoChange[] {
  if (changedFiles.length === 0) return [];
  const log = git(root, ["log", "--no-merges", "--name-only", "--format=%x1e", "-n", String(CO_CHANGE_DEPTH)]);
  if (log.code !== 0) return [];
  return computeCoChanges(parseNameOnlyLog(log.out), changedFiles);
}

interface Resolved {
  diffText: string | null; // null in dry-run (range resolved, diff not computed)
  git: VerifyReportGitMeta;
}

/** Resolve the git range (or legacy diff source) into a diff + machine-visible git meta. */
function resolveRange(root: string, args: ParsedArgs, dryRun: boolean): Resolved {
  const base = flagString(args, "base");
  const head = flagString(args, "head") ?? "HEAD";

  if (base !== undefined) {
    if (!refExists(root, base)) {
      throw new SemctxError(
        "GIT_BASE_UNAVAILABLE",
        `base ref "${base}" is not available locally. In CI, check out with full history ` +
          `(actions/checkout with fetch-depth: 0). semctx never fetches implicitly.`,
        { base },
      );
    }
    if (!refExists(root, head)) {
      throw new SemctxError("GIT_ERROR", `head ref "${head}" does not exist locally.`, { head });
    }
    const mb = git(root, ["merge-base", base, head]);
    if (mb.code !== 0 || mb.out.trim() === "") {
      throw new SemctxError(
        "GIT_ERROR",
        `could not compute a merge-base between "${base}" and "${head}" ` +
          `(histories may be unrelated or the checkout is shallow — use fetch-depth: 0).`,
        { stderr: mb.err.trim() },
      );
    }
    const mergeBase = mb.out.trim();
    const headSha = git(root, ["rev-parse", head]).out.trim();
    const gitMeta: VerifyReportGitMeta = {
      base,
      head,
      mergeBase,
      range: `${mergeBase.slice(0, 12)}..${headSha.slice(0, 12)}`,
    };
    if (dryRun) return { diffText: null, git: gitMeta };
    const d = git(root, ["diff", "--relative", "--unified=0", "--no-color", mergeBase, head]);
    if (d.code !== 0) throw new SemctxError("GIT_ERROR", "git diff failed", { stderr: d.err.trim() });
    return { diffText: d.out, git: gitMeta };
  }

  // --- legacy sources (no --base): --from-file, --staged, or working tree vs HEAD ---
  const fromFile = flagString(args, "from-file");
  if (fromFile !== undefined) {
    const meta: VerifyReportGitMeta = { base: null, head: "(from-file)", mergeBase: null, range: null };
    if (dryRun) return { diffText: null, git: meta };
    return { diffText: readFileSync(resolve(process.cwd(), fromFile), "utf8"), git: meta };
  }
  const meta: VerifyReportGitMeta = { base: null, head, mergeBase: null, range: null };
  if (dryRun) return { diffText: null, git: meta };
  const staged = flagBool(args, "staged");
  const gitArgs = staged
    ? ["diff", "--staged", "--relative", "--unified=0", "--no-color"]
    : ["diff", "HEAD", "--relative", "--unified=0", "--no-color"];
  const d = git(root, gitArgs);
  if (d.code !== 0) {
    throw new SemctxError("GIT_ERROR", "git diff failed (is this a git repository?)", { stderr: d.err.trim() });
  }
  return { diffText: d.out, git: meta };
}

// --- output formats ---

function resolveFormat(args: ParsedArgs): Format {
  const explicit = flagString(args, "format");
  if (explicit !== undefined) {
    if (explicit !== "text" && explicit !== "json" && explicit !== "github") {
      throw new SemctxError("INVALID_TASK_INPUT", `--format must be text|json|github, got "${explicit}"`, { format: explicit });
    }
    return explicit;
  }
  return flagBool(args, "json") ? "json" : "text";
}

function resolveFailOn(args: ParsedArgs): FailOn {
  if (flagBool(args, "strict")) return "warn"; // legacy alias
  const v = flagString(args, "fail-on") ?? "block";
  if (v !== "block" && v !== "warn" && v !== "none") {
    throw new SemctxError("INVALID_TASK_INPUT", `--fail-on must be block|warn|none, got "${v}"`, { failOn: v });
  }
  return v;
}

/** WARN never fails by default; BLOCK fails unless --fail-on none; --fail-on warn also fails on WARN. */
function exitCode(verdict: VerifyReport["verdict"], failOn: FailOn): number {
  const shouldFail =
    (verdict === "BLOCK" && (failOn === "block" || failOn === "warn")) || (verdict === "WARN" && failOn === "warn");
  return shouldFail ? 3 : 0;
}

/** Escape a GitHub workflow-command message (data segment). */
function ghData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function ghProp(text: string): string {
  return ghData(text).replace(/,/g, "%2C").replace(/:/g, "%3A");
}

function renderGithub(report: VerifyReport): void {
  for (const f of report.findings) {
    const cmd = f.severity === "block" ? "error" : "warning";
    const title = `semctx: ${f.rule}`;
    if (f.locations.length === 0) {
      info(`::${cmd} title=${ghProp(title)}::${ghData(f.message)}`);
      continue;
    }
    for (const loc of f.locations) {
      const line = loc.line !== undefined ? `,line=${loc.line}` : "";
      info(`::${cmd} title=${ghProp(title)},file=${ghProp(loc.file)}${line}::${ghData(f.message)}`);
    }
  }
  info(
    `::notice::semctx verdict ${report.verdict} — ${report.summary.blockCount} block, ` +
      `${report.summary.warnCount} warn (range ${report.range ?? "working tree"})`,
  );
}

function renderText(result: VerifyResult, meta: VerifyReportGitMeta, coChanges: readonly CoChange[] = []): void {
  const label =
    result.verdict === "PASS" ? c.green("PASS") : result.verdict === "WARN" ? c.yellow("WARN") : c.red("BLOCK");
  heading(`Verdict: ${label}`);
  info(`  range         : ${meta.range ?? (meta.head === "(from-file)" ? "from-file" : "working tree")}`);
  info(`  changed files : ${result.changedFiles.length}`);
  info(`  impacted nodes: ${result.impactedNodes.length}`);
  if (result.impactedInvariants.length > 0) {
    heading("Impacted invariants");
    for (const inv of result.impactedInvariants) info(`  ${c.red("!")} ${inv.statement} ${c.dim(`[${inv.verificationStatus}]`)}`);
  }
  if (result.impactedContracts.length > 0) {
    heading("Impacted contracts");
    for (const con of result.impactedContracts) info(`  ${con.statement} ${c.dim(`[${con.verificationStatus}]`)}`);
  }
  heading("Recommended tests");
  if (result.recommendedTests.length === 0) info(c.dim("  none"));
  for (const test of result.recommendedTests) info(`  ${c.green(test.filePath ?? test.name)}`);
  if (result.contradictions.length > 0) {
    heading("Contradictions touched (non-normative)");
    for (const con of result.contradictions) info(`  ${c.yellow("~")} ${con.statement}`);
  }
  if (result.unknowns.length > 0) {
    heading("Unknowns");
    for (const u of result.unknowns) info(`  ${c.dim("?")} ${u}`);
  }
  if (coChanges.length > 0) {
    heading("Historically co-changed (advisory)");
    for (const cc of coChanges) {
      const tops = cc.coChanged
        .slice(0, 5)
        .map((x) => `${x.file} (${x.commits})`)
        .join(", ");
      info(`  ${c.dim("~")} ${cc.file} -> ${tops}`);
    }
  }
  heading("Findings");
  if (result.findings.length === 0) info(c.dim("  none"));
  for (const finding of result.findings) {
    const tag = finding.severity === "block" ? c.red("BLOCK") : c.yellow("WARN ");
    info(`  [${tag}] ${finding.rule}: ${finding.message}`);
  }
  info("");
  if (result.verdict === "PASS") success("no blocking violations");
  else if (result.verdict === "WARN") warn("non-blocking warnings present");
  else fail("blocking violations present");
}

function writeReportAtomic(path: string, report: VerifyReport): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/**
 * Hash of the working-tree diff (`git diff HEAD`). The Claude Code guarded hook (ADR 0007)
 * hashes the same command, so an unchanged, verified diff stays verified and any edit invalidates
 * it. Kept identical to the guard: `git diff HEAD --relative --unified=0 --no-color`.
 */
function workingTreeDiffHash(root: string): string {
  const d = git(root, ["diff", "HEAD", "--relative", "--unified=0", "--no-color"]);
  return `sha256:${createHash("sha256").update(d.code === 0 ? d.out : "").digest("hex")}`;
}

/** Record the verification state so a guarded hook can compare the current diff hash. */
function recordVerification(root: string, verdict: VerifyReport["verdict"]): string {
  const dir = join(root, ".semctx");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "verification-state.json");
  const state = { version: 1, diffHash: workingTreeDiffHash(root), verdict, recordedAt: nowIso() };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return path;
}

/** `semctx verify diff` — analyse a git range (or the current diff) for impact and violations. */
export function runVerifyDiff(root: string, args: ParsedArgs): number {
  const format = resolveFormat(args);
  const failOn = resolveFailOn(args);
  const outputPath = flagString(args, "output");

  if (flagBool(args, "dry-run")) {
    const { git: g } = resolveRange(root, args, true);
    heading("Dry run — no analysis, no artifact, no state change");
    info(`  base      : ${g.base ?? "(none)"}`);
    info(`  head      : ${g.head}`);
    info(`  mergeBase : ${g.mergeBase ?? "(n/a)"}`);
    info(`  range     : ${g.range ?? "(working tree)"}`);
    info(`  format    : ${format}`);
    info(`  fail-on   : ${failOn}`);
    if (outputPath !== undefined) info(`  output    : ${resolve(process.cwd(), outputPath)} (would be written)`);
    return 0;
  }

  const config = loadConfig(root);
  const store = openStore(root);
  if (!store.isIndexed()) {
    store.close();
    throw new SemctxError("REPO_NOT_INDEXED", "repository is not indexed; run 'semctx index' first");
  }
  const graph = store.loadGraph();
  const claims = store.loadClaims();
  store.close();

  const { diffText, git: g } = resolveRange(root, args, false);
  const result = analyzeDiff({ index: new GraphIndex(graph), claims, config, diffText: diffText ?? "" });
  const coChanges = computeCoChangeSignal(root, result.changedFiles);
  const report = buildVerifyReport(result, g, config.blockingRules, coChanges);

  if (outputPath !== undefined) writeReportAtomic(resolve(process.cwd(), outputPath), report);
  const recordedPath = flagBool(args, "record") ? recordVerification(root, report.verdict) : undefined;

  if (format === "json") json(report);
  else if (format === "github") renderGithub(report);
  else renderText(result, g, coChanges);

  if (recordedPath !== undefined && format === "text") info(c.dim(`recorded verification state -> ${recordedPath}`));

  return exitCode(report.verdict, failOn);
}
