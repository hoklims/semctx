import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SemctxError } from "@semantic-context/core";
import { replaceLocalReportFile } from "../report-output";
import type { VerifyReport } from "@semantic-context/core";
import type { VerifyResult, VerifyReportGitMeta, CoChange } from "@semantic-context/context-engine";
import {
  captureRecordableVerificationGitState,
  evaluatePreCommitHook,
  evaluatePrePushHook,
  parsePrePushRefs,
  planVerify,
  recordVerificationState,
  requireStableVerificationGitState,
  runVerify,
  type VerificationHookOutcome,
  type VerifyComputation,
  type VerifySource,
} from "@semantic-context/app-services";
import type { ParsedArgs } from "../args";
import { flagBool, flagString } from "../args";
import { info, heading, json, c, success, warn, fail, nowIso } from "../output";

// Re-exported for existing test-facing behavior: this module used to own the implementation.
export { requireStableVerificationGitState } from "@semantic-context/app-services";

type Format = "text" | "json" | "github";
type FailOn = "block" | "warn" | "none";

export function verifySourceFromArgs(args: ParsedArgs): VerifySource {
  const base = flagString(args, "base");
  // Kept optional rather than defaulted: `--from-file` has no head to fall back on, and defaulting
  // one there would attribute a diff semctx never computed to whatever HEAD happens to be. Passing
  // one explicitly states an attribution, which is labelled and checked but never proves provenance.
  const head = flagString(args, "head");
  if (base !== undefined) {
    return head === undefined ? { kind: "range", base } : { kind: "range", base, head };
  }
  const fromFile = flagString(args, "from-file");
  if (fromFile !== undefined) {
    const path = resolve(process.cwd(), fromFile);
    return head === undefined ? { kind: "file", path } : { kind: "file", path, head };
  }
  const kind = flagBool(args, "staged") ? "staged" as const : "working-tree" as const;
  return head === undefined ? { kind } : { kind, head };
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

function sourceLabel(source: VerifySource, meta: VerifyReportGitMeta): string {
  if (meta.range !== null) return meta.range;
  if (source.kind === "file") return "from-file";
  if (source.kind === "provided") return "provided diff";
  if (source.kind === "staged") return "staged changes";
  return "working tree";
}

function renderGithub(report: VerifyReport, source: VerifySource, meta: VerifyReportGitMeta): void {
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
      `${report.summary.warnCount} warn (range ${sourceLabel(source, meta)})`,
  );
}

function renderText(
  result: VerifyResult,
  meta: VerifyReportGitMeta,
  source: VerifySource,
  coChanges: readonly CoChange[] = [],
): void {
  const label =
    result.verdict === "PASS" ? c.green("PASS") : result.verdict === "WARN" ? c.yellow("WARN") : c.red("BLOCK");
  heading(`Verdict: ${label}`);
  info(`  range         : ${sourceLabel(source, meta)}`);
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

function writeReportAtomic(root: string, path: string, report: VerifyReport): void {
  replaceLocalReportFile(path, `${JSON.stringify(report, null, 2)}\n`, root);
}

/**
 * Compute the impact analysis + versioned report for a range. The single reusable entry point so
 * that `change verify` (semantic layer) composes this verbatim instead of re-deriving it.
 */
export function computeVerifyReport(root: string, args: ParsedArgs): VerifyComputation {
  return runVerify(root, verifySourceFromArgs(args));
}

/** `semctx verify diff` — analyse a git range (or the current diff) for impact and violations. */
export function runVerifyDiff(root: string, args: ParsedArgs): number {
  const format = resolveFormat(args);
  const failOn = resolveFailOn(args);
  const outputPath = flagString(args, "output");
  const source = verifySourceFromArgs(args);
  const shouldRecord = flagBool(args, "record");
  if (shouldRecord && source.kind !== "working-tree") {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      "--record is only valid for the current working tree; range, staged, and file inputs cannot authorize it",
      { sourceKind: source.kind },
    );
  }
  if (shouldRecord && outputPath !== undefined) {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      "--record cannot be combined with --output because writing the report would change the verified working state",
      { outputPath },
    );
  }

  if (flagBool(args, "dry-run")) {
    const g = planVerify(root, source);
    heading("Dry run — no analysis, no artifact, no state change");
    info(`  base      : ${g.base ?? "(none)"}`);
    info(`  head      : ${g.head}`);
    info(`  mergeBase : ${g.mergeBase ?? "(n/a)"}`);
    info(`  range     : ${sourceLabel(source, g)}`);
    info(`  format    : ${format}`);
    info(`  fail-on   : ${failOn}`);
    if (outputPath !== undefined) info(`  output    : ${resolve(process.cwd(), outputPath)} (would be written)`);
    return 0;
  }

  const stateBefore = shouldRecord ? captureRecordableVerificationGitState(root) : undefined;
  const { result, report, git: g, coChanges, analyzedSourceHash } = runVerify(root, source);
  const verifiedState = stateBefore === undefined
    ? undefined
    : requireStableVerificationGitState(
        stateBefore,
        captureRecordableVerificationGitState(root),
        analyzedSourceHash ?? "",
      );

  if (outputPath !== undefined) writeReportAtomic(root, resolve(process.cwd(), outputPath), report);
  const recordedPath = verifiedState === undefined
    ? undefined
    : recordVerificationState(root, report.verdict, verifiedState, nowIso());

  if (format === "json") json(report);
  else if (format === "github") renderGithub(report, source, g);
  else renderText(result, g, source, coChanges);

  if (recordedPath !== undefined && format === "text") info(c.dim(`recorded verification state -> ${recordedPath}`));

  return exitCode(report.verdict, failOn);
}

