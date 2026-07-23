import { describe, expect, test } from "bun:test";
import type { Claim, EvidenceRecord, RepositoryGraph } from "@semantic-context/core";
import { buildCoordinateGraph } from "@semantic-context/control-engine";
import { resolveRepositoryLinks, type RepositoryFacts } from "@semantic-context/semantic-engine";
import type { SemanticModel } from "@semantic-context/semantic-model";

const repositoryGraph: RepositoryGraph = {
  nodes: [{
    id: "sym:function:src/a.ts:run:1",
    kind: "function",
    name: "run",
    filePath: "src/a.ts",
    evidence: [{ filePath: "src/a.ts", startLine: 1, sourceKind: "code" }],
    tags: [],
    metadata: {},
  }],
  edges: [],
};

const claims: Claim[] = [{
  id: "claim.known",
  kind: "behavior",
  statement: "Known behavior",
  subjectNodeIds: [],
  evidenceIds: [],
  authority: 1,
  freshness: 1,
  confidence: 1,
  verificationStatus: "tested",
  tags: [],
}];

const evidence: EvidenceRecord[] = [{
  id: "evidence.known",
  filePath: "src/a.ts",
  startLine: 1,
  sourceKind: "test",
}];

const facts: RepositoryFacts = { graph: repositoryGraph, claims, evidence };

describe("cross-plane repository-link consistency", () => {
  test("reports the exact same stale links and dangling semantic references", () => {
    const model: SemanticModel = {
      nodes: [semanticNode(
        "invariant.cross-plane",
        [{ kind: "serves", to: "goal.missing" }],
        [{ kind: "file", ref: "src/missing.ts" }],
      )],
      changes: [{
        id: "change.cross-plane",
        statement: "Keep repository links aligned",
        lifecycle: "active",
        provenance: "author",
        sourceRefs: [],
        serves: [],
        preserves: [],
        requiresEvidence: [],
        openUnknowns: [],
        repositoryLinks: [{ kind: "symbol", ref: "sym:missing" }],
        tags: [],
      }],
    };

    const planeB = resolveRepositoryLinks(model, facts);
    const planeC = buildCoordinateGraph({ repositoryFacts: facts, semanticModel: model });

    expect(planeC.staleLinks ?? []).toEqual(planeB.staleLinks);
    expect(planeC.danglingReferences ?? []).toEqual(planeB.danglingReferences);
  });

  test("resolves file and node links to coordinates without calling claim or evidence links stale", () => {
    const model: SemanticModel = {
      nodes: [semanticNode("invariant.cross-plane", [], [
        { kind: "file", ref: "src/a.ts" },
        { kind: "symbol", ref: "sym:function:src/a.ts:run:1" },
        { kind: "claim", ref: "claim.known" },
        { kind: "evidence", ref: "evidence.known" },
      ])],
      changes: [],
    };

    const planeB = resolveRepositoryLinks(model, facts);
    const planeC = buildCoordinateGraph({ repositoryFacts: facts, semanticModel: model });

    expect(planeB.staleLinks).toEqual([]);
    expect(planeC.staleLinks ?? []).toEqual([]);
    expect(planeC.unmapped.filter((item) => item.sourceKind.startsWith("repository_link:"))).toEqual([]);
    expect(planeC.edges.filter((edge) => edge.sourceRelation === "repository_link:file")).toHaveLength(1);
    expect(planeC.edges.filter((edge) => edge.sourceRelation === "repository_link:symbol")).toHaveLength(1);
    expect(planeC.unsupported).toContainEqual({
      plane: "repo",
      sourceId: "claim.known",
      sourceKind: "repository_link:claim",
      reason: "resolved_non_coordinate_fact_for:invariant.cross-plane",
    });
    expect(planeC.unsupported).toContainEqual({
      plane: "repo",
      sourceId: "evidence.known",
      sourceKind: "repository_link:evidence",
      reason: "resolved_non_coordinate_fact_for:invariant.cross-plane",
    });
  });
});

function semanticNode(
  id: string,
  relations: SemanticModel["nodes"][number]["relations"],
  repositoryLinks: SemanticModel["nodes"][number]["repositoryLinks"],
): SemanticModel["nodes"][number] {
  return {
    id,
    kind: "invariant",
    statement: id,
    status: "declared",
    provenance: "author",
    sourceRefs: [{ file: "intent.sem", line: 1 }],
    repositoryLinks,
    relations,
    tags: [],
  };
}
