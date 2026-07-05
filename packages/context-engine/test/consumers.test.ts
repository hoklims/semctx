import { describe, it, expect } from "bun:test";
import { GraphIndex, analyzeDiff, buildVerifyReport } from "@semantic-context/context-engine";
import { createDefaultConfig } from "@semantic-context/core";
import type { RepositoryGraph, RepositoryNode, RepositoryEdge, NodeKind, EdgeKind } from "@semantic-context/core";

function node(id: string, kind: NodeKind, filePath: string, exported: boolean, line?: number): RepositoryNode {
  return {
    id,
    kind,
    name: id,
    filePath,
    exported,
    evidence: line === undefined ? [] : [{ filePath, startLine: line, endLine: line, sourceKind: "code" }],
    tags: [],
    metadata: {},
  };
}

function edge(kind: EdgeKind, from: string, to: string): RepositoryEdge {
  return { id: `${kind}:${from}->${to}`, kind, from, to, evidence: [], metadata: {} };
}

// Graph: exported function F (src/a.ts) called by G (src/b.ts); module modB imports module modA.
// Exported interface C (src/a.ts) declared by modA. Consumers of a change to a.ts symbols must
// surface G (symbol-level caller) and modB (file-level importer of the declaring module).
function fixtureGraph(): RepositoryGraph {
  return {
    nodes: [
      node("F", "function", "src/a.ts", true, 1),
      node("C", "interface", "src/a.ts", true, 5),
      node("G", "function", "src/b.ts", true, 1),
      node("D", "function", "src/c.ts", true, 1),
      node("modA", "module", "src/a.ts", false),
      node("modB", "module", "src/b.ts", false),
      node("modC", "module", "src/c.ts", false),
    ],
    edges: [
      edge("calls", "G", "F"),
      edge("declares", "modA", "F"),
      edge("declares", "modA", "C"),
      edge("declares", "modB", "G"),
      edge("declares", "modC", "D"),
      edge("imports", "modB", "modA"),
    ],
  };
}

const consumersOf = (
  result: ReturnType<typeof analyzeDiff>,
  symbolId: string,
): string[] => {
  const entry = result.impactedConsumers.find((c) => c.symbol.id === symbolId);
  return (entry?.consumers ?? []).map((n) => n.id).sort();
};

describe("impacted consumers", () => {
  const index = new GraphIndex(fixtureGraph());
  const config = createDefaultConfig(".");
  const touch = (line: number) => `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -${line} +${line},1 @@\n-old\n+new\n`;

  it("lists symbol-level callers AND file-level importers of an impacted exported function", () => {
    const result = analyzeDiff({ index, claims: [], config, diffText: touch(1) });
    // F impacted; G calls F (symbol), modB imports modA which declares F (module).
    expect(consumersOf(result, "F")).toEqual(["G", "modB"]);
  });

  it("lists importers of the declaring module for an impacted exported interface", () => {
    const result = analyzeDiff({ index, claims: [], config, diffText: touch(5) });
    // C impacted; no call edge to a type, but modB imports its declaring module modA.
    expect(consumersOf(result, "C")).toEqual(["modB"]);
  });

  it("omits symbols with no in-repo consumers and projects into the report additively", () => {
    const result = analyzeDiff({ index, claims: [], config, diffText: touch(1) });
    const report = buildVerifyReport(result, { base: null, head: "HEAD", mergeBase: null, range: null }, config.blockingRules);
    const fEntry = report.impactedConsumers?.find((c) => c.symbol.id === "F");
    expect(fEntry).toBeDefined();
    expect(fEntry?.consumers.map((c) => c.id).sort()).toEqual(["G", "modB"]);
    // G is exported and impacted only if b.ts changes; here it must not appear as a subject.
    expect(report.impactedConsumers?.some((c) => c.symbol.id === "G")).toBe(false);
  });

  it("omits an impacted export that has no in-repo consumer, and the report field entirely", () => {
    // D is exported and impacted, but nothing imports its module (modC) or calls it.
    const result = analyzeDiff({ index, claims: [], config, diffText: "--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1 +1,1 @@\n-old\n+new\n" });
    expect(result.impactedConsumers.some((c) => c.symbol.id === "D")).toBe(false);
    const report = buildVerifyReport(result, { base: null, head: "HEAD", mergeBase: null, range: null }, config.blockingRules);
    expect("impactedConsumers" in report).toBe(false);
  });
});
