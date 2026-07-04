#!/usr/bin/env node
// GitHub Action adapter for semctx (ADR 0006). Pure Node (no bun:sqlite, no GitHub SDK):
// it consumes the stable verify JSON report (ADR 0008) and produces GitHub annotations, a job
// summary, and action outputs, then owns the fail-on exit code. The verify engine runs under
// Bun in a prior composite step and writes the report; this adapter never analyses anything.
import { readFileSync, appendFileSync } from "node:fs";

/** Escape a GitHub workflow-command data segment. */
export function escData(text) {
  return String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
/** Escape a GitHub workflow-command property segment. */
export function escProp(text) {
  return escData(text).replace(/,/g, "%2C").replace(/:/g, "%3A");
}

function annotationsFor(report) {
  const lines = [];
  for (const f of report.findings ?? []) {
    const cmd = f.severity === "block" ? "error" : "warning";
    const title = `semctx: ${f.rule}`;
    const locs = f.locations ?? [];
    if (locs.length === 0) {
      lines.push(`::${cmd} title=${escProp(title)}::${escData(f.message)}`);
      continue;
    }
    for (const loc of locs) {
      const line = loc.line != null ? `,line=${loc.line}` : "";
      lines.push(`::${cmd} title=${escProp(title)},file=${escProp(loc.file)}${line}::${escData(f.message)}`);
    }
  }
  return lines;
}

function summaryFor(report) {
  const icon = report.verdict === "PASS" ? "✅" : report.verdict === "WARN" ? "⚠️" : "⛔";
  const rows = [];
  rows.push(`## ${icon} semctx — ${report.verdict}`);
  rows.push("");
  rows.push(`Range \`${report.range ?? "working tree"}\` · ${report.changedFiles?.length ?? 0} file(s) · ` +
    `${report.summary?.blockCount ?? 0} block · ${report.summary?.warnCount ?? 0} warn`);
  if ((report.findings ?? []).length > 0) {
    rows.push("", "| tier | rule | detail |", "| --- | --- | --- |");
    for (const f of report.findings) rows.push(`| ${f.tier} | \`${f.rule}\` | ${f.message.replace(/\|/g, "\\|")} |`);
  }
  if ((report.recommendedTests ?? []).length > 0) {
    rows.push("", "**Recommended tests:** " + report.recommendedTests.map((t) => `\`${t.file ?? t.name}\``).join(", "));
  }
  rows.push("", "_semctx maps a diff to affected symbols, contracts, invariants and tests. It is not a code-search tool._");
  return rows.join("\n") + "\n";
}

/** Pure decision function — testable without any GitHub environment. */
export function renderAction(report, failOn) {
  const shouldFail =
    (report.verdict === "BLOCK" && (failOn === "block" || failOn === "warn")) ||
    (report.verdict === "WARN" && failOn === "warn");
  return {
    annotations: annotationsFor(report),
    summary: summaryFor(report),
    outputs: {
      verdict: report.verdict,
      "block-count": String(report.summary?.blockCount ?? 0),
      "warn-count": String(report.summary?.warnCount ?? 0),
      "changed-symbol-count": String((report.changedSymbols ?? []).length),
      "recommended-test-count": String((report.recommendedTests ?? []).length),
    },
    exitCode: shouldFail ? 1 : 0,
  };
}

function setOutputs(outputs, reportPath) {
  const file = process.env.GITHUB_OUTPUT;
  const all = { ...outputs, "report-path": reportPath };
  if (!file) return;
  const body = Object.entries(all).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  appendFileSync(file, body);
}

function writeSummary(summary) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, summary);
}

function main() {
  const reportPath = process.argv[2];
  if (!reportPath) {
    process.stderr.write("adapter: missing report path argument\n");
    process.exit(2);
  }
  const failOn = (process.env.INPUT_FAIL_ON || "block").trim();
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (err) {
    process.stderr.write(`adapter: cannot read report at ${reportPath}: ${String(err)}\n`);
    process.exit(2);
  }
  const { annotations, summary, outputs, exitCode } = renderAction(report, failOn);
  for (const line of annotations) process.stdout.write(line + "\n");
  writeSummary(summary);
  setOutputs(outputs, reportPath);
  process.exit(exitCode);
}

// Run as a script, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("adapter.mjs")) {
  main();
}