/** Git pipes pre-push ref lines on stdin; a terminal (manual run) or an unreadable stdin means "no refs". */
function readHookStdin(): string {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function verdictLabel(verdict: VerifyReport["verdict"]): string {
  return verdict === "PASS" ? c.green("PASS") : verdict === "WARN" ? c.yellow("WARN") : c.red("BLOCK");
}

function renderHookOutcome(outcome: VerificationHookOutcome): number {
  switch (outcome.kind) {
    case "current": {
      success(
        `${outcome.hook}: recorded verification is current (${verdictLabel(outcome.state.verdict)}, recorded ${outcome.state.recordedAt}); no analysis run`,
      );
      for (const ref of outcome.checkedRefs) info(c.dim(`  ${ref.localRef} ${ref.localObjectId} materializes the verified state`));
      return 0;
    }
    case "recorded": {
      const { result, report, git, coChanges } = outcome.verification;
      heading(`pre-commit: ${outcome.reason} — recorded a new verification of the tree about to be committed`);
      renderText(result, git, { kind: "working-tree" }, coChanges);
      info(c.dim(`recorded verification state -> ${outcome.recordedPath}`));
      return exitCode(report.verdict, "block");
    }
    case "blocked": {
      for (const ref of outcome.checkedRefs) info(c.dim(`  ${ref.localRef} ${ref.localObjectId} materializes the verified state`));
      fail(`pre-push: the recorded verification of these commits is ${c.red("BLOCK")} (recorded ${outcome.state.recordedAt}); resolve the findings, re-verify, and commit again`);
      return 3;
    }
    case "refused": {
      fail(`${outcome.hook}: [${outcome.reason}] ${outcome.message}`);
      if (Object.keys(outcome.details).length > 0) info(c.dim(JSON.stringify(outcome.details, null, 2)));
      return 1;
    }
  }
}

/**
 * `semctx verify hook pre-commit|pre-push` — content proof as the last job of a project-managed
 * Git hook chain (ADR 0029). Exit 0 when the tree is covered by a non-BLOCK record (pre-commit
 * records one when it must), 3 on a BLOCK verdict, 1 when the hook cannot vouch for the operation.
 */
export function runVerifyHook(root: string, args: ParsedArgs): number {
  const hook = args.positionals[2];
  if (hook !== "pre-commit" && hook !== "pre-push") {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      `verify hook expects pre-commit or pre-push, got "${hook ?? "(none)"}"`,
      { hook: hook ?? null },
    );
  }
  const outcome = hook === "pre-commit"
    ? evaluatePreCommitHook(root, nowIso())
    : evaluatePrePushHook(root, parsePrePushRefs(readHookStdin()));
  return renderHookOutcome(outcome);
}
