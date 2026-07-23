import { describe, expect, test } from "bun:test";
import type { RepositoryGraph } from "@semantic-context/core";
import type { SemanticModel } from "@semantic-context/semantic-model";
import { buildCoordinateGraph, explainWhy, fingerprintCoordinateGraph, impact, lift, lower } from "../src";

const repositoryGraph: RepositoryGraph = {
  nodes: [
    node("repo", "repository", "Repository"),
    node("module:a", "module", "Module A"),
    node("fn:a", "function", "a"),
    node("cap:a", "capability", "Capability A"),
  ],
  edges: [
    edge("declares-module", "declares", "repo", "module:a"),
    edge("declares-fn", "declares", "module:a", "fn:a"),
    edge("implements-cap", "implements_capability", "module:a", "cap:a"),
  ],
};
const repositoryFacts = { graph: repositoryGraph, claims: [], evidence: [] };
const semanticModel: SemanticModel = {
  nodes: [
    semantic("goal.a", "goal", "Keep changes safe", [], []),
    semantic("invariant.a", "invariant", "Behavior remains stable", [{ kind: "serves", to: "goal.a" }], [{ kind: "capability", ref: "cap:a" }]),
    semantic("unknown.a", "unknown", "Runtime dependencies unknown", [], []),
  ],
  changes: [{ id: "change.a", statement: "Migrate", lifecycle: "draft", provenance: "author", sourceRefs: [], serves: ["goal.a"], preserves: ["invariant.a"], requiresEvidence: [], openUnknowns: ["unknown.a"], repositoryLinks: [], tags: [] }],
};

