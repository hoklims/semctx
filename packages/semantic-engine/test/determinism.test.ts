import { describe, it, expect } from "bun:test";
import type { RepositoryGraph, VerifyReport } from "@semantic-context/core";
import type { SemanticModel, SemanticNode } from "@semantic-context/semantic-model";
import { sliceSemanticModel, verifyChangeContract, buildHandoffCapsule, DEFAULT_SEMANTIC_POLICY, type RepositoryFacts } from "../src/index";

function facts(): RepositoryFacts {
  const graph: RepositoryGraph = {
    nodes: [
      { id: "inv:x", kind: "invariant", name: "x", evidence: [], tags: [], metadata: {} },
      { id: "sym:function:x.ts:danger:5", kind: "function", name: "danger", filePath: "x.ts", exported: true, evidence: [{ filePath: "x.ts", startLine: 5, sourceKind: "code" }], tags: [], metadata: {} },
    ],
    edges: [{ id: "e1", kind: "constrained_by", from: "sym:function:x.ts:danger:5", to: "inv:x", evidence: [], metadata: {} }],
  };
  return { graph, claims: [], evidence: [] };
}

function nodes(): SemanticNode[] {
  return [
    { id: "goal.g", kind: "goal", statement: "G", status: "declared", provenance: "author", sourceRefs: [], repositoryLinks: [], relations: [], tags: [] },
    { id: "invariant.i", kind: "invariant", statement: "I", status: "declared", provenance: "author", sourceRefs: [], repositoryLinks: [{ kind: "invariant", ref: "inv:x" }], relations: [{ kind: "serves", to: "goal.g" }], tags: ["critical"] },
    { id: "proof.p", kind: "evidence", statement: "P", status: "declared", provenance: "author", sourceRefs: [], repositoryLinks: [], relations: [], tags: [] },
    { id: "unknown.u", kind: "unknown", statement: "U", status: "declared", provenance: "author", sourceRefs: [], repositoryLinks: [], relations: [], tags: [] },
  ];
}

function model(order: SemanticNode[]): SemanticModel {
  return {
    nodes: order,
    changes: [{ id: "change.c", statement: "C", lifecycle: "active", provenance: "agent", sourceRefs: [], serves: ["goal.g"], preserves: ["invariant.i"], requiresEvidence: ["proof.p"], openUnknowns: ["unknown.u"], repositoryLinks: [{ kind: "symbol", ref: "sym:function:x.ts:danger:5" }], tags: [] }],
  };
}

const report: VerifyReport = {
  schemaVersion: 1, verdict: "PASS", base: null, head: "HEAD", mergeBase: null, range: null,
  changedFiles: [], changedSymbols: [], impactedContracts: [], impactedInvariants: [], recommendedTests: [],
  contradictions: [], unknowns: [], findings: [], summary: { blockCount: 0, warnCount: 0 },
};

describe("determinism", () => {
  it("produces byte-identical slices across runs and input orderings", () => {
    const a = JSON.stringify(sliceSemanticModel(model(nodes()), { changeId: "change.c" }));
    const b = JSON.stringify(sliceSemanticModel(model(nodes()), { changeId: "change.c" }));
    const shuffled = nodes().reverse();
    const c = JSON.stringify(sliceSemanticModel(model(shuffled), { changeId: "change.c" }));
    expect(a).toBe(b);
    expect(a).toBe(c); // order of declaration must not change the slice
  });

  it("produces byte-identical composed verify reports across runs", () => {
    const run = () => JSON.stringify(verifyChangeContract({ contract: model(nodes()).changes[0]!, model: model(nodes()), facts: facts(), verifyReport: report, policy: DEFAULT_SEMANTIC_POLICY }));
    expect(run()).toBe(run());
  });

  it("produces byte-identical handoff capsules for a fixed clock", () => {
    const now = "2026-07-05T00:00:00.000Z";
    const m = model(nodes());
    const run = () => JSON.stringify(buildHandoffCapsule({ root: "/repo", now, model: m, activeChange: m.changes[0] }));
    expect(run()).toBe(run());
  });
});
