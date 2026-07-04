import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ADAPTER = join(import.meta.dir, "..", "src", "adapter.mjs");
const ACTION_YML = join(import.meta.dir, "..", "action.yml");

interface Report {
  schemaVersion: number;
  verdict: "PASS" | "WARN" | "BLOCK";
  range: string | null;
  changedFiles: string[];
  changedSymbols: Array<{ name: string }>;
  recommendedTests: Array<{ name: string; file?: string }>;
  findings: Array<{ rule: string; tier: string; severity: string; message: string; locations: Array<{ file: string; line?: number }> }>;
  summary: { blockCount: number; warnCount: number };
}

function report(verdict: Report["verdict"], findings: Report["findings"]): Report {
  return {
    schemaVersion: 1,
    verdict,
    range: "abc..def",
    changedFiles: ["src/a.ts"],
    changedSymbols: [{ name: "compute" }],
    recommendedTests: [{ name: "a.test.ts", file: "test/a.test.ts" }],
    findings,
    summary: {
      blockCount: findings.filter((f) => f.severity === "block").length,
      warnCount: findings.filter((f) => f.severity === "warn").length,
    },
  };
}

const BLOCK = report("BLOCK", [
  { rule: "invariant_touched_without_test", tier: "strict", severity: "block", message: "invariant-constrained code changed without a covering test: compute", locations: [{ file: "src/a.ts", line: 5 }] },
]);
const WARN = report("WARN", [
  { rule: "contract_changed_without_test", tier: "advisory", severity: "warn", message: "exported contract changed without a covering test: PublicPort", locations: [{ file: "src/a.ts", line: 8 }] },
]);
const PASS = report("PASS", []);

function runAdapter(rep: Report, failOn: string): { code: number; out: string; outputs: string; summary: string } {
  const dir = mkdtempSync(join(tmpdir(), "semctx-action-"));
  const reportPath = join(dir, "report.json");
  const outFile = join(dir, "gh_output");
  const sumFile = join(dir, "gh_summary");
  writeFileSync(reportPath, JSON.stringify(rep));
  const p = Bun.spawnSync(["node", ADAPTER, reportPath], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, INPUT_FAIL_ON: failOn, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: sumFile },
  });
  return {
    code: p.exitCode ?? 1,
    out: new TextDecoder().decode(p.stdout),
    outputs: existsSync(outFile) ? readFileSync(outFile, "utf8") : "",
    summary: existsSync(sumFile) ? readFileSync(sumFile, "utf8") : "",
  };
}

describe("github-action adapter", () => {
  it("emits annotations, summary and outputs for a BLOCK report", () => {
    const r = runAdapter(BLOCK, "block");
    expect(r.out).toMatch(/^::error /m);
    expect(r.out).toContain("file=src/a.ts,line=5");
    expect(r.summary).toContain("semctx — BLOCK");
    expect(r.outputs).toContain("verdict=BLOCK");
    expect(r.outputs).toContain("block-count=1");
    expect(r.outputs).toContain("changed-symbol-count=1");
    expect(r.outputs).toContain("recommended-test-count=1");
    expect(r.outputs).toContain("report-path=");
  });

  it("propagates verdicts through the fail-on exit code", () => {
    expect(runAdapter(BLOCK, "block").code).toBe(1);
    expect(runAdapter(BLOCK, "none").code).toBe(0);
    expect(runAdapter(WARN, "block").code).toBe(0); // WARN never fails by default
    expect(runAdapter(WARN, "warn").code).toBe(1);
    expect(runAdapter(PASS, "block").code).toBe(0);
  });

  it("uses ::warning for advisory findings", () => {
    const r = runAdapter(WARN, "none");
    expect(r.out).toMatch(/^::warning /m);
    expect(r.out).not.toMatch(/^::error /m);
  });

  it("action.yml declares the required inputs and outputs", () => {
    const yml = readFileSync(ACTION_YML, "utf8");
    for (const input of ["base:", "head:", "fail-on:", "working-directory:", "config-path:", "report-path:", "upload-report:"]) {
      expect(yml).toContain(input);
    }
    for (const output of ["verdict:", "block-count:", "warn-count:", "changed-symbol-count:", "recommended-test-count:", "report-path:"]) {
      expect(yml).toContain(output);
    }
    expect(yml).toContain("using: \"composite\"");
    // security: never the dangerous trigger, and the adapter is the enforcement point
    expect(yml).not.toContain("pull_request_target");
    // security: user-controlled inputs must be routed through env, never inlined into a run
    // script by the ${{ }} template engine (GitHub Actions injection).
    expect(yml).toContain("SEMCTX_BASE: ${{ inputs.base }}");
    expect(yml).toContain("INPUT_REPORT_PATH: ${{ inputs.report-path }}");
    expect(yml).not.toContain("--base \"${{ inputs.base }}\"");
    expect(yml).not.toContain("--head \"${{ inputs.head }}\"");
    expect(yml).not.toContain("adapter.mjs\" \"${{ inputs.report-path }}\"");
  });
});
