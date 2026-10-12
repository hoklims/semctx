import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { VerifyReport } from "@semantic-context/core";

const ADAPTER = join(import.meta.dir, "..", "src", "adapter.mjs");
const ACTION_YML = join(import.meta.dir, "..", "action.yml");

type Report = VerifyReport;

function report(verdict: Report["verdict"], findings: Report["findings"]): Report {
  return {
    schemaVersion: 1,
    verdict,
    base: "origin/main",
    head: "HEAD",
    mergeBase: "abc",
    range: "abc..def",
    changedFiles: ["src/a.ts"],
    changedSymbols: [{ id: "symbol:compute", name: "compute", kind: "function", file: "src/a.ts" }],
    impactedContracts: [],
    impactedInvariants: [],
    recommendedTests: [{ name: "a.test.ts", file: "test/a.test.ts" }],
    contradictions: [],
    unknowns: [],
    findings,
    summary: {
      blockCount: findings.filter((f) => f.severity === "block").length,
      warnCount: findings.filter((f) => f.severity === "warn").length,
    },
  };
}

const BLOCK = report("BLOCK", [
  { rule: "invariant_touched_without_test", tier: "strict", severity: "block", message: "invariant-constrained code changed without a covering test: compute", nodeIds: [], locations: [{ file: "src/a.ts", line: 5 }] },
]);
const WARN = report("WARN", [
  { rule: "contract_changed_without_test", tier: "advisory", severity: "warn", message: "exported contract changed without a covering test: PublicPort", nodeIds: [], locations: [{ file: "src/a.ts", line: 8 }] },
]);
const PASS = report("PASS", []);

function runAdapter(rep: unknown, failOn: string, requireQualified = "false"): { code: number; out: string; err: string; outputs: string; summary: string } {
  const dir = mkdtempSync(join(tmpdir(), "semctx-action-"));
  const reportPath = join(dir, "report.json");
  const outFile = join(dir, "gh_output");
  const sumFile = join(dir, "gh_summary");
  writeFileSync(reportPath, JSON.stringify(rep));
  const p = Bun.spawnSync(["node", ADAPTER, reportPath], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, INPUT_FAIL_ON: failOn, INPUT_REQUIRE_QUALIFIED: requireQualified, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: sumFile },
  });
  return {
    code: p.exitCode ?? 1,
    out: new TextDecoder().decode(p.stdout),
    err: new TextDecoder().decode(p.stderr),
    outputs: existsSync(outFile) ? readFileSync(outFile, "utf8") : "",
    summary: existsSync(sumFile) ? readFileSync(sumFile, "utf8") : "",
  };
}

function admittedReport(): Report {
  const digest = `sha256:${"0".repeat(64)}`;
  const file = { path: "src/a.ts", status: "analyzed" as const, reasons: [] };
  return { ...PASS, changedFiles: [...PASS.changedFiles], analysisAdmission: {
    schemaVersion: 1, profile: "modelo-suite-static-v1", status: "admitted",
    identity: { source: digest, sourceCommits: ["0".repeat(40)], baseCommit: null, diff: digest, config: digest, analyzer: digest, indexSnapshot: digest },
    binding: { status: "valid", reasons: [] }, indexFreshness: { verdict: "FRESH", reasons: [] }, controlFreshness: { verdict: "FRESH", reasons: [] }, checkFreshness: { status: "current", reasons: [] },
    repositoryCoverage: { status: "complete", files: [file] },
    changeCoverage: { expected: [file.path], analyzed: [file.path], files: [file] }, reasons: [], limitations: [], proofObligations: [],
  } };
}

