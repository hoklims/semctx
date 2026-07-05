import { describe, it, expect } from "bun:test";
import type { RepositoryGraph, VerifyReport, VerifyReportFinding, SemanticPolicyConfig } from "@semantic-context/core";
import type { SemanticModel, ChangeContract } from "@semantic-context/semantic-model";
import { verifyChangeContract, DEFAULT_SEMANTIC_POLICY, type RepositoryFacts } from "../src/index";

const POLICY: SemanticPolicyConfig = DEFAULT_SEMANTIC_POLICY;

function facts(): RepositoryFacts {
  const graph: RepositoryGraph = {
    nodes: [
      { id: "sym:function:x.ts:danger:5", kind: "function", name: "danger", filePath: "x.ts", exported: true, evidence: [{ filePath: "x.ts", startLine: 5, sourceKind: "code" }], tags: [], metadata: {} },
      { id: "inv:x", kind: "invariant", name: "x", evidence: [], tags: [], metadata: {} },
    ],
    edges: [{ id: "e1", kind: "constrained_by", from: "sym:function:x.ts:danger:5", to: "inv:x", evidence: [], metadata: {} }],
  };
  return { graph, claims: [], evidence: [] };
}

function warnReport(findings: VerifyReportFinding[]): VerifyReport {
  return {
    schemaVersion: 1, verdict: "WARN", base: null, head: "HEAD", mergeBase: null, range: null,
    changedFiles: ["x.ts"], changedSymbols: [{ id: "sym:function:x.ts:danger:5", name: "danger", kind: "function", file: "x.ts" }],
    impactedContracts: [], impactedInvariants: [], recommendedTests: [], contradictions: [], unknowns: [],
    findings, summary: { blockCount: 0, warnCount: findings.length },
  };
}

const WARN_FINDING: VerifyReportFinding = { rule: "contract_changed_without_test", tier: "advisory", severity: "warn", message: "x", nodeIds: ["sym:function:x.ts:danger:5"], locations: [] };

/** A change with no obligations of its own — isolates the underlying-report contribution. */
function bareChange(): ChangeContract {
  return { id: "change.c", statement: "c", lifecycle: "active", provenance: "agent", sourceRefs: [], serves: [], preserves: [], requiresEvidence: [], openUnknowns: [], repositoryLinks: [], tags: [] };
}

function invModel(tags: string[]): SemanticModel {
  return {
    nodes: [{ id: "invariant.i", kind: "invariant", statement: "I", status: "declared", provenance: "author", sourceRefs: [], repositoryLinks: [{ kind: "invariant", ref: "inv:x" }], relations: [], tags }],
    changes: [{ id: "change.c", statement: "c", lifecycle: "active", provenance: "agent", sourceRefs: [], serves: [], preserves: ["invariant.i"], requiresEvidence: [], openUnknowns: [], repositoryLinks: [], tags: [] }],
  };
}

describe("honesty: underlying WARN is never laundered into VERIFIED", () => {
  it("an underlying WARN with an otherwise-clean contract floors at PARTIAL", () => {
    const model: SemanticModel = { nodes: [], changes: [bareChange()] };
    const r = verifyChangeContract({ contract: bareChange(), model, facts: facts(), verifyReport: warnReport([WARN_FINDING]), policy: POLICY });
    expect(r.verdict).toBe("PARTIAL");
    expect(r.findings.some((f) => f.kind === "underlying_warn")).toBe(true);
  });
});

describe("honesty: an invariant touched under an advisory rule is never 'proved'", () => {
  it("non-critical → state unproven, verdict PARTIAL (not VERIFIED/proved)", () => {
    const model = invModel([]);
    const r = verifyChangeContract({ contract: model.changes[0]!, model, facts: facts(), verifyReport: warnReport([WARN_FINDING]), policy: POLICY });
    expect(r.preserved.find((p) => p.id === "invariant.i")?.state).toBe("unproven");
    expect(r.verdict).toBe("PARTIAL");
  });

  it("critical → BLOCKED even though the repo relaxed the rule to warn", () => {
    const model = invModel(["critical"]);
    const r = verifyChangeContract({ contract: model.changes[0]!, model, facts: facts(), verifyReport: warnReport([WARN_FINDING]), policy: POLICY });
    expect(r.preserved.find((p) => p.id === "invariant.i")?.state).toBe("unproven");
    expect(r.findings.some((f) => f.kind === "critical_invariant_unproven")).toBe(true);
    expect(r.verdict).toBe("BLOCKED");
  });

  it("a genuinely covered touch (no block/warn finding on it) is still 'proved'", () => {
    const model = invModel([]);
    const clean: VerifyReport = { ...warnReport([]), verdict: "PASS", summary: { blockCount: 0, warnCount: 0 } };
    const r = verifyChangeContract({ contract: model.changes[0]!, model, facts: facts(), verifyReport: clean, policy: POLICY });
    expect(r.preserved.find((p) => p.id === "invariant.i")?.state).toBe("proved");
    expect(r.verdict).toBe("VERIFIED");
  });
});
