import { describe, it, expect } from "bun:test";
import { analyzeAndBuildClaims, GraphIndex, analyzeDiff, parseUnifiedDiff, buildVerifyReport } from "@semantic-context/context-engine";
import { createDefaultConfig } from "@semantic-context/core";
import type { RepositoryGraph, Claim } from "@semantic-context/core";
import { sampleConfig, must } from "@semantic-context/test-fixtures";

describe("parseUnifiedDiff", () => {
  it("extracts changed files and new-side hunks", () => {
    const diff = [
      "diff --git a/src/x.ts b/src/x.ts",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -10,2 +10,3 @@",
      "+added",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files.length).toBe(1);
    const file = must(files[0]);
    expect(file.filePath).toBe("src/x.ts");
    expect(must(file.hunks[0]).newStart).toBe(10);
    expect(must(file.hunks[0]).newLines).toBe(3);
  });

  it("ignores deleted files (/dev/null)", () => {
    const diff = ["--- a/gone.ts", "+++ /dev/null", "@@ -1,3 +0,0 @@"].join("\n");
    expect(parseUnifiedDiff(diff).length).toBe(0);
  });
});

describe("analyzeDiff on the fixture", () => {
  const { analysis, claims } = analyzeAndBuildClaims(sampleConfig());
  const index = new GraphIndex(analysis.graph);
  const config = sampleConfig();
  const confirm = must(analysis.graph.nodes.find((n) => n.name === "confirmReservation"));
  const line = must(confirm.evidence[0]).startLine ?? 12;

  it("maps a change in the confirmation body to the invariant and its test", () => {
    const diff = `--- a/src/domain/confirmation.ts\n+++ b/src/domain/confirmation.ts\n@@ -${line} +${line},1 @@\n-old\n+new\n`;
    const result = analyzeDiff({ index, claims, config, diffText: diff });
    expect(result.impactedInvariants.length).toBeGreaterThan(0);
    expect(result.recommendedTests.map((t) => t.filePath)).toContain("test/confirmation.test.ts");
    // The invariant is tested, so no blocking violation.
    expect(result.verdict).toBe("PASS");
  });

  it("reports PASS on an empty diff", () => {
    const result = analyzeDiff({ index, claims, config, diffText: "" });
    expect(result.verdict).toBe("PASS");
    expect(result.changedFiles.length).toBe(0);
  });
});

describe("analyzeDiff BLOCK — invariant touched without a test", () => {
  const graph: RepositoryGraph = {
    nodes: [
      { id: "mod:x.ts", kind: "module", name: "x.ts", filePath: "x.ts", evidence: [{ filePath: "x.ts", sourceKind: "code" }], tags: [], metadata: {} },
      { id: "sym:function:x.ts:danger:5", kind: "function", name: "danger", filePath: "x.ts", exported: true, evidence: [{ filePath: "x.ts", startLine: 5, endLine: 10, sourceKind: "code" }], tags: [], metadata: {} },
      { id: "inv:must-hold", kind: "invariant", name: "must-hold", evidence: [], tags: [], metadata: { statement: "x must hold" } },
    ],
    edges: [
      { id: "e:constrained", kind: "constrained_by", from: "sym:function:x.ts:danger:5", to: "inv:must-hold", evidence: [], metadata: {} },
    ],
  };
  const claims: Claim[] = [
    {
      id: "claim:invariant:x",
      kind: "invariant",
      statement: "x must hold",
      subjectNodeIds: ["sym:function:x.ts:danger:5", "inv:must-hold"],
      evidenceIds: [],
      authority: 0.4,
      freshness: 0.6,
      confidence: 0.4,
      verificationStatus: "inferred",
      tags: ["invariant"],
    },
  ];
  const config = createDefaultConfig("/repo");

  it("blocks when invariant-constrained code changes with no covering test", () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -6 +6,2 @@\n+danger changed\n";
    const result = analyzeDiff({ index: new GraphIndex(graph), claims, config, diffText: diff });
    expect(result.verdict).toBe("BLOCK");
    const finding = must(result.findings.find((f) => f.rule === "invariant_touched_without_test"));
    expect(finding.severity).toBe("block");
    expect(finding.nodeIds).toContain("sym:function:x.ts:danger:5");
  });
});

describe("analyzeDiff BLOCK — security surface changed without verification", () => {
  const graph: RepositoryGraph = {
    nodes: [
      { id: "mod:auth.ts", kind: "module", name: "auth.ts", filePath: "auth.ts", evidence: [{ filePath: "auth.ts", sourceKind: "code" }], tags: [], metadata: {} },
      { id: "sym:function:auth.ts:verifyToken:5", kind: "function", name: "verifyToken", filePath: "auth.ts", exported: true, evidence: [{ filePath: "auth.ts", startLine: 5, endLine: 12, sourceKind: "code" }], tags: ["security"], metadata: {} },
    ],
    edges: [],
  };
  const config = createDefaultConfig("/repo");

  it("blocks when a security-tagged symbol changes with no covering test", () => {
    const diff = "--- a/auth.ts\n+++ b/auth.ts\n@@ -6 +6,2 @@\n+token logic changed\n";
    const result = analyzeDiff({ index: new GraphIndex(graph), claims: [], config, diffText: diff });
    expect(result.verdict).toBe("BLOCK");
    const finding = must(result.findings.find((f) => f.rule === "security_surface_without_verification"));
    expect(finding.severity).toBe("block");
    expect(finding.nodeIds).toContain("sym:function:auth.ts:verifyToken:5");
  });
});

