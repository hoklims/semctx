import { describe, it, expect } from "bun:test";
import { GraphIndex, buildClaims, evaluateClaim, classifyQuestion, policyFor } from "@semantic-context/context-engine";
import { DIVERGENT_STATEMENT_TAG } from "@semantic-context/core";
import type { RepositoryGraph, TaskFrame } from "@semantic-context/core";

/**
 * HOK-79 marker authority: a `statement-divergent` node must never yield an authorizing claim,
 * however strong the surrounding evidence looks in isolation. These build a synthetic graph
 * directly — no dependency on the shared sample-repository fixture — so the assertion holds
 * whatever that fixture's own contents happen to be.
 */

function taskFrame(): TaskFrame {
  return {
    id: "task:divergence-hostile",
    rawTask: "Change the confirmation path",
    mode: "bugfix",
    createdAt: "2026-01-01T00:00:00.000Z",
    capabilities: [],
    observedBehavior: [],
    expectedBehavior: [],
    boundedContexts: [],
    hardInvariants: [],
    softConstraints: [],
    acceptanceEvidence: [],
    nonGoals: [],
    riskSurfaces: [],
    hypotheses: [],
  };
}

describe("buildClaims — a contested statement is never authorizing (HOK-79)", () => {
  it("an invariant tagged statement-divergent never reads 'tested', even with a passing test", () => {
    const graph: RepositoryGraph = {
      nodes: [
        {
          id: "sym:function:x.ts:danger",
          kind: "function",
          name: "danger",
          filePath: "x.ts",
          evidence: [{ filePath: "x.ts", startLine: 1, endLine: 3, sourceKind: "code" }],
          tags: [],
          metadata: {},
        },
        {
          id: "test:x.test.ts",
          kind: "test",
          name: "x.test.ts",
          filePath: "x.test.ts",
          evidence: [{ filePath: "x.test.ts", sourceKind: "test" }],
          tags: [],
          metadata: {},
        },
        {
          id: "inv:must-hold",
          kind: "invariant",
          name: "must-hold",
          evidence: [],
          // Already degraded: no `metadata.statement` survives a divergence, only the tag does.
          tags: [DIVERGENT_STATEMENT_TAG],
          metadata: {},
        },
      ],
      edges: [
        { id: "e:constrained", kind: "constrained_by", from: "sym:function:x.ts:danger", to: "inv:must-hold", evidence: [], metadata: {} },
        { id: "e:tested", kind: "tested_by", from: "sym:function:x.ts:danger", to: "test:x.test.ts", evidence: [], metadata: {} },
      ],
    };
    const claims = buildClaims(new GraphIndex(graph));
    const inv = claims.find((c) => c.kind === "invariant");
    expect(inv).toBeDefined();
    expect(inv!.verificationStatus).not.toBe("tested");
    expect(inv!.verificationStatus).toBe("contradicted");
    expect(inv!.authority).toBeLessThan(0.2);
  });

  it("a capability tagged statement-divergent never reads 'tested'", () => {
    const graph: RepositoryGraph = {
      nodes: [
        {
          id: "sym:function:x.ts:handle",
          kind: "function",
          name: "handle",
          filePath: "x.ts",
          evidence: [{ filePath: "x.ts", startLine: 1, endLine: 3, sourceKind: "code" }],
          tags: [],
          metadata: {},
        },
        {
          id: "test:x.test.ts",
          kind: "test",
          name: "x.test.ts",
          filePath: "x.test.ts",
          evidence: [{ filePath: "x.test.ts", sourceKind: "test" }],
          tags: [],
          metadata: {},
        },
        {
          id: "cap:checkout",
          kind: "capability",
          name: "checkout",
          evidence: [],
          tags: [DIVERGENT_STATEMENT_TAG],
          metadata: {},
        },
      ],
      edges: [
        { id: "e:implements", kind: "implements_capability", from: "sym:function:x.ts:handle", to: "cap:checkout", evidence: [], metadata: {} },
        { id: "e:tested", kind: "tested_by", from: "sym:function:x.ts:handle", to: "test:x.test.ts", evidence: [], metadata: {} },
      ],
    };
    const claims = buildClaims(new GraphIndex(graph));
    const cap = claims.find((c) => c.kind === "capability");
    expect(cap).toBeDefined();
    expect(cap!.verificationStatus).not.toBe("tested");
    expect(cap!.verificationStatus).toBe("contradicted");
  });

  it("a @contract marker node tagged statement-divergent never reads 'statically_verified'", () => {
    const graph: RepositoryGraph = {
      nodes: [
        {
          id: "sym:function:x.ts:declares",
          kind: "function",
          name: "declares",
          filePath: "x.ts",
          evidence: [{ filePath: "x.ts", startLine: 1, endLine: 3, sourceKind: "code" }],
          tags: [],
          metadata: {},
        },
        {
          id: "contract:payment-port",
          kind: "contract",
          name: "payment-port",
          evidence: [],
          tags: [DIVERGENT_STATEMENT_TAG],
          metadata: {},
        },
      ],
      edges: [
        { id: "e:declares", kind: "declares", from: "sym:function:x.ts:declares", to: "contract:payment-port", evidence: [], metadata: {} },
      ],
    };
    const claims = buildClaims(new GraphIndex(graph));
    const contract = claims.find((c) => c.kind === "contract");
    expect(contract).toBeDefined();
    expect(contract!.verificationStatus).not.toBe("statically_verified");
    expect(contract!.verificationStatus).toBe("contradicted");
  });

  it("a contested invariant claim is gated out of authority by status, not by low score", () => {
    const graph: RepositoryGraph = {
      nodes: [
        {
          id: "sym:function:x.ts:danger",
          kind: "function",
          name: "danger",
          filePath: "x.ts",
          evidence: [{ filePath: "x.ts", startLine: 1, endLine: 3, sourceKind: "code" }],
          tags: [],
          metadata: {},
        },
        {
          id: "test:x.test.ts",
          kind: "test",
          name: "x.test.ts",
          filePath: "x.test.ts",
          evidence: [{ filePath: "x.test.ts", sourceKind: "test" }],
          tags: [],
          metadata: {},
        },
        {
          id: "inv:must-hold",
          kind: "invariant",
          name: "must-hold",
          evidence: [],
          tags: [DIVERGENT_STATEMENT_TAG],
          metadata: {},
        },
      ],
      edges: [
        { id: "e:constrained", kind: "constrained_by", from: "sym:function:x.ts:danger", to: "inv:must-hold", evidence: [], metadata: {} },
        { id: "e:tested", kind: "tested_by", from: "sym:function:x.ts:danger", to: "test:x.test.ts", evidence: [], metadata: {} },
      ],
    };
    const claims = buildClaims(new GraphIndex(graph));
    const inv = claims.find((c) => c.kind === "invariant")!;
    const frame = taskFrame();
    const explanation = evaluateClaim(inv, {
      index: new GraphIndex(graph),
      taskFrame: frame,
      policy: policyFor(classifyQuestion(frame)),
      entrypoints: new Set<string>(),
      reachable: new Map<string, number>(),
      contradictedClaimIds: new Set<string>([inv.id]),
    });
    expect(explanation.eligible).toBe(false);
    expect(explanation.gates.find((g) => g.name === "status-allowed")?.passed).toBe(false);
  });
});