describe("coordinate graph", () => {
  test("is deterministic, plane-qualified, and reports empty L0 plus unsupported artifacts", () => {
    const first = buildCoordinateGraph({ repositoryFacts, semanticModel });
    const second = buildCoordinateGraph({ repositoryFacts: { ...repositoryFacts, graph: { nodes: [...repositoryGraph.nodes].reverse(), edges: [...repositoryGraph.edges].reverse() } }, semanticModel: { nodes: [...semanticModel.nodes].reverse(), changes: [...semanticModel.changes] } });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.nodes.every((node) => node.id.startsWith("repo:") || node.id.startsWith("semantic:"))).toBe(true);
    expect(first.coverage.find((coverage) => coverage.level === 0)?.coordinateIds).toEqual([]);
    expect(first.unsupported.map((item) => item.sourceId)).toEqual(["change.a", "unknown.a"]);
  });

  test("bounded traversal returns stable source paths without inventing rationale", () => {
    const graph = buildCoordinateGraph({ repositoryFacts, semanticModel });
    const lifted = lift(graph, "repo:fn:a", 3, { maxDepth: 3, maxResults: 10 });
    expect(lifted.paths.map((path) => path.nodes)).toContainEqual(["repo:fn:a", "repo:module:a", "repo:cap:a"]);
    expect(lower(graph, "repo:cap:a", 1).paths.map((path) => path.nodes)).toContainEqual(["repo:cap:a", "repo:module:a", "repo:fn:a"]);
    const why = explainWhy(graph, "repo:cap:a");
    expect(why.known).toBe(true);
    expect(why.rationaleIds).toContain("semantic:invariant.a");
    const bounded = explainWhy(graph, "repo:fn:a", { maxDepth: 1 });
    expect(bounded).toMatchObject({ known: false, unknownReason: "traversal_bound_reached" });
    const affected = impact(graph, ["repo:fn:a"], { maxDepth: 2, maxResults: 1 });
    expect(affected.affected).toHaveLength(1);
    expect(affected.truncated).toBe(true);
  });

  test("resolves file links through indexed file paths", () => {
    const linkedModel: SemanticModel = {
      nodes: [semantic("invariant.file", "invariant", "File link", [], [{ kind: "file", ref: "fn:a.ts" }])],
      changes: [],
    };
    const graph = buildCoordinateGraph({ repositoryFacts, semanticModel: linkedModel });

    expect(graph.edges).toContainEqual(expect.objectContaining({
      from: "repo:fn:a",
      to: "semantic:invariant.file",
      sourceRelation: "repository_link:file",
    }));
    expect(graph.unmapped.filter((item) => item.sourceKind === "repository_link:file")).toEqual([]);
  });

  test("resolves every stable coordinate for a file shared by multiple repository nodes", () => {
    const sharedFileGraph: RepositoryGraph = {
      ...repositoryGraph,
      nodes: [
        ...repositoryGraph.nodes,
        node("fn:shared:b", "function", "shared b", "src/shared.ts"),
        node("fn:shared:a", "function", "shared a", "src/shared.ts"),
      ],
    };
    const linkedModel: SemanticModel = {
      nodes: [semantic("invariant.shared-file", "invariant", "Shared file link", [], [{ kind: "file", ref: "src/shared.ts" }])],
      changes: [],
    };
    const first = buildCoordinateGraph({ repositoryFacts: { graph: sharedFileGraph, claims: [], evidence: [] }, semanticModel: linkedModel });
    const second = buildCoordinateGraph({ repositoryFacts: { graph: { ...sharedFileGraph, nodes: [...sharedFileGraph.nodes].reverse() }, claims: [], evidence: [] }, semanticModel: linkedModel });

    expect(first.edges.filter((edge) => edge.sourceRelation === "repository_link:file").map((edge) => edge.from)).toEqual([
      "repo:fn:shared:a",
      "repo:fn:shared:b",
    ]);
    expect(fingerprintCoordinateGraph(second)).toBe(fingerprintCoordinateGraph(first));
  });

  test("reports stale links on change contracts with the canonical resolver reason", () => {
    const linkedModel: SemanticModel = {
      nodes: [],
      changes: [{
        ...semanticModel.changes[0]!,
        repositoryLinks: [{ kind: "symbol", ref: "sym:missing" }],
      }],
    };
    const graph = buildCoordinateGraph({ repositoryFacts, semanticModel: linkedModel });

    expect(graph.unmapped).toContainEqual({
      plane: "repo",
      sourceId: "sym:missing",
      sourceKind: "repository_link:symbol",
      reason: "symbol node id not found in the graph",
    });
  });

  test("honors depth zero and hard expansion/queue budgets on branching cycles", () => {
    const graph = buildCoordinateGraph({ repositoryFacts, semanticModel });
    const cyclic = {
      ...graph,
      edges: [...graph.edges,
        { from: "repo:module:a" as const, to: "repo:fn:a" as const, relation: "cycle", evidenceRefs: [] },
        { from: "repo:fn:a" as const, to: "repo:cap:a" as const, relation: "branch", evidenceRefs: [] },
      ],
    };
    const depthZero = impact(cyclic, ["repo:fn:a"], { maxDepth: 0 });
    expect(depthZero).toMatchObject({ maxDepth: 0, affected: [], truncated: true });
    const bounded = impact(cyclic, ["repo:fn:a"], { maxDepth: 10, maxExpansions: 1, maxQueue: 1 });
    expect(bounded.truncated).toBe(true);
    expect(bounded.maxExpansions).toBe(1);
    expect(explainWhy(cyclic, "repo:fn:a", { maxDepth: 0 })).toMatchObject({ known: false, unknownReason: "traversal_bound_reached", maxDepth: 0 });
    expect(lift(cyclic, "repo:fn:a", 3, { maxDepth: 0 }).paths).toEqual([]);
  });
});

function node(id: string, kind: RepositoryGraph["nodes"][number]["kind"], name: string, filePath = `${id}.ts`): RepositoryGraph["nodes"][number] {
  return { id, kind, name, filePath, evidence: [{ filePath, sourceKind: "code" }], tags: [], metadata: {} };
}
function edge(id: string, kind: RepositoryGraph["edges"][number]["kind"], from: string, to: string): RepositoryGraph["edges"][number] {
  return { id, kind, from, to, evidence: [], metadata: {} };
}
function semantic(id: string, kind: SemanticModel["nodes"][number]["kind"], statement: string, relations: SemanticModel["nodes"][number]["relations"], repositoryLinks: SemanticModel["nodes"][number]["repositoryLinks"]): SemanticModel["nodes"][number] {
  return { id, kind, statement, status: "declared", provenance: "author", sourceRefs: [{ file: "intent.sem", line: 1 }], repositoryLinks, relations, tags: [] };
}