describe("github-action adapter", () => {
  it("rejects admitted changed files outside coverage before emitting Action outputs", () => {
    expect(runAdapter(admittedReport(), "none", "true").code).toBe(0);
    const uncovered = admittedReport(); uncovered.changedFiles.push("src/unreviewed.ts");
    const failed = admittedReport();
    failed.analysisAdmission!.repositoryCoverage.files.push({ path: "src/failed.ts", status: "failed", reasons: ["PRODUCER_FAILED"] });
    for (const contradictory of [uncovered, failed]) {
      const result = runAdapter(contradictory, "none", "true");
      expect(result.code).toBe(2);
      expect(result.err).toContain("adapter: unusable verify report");
      expect(result.out).toBe("");
      expect(result.outputs).toBe("");
      expect(result.summary).toBe("");
    }
  });

  it("trusted require-qualified refuses an ordinary PASS report without admission", () => {
    const result = runAdapter(PASS, "none", "true");
    expect(result.code).toBe(1);
    expect(result.outputs).toContain("verdict=BLOCK");
    expect(result.summary).toContain("Action policy BLOCK");
    expect(result.out).toContain("qualification_required");
    expect(PASS.verdict).toBe("PASS");
  });
  it("ordinary policy stays optional and malformed requirements fail closed", () => {
    expect(runAdapter(PASS,"none","false").code).toBe(0);
    const result=runAdapter(PASS,"none","yes\n::warning::untrusted-policy");
    expect(result.code).toBe(2);expect(result.err).toContain("unknown require-qualified policy");
    expect(result.err).not.toContain("::warning");
    expect(result.outputs).toBe("");
  });
  it("trusted requirement accepts an admitted named profile and refuses malformed profiles", () => {
    const digest=`sha256:${"0".repeat(64)}`;
    const qualified:Report={...PASS,analysisAdmission:{
      schemaVersion:1,profile:"modelo-suite-static-v1",status:"admitted",
      identity:{source:digest,sourceCommits:["0".repeat(40)],baseCommit:null,diff:digest,config:digest,analyzer:digest,indexSnapshot:digest},
      binding:{status:"valid",reasons:[]},indexFreshness:{verdict:"FRESH",reasons:[]},controlFreshness:{verdict:"FRESH",reasons:[]},checkFreshness:{status:"current",reasons:[]},
      repositoryCoverage:{status:"complete",files:[{path:"src/a.ts",status:"analyzed",reasons:[]}]},
      changeCoverage:{expected:["src/a.ts"],analyzed:["src/a.ts"],files:[{path:"src/a.ts",status:"analyzed",reasons:[]}]},reasons:[],limitations:[],proofObligations:[],
    }};
    expect(runAdapter(qualified,"none","true").code).toBe(0);
    expect(runAdapter({...qualified,analysisAdmission:{...qualified.analysisAdmission,profile:"unknown"}},"none","true").code).toBe(2);
  });
  it("refuses qualified rejection even with advisory none policy", () => {
    const digest = `sha256:${"0".repeat(64)}`;
    const qualified: Report = { ...BLOCK, analysisAdmission: {
      schemaVersion: 1, profile: "modelo-suite-static-v1", status: "rejected",
      identity: { source: digest, sourceCommits: ["0".repeat(40)], baseCommit: null, diff: digest, config: digest, analyzer: digest, indexSnapshot: digest },
      binding: { status: "valid", reasons: [] }, indexFreshness: { verdict: "STALE", reasons: ["ANALYSIS_INPUT_MISMATCH"] },
      controlFreshness: { verdict: "STALE", reasons: ["ANALYSIS_INPUT_MISMATCH"] }, checkFreshness: { status: "current", reasons: [] },
      repositoryCoverage: { status: "partial", files: [] }, changeCoverage: { expected: ["src/a.ts"], analyzed: [], files: [{ path: "src/a.ts", status: "missing", reasons: ["NO_CURRENT_ANALYZED_SOURCE"] }] },
      reasons: ["INDEX_NOT_FRESH"], limitations: ["Static analysis only."], proofObligations: [],
    } };
    expect(runAdapter(qualified, "none").code).toBe(1);
  });
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

  it("refuses readable reports whose verdict is absent, stale, unsealed, or unknown", () => {
    for (const verdict of [undefined, "STALE", "UNSEALED", "UNKNOWN"]) {
      const invalid = { ...PASS, verdict };
      const r = runAdapter(invalid, "none");
      expect(r.code).toBe(2);
      expect(r.err).toContain("adapter: unusable verify report");
    }
  });

  it("refuses incomplete, null, array, and future-schema readable reports", () => {
    for (const invalid of [{ verdict: "PASS" }, null, [], { ...PASS, schemaVersion: 2 }]) {
      const r = runAdapter(invalid, "none");
      expect(r.code).toBe(2);
      expect(r.err).toContain("adapter: unusable verify report");
      expect(r.out).toBe("");
      expect(r.outputs).toBe("");
      expect(r.summary).toBe("");
    }
  });

  it("refuses an unknown fail-on policy", () => {
    const r = runAdapter(PASS, "bogus");
    expect(r.code).toBe(2);
    expect(r.err).toContain("adapter: unknown fail-on policy: bogus");
  });

  it("refuses a non-numeric finding line before emitting workflow commands", () => {
    const hostile = report("BLOCK", [{
      rule: "bad_line",
      tier: "strict",
      severity: "block",
      message: "invalid location line",
      nodeIds: [],
      locations: [{ file: "src/a.ts", line: "5,endLine=9" as unknown as number }],
    }]);

    const r = runAdapter(hostile, "none");
    expect(r.code).toBe(2);
    expect(r.err).toContain("adapter: unusable verify report");
    expect(r.out).toBe("");
    expect(r.out).not.toContain("line=");
    expect(r.out).not.toContain("endLine=");
  });

  it("keeps hostile finding text inside its Markdown table cell", () => {
    const hostile = report("WARN", [
      {
        rule: "unsafe|<rule>",
        tier: "advisory",
        severity: "warn",
        message: "before\\|<details>&after\rnext\nlast\r\nend",
        nodeIds: [],
        locations: [],
      },
    ]);

    const r = runAdapter(hostile, "none");
    expect(r.summary).toContain(
      "| advisory | `unsafe&#124;&lt;rule&gt;` | before\\&#124;&lt;details&gt;&amp;after<br>next<br>last<br>end |",
    );
    expect(r.summary).not.toContain("<details>");
    expect(r.summary).not.toContain("\r");
  });

  it("action.yml declares the required inputs and outputs", () => {
    const yml = readFileSync(ACTION_YML, "utf8");
    expect(yml).toContain('bun-version: "1.4.0"');
    for (const input of ["base:", "head:", "fail-on:", "require-qualified:", "working-directory:", "config-path:", "report-path:", "upload-report:"]) {
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
    expect(yml).toContain("INPUT_REQUIRE_QUALIFIED: ${{ inputs.require-qualified }}");
    expect(yml).not.toContain("--base \"${{ inputs.base }}\"");
    expect(yml).not.toContain("--head \"${{ inputs.head }}\"");
    expect(yml).not.toContain("adapter.mjs\" \"${{ inputs.report-path }}\"");
  });
});