describe("severity tiers — critical contract (strict/BLOCK) vs plain contract (advisory/WARN)", () => {
  const config = createDefaultConfig("/repo");
  const contractGraph = (tags: string[]): RepositoryGraph => ({
    nodes: [
      { id: "mod:api.ts", kind: "module", name: "api.ts", filePath: "api.ts", evidence: [{ filePath: "api.ts", sourceKind: "code" }], tags: [], metadata: {} },
      { id: "sym:interface:api.ts:PaymentPort:5", kind: "interface", name: "PaymentPort", filePath: "api.ts", exported: true, evidence: [{ filePath: "api.ts", startLine: 5, endLine: 12, sourceKind: "code" }], tags, metadata: {} },
    ],
    edges: [],
  });
  const diff = "--- a/api.ts\n+++ b/api.ts\n@@ -6 +6,2 @@\n+  refund(id: string): void;\n";

  it("BLOCKs when a critical-tagged exported contract changes with no covering test", () => {
    const result = analyzeDiff({ index: new GraphIndex(contractGraph(["critical"])), claims: [], config, diffText: diff });
    expect(result.verdict).toBe("BLOCK");
    const finding = must(result.findings.find((f) => f.rule === "critical_contract_changed_without_test"));
    expect(finding.severity).toBe("block");
    expect(finding.nodeIds).toContain("sym:interface:api.ts:PaymentPort:5");
  });

  it("only WARNs when the same contract is not tagged critical", () => {
    const result = analyzeDiff({ index: new GraphIndex(contractGraph([])), claims: [], config, diffText: diff });
    expect(result.verdict).toBe("WARN");
    expect(result.findings.some((f) => f.rule === "contract_changed_without_test")).toBe(true);
    expect(result.findings.some((f) => f.rule === "critical_contract_changed_without_test")).toBe(false);
  });
});

describe("buildVerifyReport — stable machine contract (ADR 0008)", () => {
  const graph: RepositoryGraph = {
    nodes: [
      { id: "mod:x.ts", kind: "module", name: "x.ts", filePath: "x.ts", evidence: [{ filePath: "x.ts", sourceKind: "code" }], tags: [], metadata: {} },
      { id: "sym:function:x.ts:danger:5", kind: "function", name: "danger", filePath: "x.ts", exported: true, evidence: [{ filePath: "x.ts", startLine: 5, endLine: 10, sourceKind: "code" }], tags: [], metadata: {} },
      { id: "inv:must-hold", kind: "invariant", name: "must-hold", evidence: [], tags: [], metadata: { statement: "x must hold" } },
    ],
    edges: [
      { id: "e:constrained", kind: "constrained_by", from: "sym:function:x.ts:danger:5", to: "inv:must-hold", evidence: [], metadata: {} },
    ],
  };
  const config = createDefaultConfig("/repo");
  const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -6 +6,2 @@\n+danger changed\n";

  it("projects verdict, changed symbols, findings with tier+locations, and summary counts", () => {
    const result = analyzeDiff({ index: new GraphIndex(graph), claims: [], config, diffText: diff });
    const report = buildVerifyReport(
      result,
      { base: "origin/main", head: "HEAD", mergeBase: "abc123def456", range: "abc123def456..0011223344" },
      config.blockingRules,
    );
    expect(report.schemaVersion).toBe(1);
    expect(report.verdict).toBe("BLOCK");
    expect(report.base).toBe("origin/main");
    expect(report.range).toBe("abc123def456..0011223344");
    expect(report.changedFiles).toContain("x.ts");
    expect(report.changedSymbols.map((s) => s.name)).toContain("danger");
    const finding = must(report.findings.find((f) => f.rule === "invariant_touched_without_test"));
    expect(finding.tier).toBe("strict");
    expect(finding.severity).toBe("block");
    expect(finding.locations.some((l) => l.file === "x.ts")).toBe(true);
    expect(report.summary.blockCount).toBeGreaterThanOrEqual(1);
    expect(report.summary.warnCount).toBe(0);
  });

  it("carries the git meta as null for a working-tree (non-base) analysis", () => {
    const result = analyzeDiff({ index: new GraphIndex(graph), claims: [], config, diffText: "" });
    const report = buildVerifyReport(result, { base: null, head: "HEAD", mergeBase: null, range: null }, config.blockingRules);
    expect(report.base).toBeNull();
    expect(report.mergeBase).toBeNull();
    expect(report.range).toBeNull();
    expect(report.verdict).toBe("PASS");
  });
});
