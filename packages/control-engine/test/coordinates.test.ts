import { describe, expect, test } from "bun:test";
import type { RepositoryGraph } from "@semantic-context/core";
import type {
  CoordinateGraphReportV2,
  EvidenceRefV1,
  AuthoredSemanticLevel,
  RefinementRelationV1,
  SemanticLevel,
  Sha256Hash,
} from "@semantic-context/control-model";
import { CoordinateGraphReportV2Schema } from "@semantic-context/control-model";
import type { SemanticModel } from "@semantic-context/semantic-model";
import {
  buildCoordinateGraph,
  explainWhy,
  impact,
  InvalidRefinementRelationError,
  lift,
  lower,
  proof,
  refinementCoverage,
} from "../src";

const digest = (value: string): Sha256Hash =>
  `sha256:${value.padStart(64, "0")}` as Sha256Hash;
const evidence = (locator: string): EvidenceRefV1 => ({
  schemaVersion: 1,
  kind: "semantic_node",
  locator,
  digest: { algorithm: "sha256", value: "a".repeat(64) },
});
const endpoint = (nodeId: string) =>
  ({ plane: "B", kind: "semantic_node", nodeId } as const);
const relation = (
  id: string,
  kind: RefinementRelationV1["kind"],
  source: RefinementRelationV1["source"],
  target: RefinementRelationV1["target"],
  epistemicStatus: RefinementRelationV1["epistemicStatus"] = "human_declared",
): RefinementRelationV1 => ({
  schemaVersion: 1,
  id,
  kind,
  source,
  target,
  epistemicStatus,
  provenance: "author",
  evidenceRefs: [evidence(id)],
});

describe("v2 coordinate projection", () => {
  test("keeps structural edges separate and never infers appliesAtLevel from kind or repository", () => {
    const repositoryGraph: RepositoryGraph = {
      nodes: [
        node("repo", "repository", "Repository"),
        node("fn:a", "function", "a"),
      ],
      edges: [edge("imports", "imports", "repo", "fn:a")],
    };
    const semanticModel: SemanticModel = {
      nodes: [
        semantic("goal.explicit", "goal", "Explicit", 6),
        semantic("goal.legacy", "goal", "Legacy"),
      ],
      changes: [],
      refinementRelations: [
        relation("r.1", "decomposes_to", endpoint("goal.explicit"), endpoint("goal.legacy")),
      ],
    };
    const graph = buildCoordinateGraph({
      repositoryFacts: { graph: repositoryGraph, claims: [], evidence: [] },
      semanticModel,
      verifiedEvidenceDigests: [digest("2"), digest("1"), digest("2")],
    });

    expect(graph.schemaVersion).toBe(2);
    expect(graph.structuralEdges).toHaveLength(1);
    expect(graph.refinementRelations.map((item) => item.id)).toEqual(["r.1"]);
    expect(graph.verifiedEvidenceDigests).toEqual([digest("1"), digest("2")]);
    expect(graph.nodes.find((item) => item.id === "repo:fn:a")?.appliesAtLevel).toBeNull();
    expect(graph.nodes.find((item) => item.id === "semantic:goal.legacy")?.appliesAtLevel).toBeNull();
    expect(graph.unmapped).toContainEqual(expect.objectContaining({
      sourceId: "goal.legacy",
      reason: "applies_at_level_missing",
    }));
  });

  test("projects observed hunks as explicit immutable L0 coordinates", () => {
    const graph = buildCoordinateGraph({
      repositoryFacts: { graph: { nodes: [], edges: [] }, claims: [], evidence: [] },
      semanticModel: { nodes: [], changes: [], refinementRelations: [] },
      observedHunks: [{
        schemaVersion: 1,
        repositoryIdentity: "repo:semctx",
        normalizedPath: "src/a.ts",
        oldRange: { start: 1, lines: 1 },
        newRange: { start: 1, lines: 1 },
        oldBlobId: null,
        newBlobId: null,
        rawHunkBytes: new TextEncoder().encode("@@ -1 +1 @@\n-a\n+b\n"),
        identity: digest("1"),
      }],
    });

    expect(graph.nodes).toContainEqual(expect.objectContaining({
      id: digest("1"),
      plane: "observed",
      appliesAtLevel: 0,
      category: "syntax",
    }));
    expect(graph.coverage.find((entry) => entry.level === 0)?.coordinateIds).toEqual([digest("1")]);
    expect(CoordinateGraphReportV2Schema.safeParse(graph).success).toBe(true);
  });

  test("rejects a refinement relation with an invalid relation digest before projection", () => {
    const invalid = {
      ...relation("invalid.digest", "decomposes_to", endpoint("a"), endpoint("b")),
      relationDigest: digest("f"),
    };
    let caught: unknown;
    try {
      buildCoordinateGraph({
        repositoryFacts: { graph: { nodes: [], edges: [] }, claims: [], evidence: [] },
        semanticModel: {
          nodes: [
            semantic("a", "goal", "A", 6),
            semantic("b", "goal", "B", 5),
          ],
          changes: [],
          refinementRelations: [invalid],
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidRefinementRelationError);
    expect(caught).toMatchObject({
      code: "INVALID_REFINEMENT_RELATION",
      relationId: "invalid.digest",
    });
    expect((caught as InvalidRefinementRelationError).issues).toContainEqual(expect.objectContaining({
      path: ["relationDigest"],
      message: "relation digest mismatch",
    }));
  });

  test("rejects a structurally invalid refinement relation instead of retaining it as advisory", () => {
    const invalid = {
      ...relation("invalid.schema", "implements", endpoint("a"), endpoint("b")),
      evidenceRefs: [],
    };

    expect(() => buildCoordinateGraph({
      repositoryFacts: { graph: { nodes: [], edges: [] }, claims: [], evidence: [] },
      semanticModel: {
        nodes: [
          semantic("a", "decision", "A", 1),
          semantic("b", "decision", "B", 2),
        ],
        changes: [],
        refinementRelations: [invalid],
      },
    })).toThrow(InvalidRefinementRelationError);
  });
});

describe("typed refinement traversal", () => {
  test("golden lower then lift uses typed adjacent steps and keeps governance/proof separate", () => {
    const graph = goldenGraph();
    const lowered = lower(graph, "semantic:l6", 0);
    expect(lowered).toMatchObject({
      schemaVersion: 2,
      terminalStatus: "success",
    });
    expect("reasonCode" in lowered).toBe(false);
    expect(lowered.paths[0]?.coordinates).toEqual([
      "semantic:l6", "semantic:l5", "semantic:l4", "semantic:l3",
      "semantic:l2", "semantic:l1", digest("1"),
    ]);
    expect(lowered.paths[0]?.steps.map((step) => step.relation.kind)).toEqual([
      "decomposes_to", "decomposes_to", "decomposes_to",
      "decomposes_to", "implements", "implements",
    ]);
    expect(lowered.governingConstraints.map((item) => item.id)).toEqual(["constraint"]);
    expect(lowered.proofs.map((item) => item.id)).toEqual(["proof"]);

    const lifted = lift(graph, digest("1"), 6);
    expect(lifted.terminalStatus).toBe("success");
    expect(lifted.paths[0]?.coordinates).toEqual([
      digest("1"), "semantic:l1", "semantic:l2", "semantic:l3",
      "semantic:l4", "semantic:l5", "semantic:l6",
    ]);
  });

  test("refuses stale before lookup and uses exact empty-reason precedence", () => {
    const graph = goldenGraph();
    expect(lift(graph, "semantic:missing", 6, {
      sourceSeal: digest("2"),
      indexSeal: digest("3"),
    })).toMatchObject({ terminalStatus: "refused", reasonCode: "INDEX_STALE", visitedCoordinateIds: [] });
    expect(lift(graph, "semantic:missing", 6)).toMatchObject({
      terminalStatus: "empty",
      reasonCode: "COORDINATE_UNKNOWN",
    });

    const missing = {
      ...graph,
      nodes: graph.nodes.map((item) =>
        item.id === "semantic:l1" ? { ...item, appliesAtLevel: null, category: null } : item),
    };
    expect(lower(missing, "semantic:l1", 0)).toMatchObject({
      terminalStatus: "empty",
      reasonCode: "MAPPING_MISSING",
    });

    const disconnected = { ...graph, refinementRelations: [] };
    expect(lower(disconnected, "semantic:l6", 0)).toMatchObject({
      terminalStatus: "empty",
      reasonCode: "REFINEMENT_DISCONNECTED",
    });
    expect(lower(graph, "semantic:l6", 0, { maxExpansions: 1 })).toMatchObject({
      terminalStatus: "budget_exhausted",
      reasonCode: "BUDGET_EXHAUSTED",
    });
  });

  test("jump, LLM-only, governance, proof, imports, and proximity never close a missing step", () => {
    const base = goldenGraph();
    const withoutL3L2 = base.refinementRelations.filter((item) => item.id !== "d.3-2");
    const contaminated: CoordinateGraphReportV2 = {
      ...base,
      structuralEdges: [
        { from: "repo:a", to: "repo:b", relation: "imports", sourceRelation: "imports", evidenceRefs: [] },
      ],
      refinementRelations: [
        ...withoutL3L2,
        relation("jump", "decomposes_to", endpoint("l3"), endpoint("l1")),
        relation("llm", "decomposes_to", endpoint("l3"), endpoint("l2"), "llm_inferred"),
        relation("not-a-step", "constrained_by", endpoint("l3"), endpoint("l2")),
      ],
    };
    const result = lower(contaminated, "semantic:l6", 0);
    expect(result).toMatchObject({ terminalStatus: "empty", reasonCode: "REFINEMENT_DISCONNECTED" });
    expect(result.advisoryRelations.map((item) => item.id)).toEqual(expect.arrayContaining(["jump", "llm"]));
  });

  test("an unverified evidence digest leaves the relation advisory and cannot certify coverage", () => {
    const graph = goldenGraph();
    const poisoned: CoordinateGraphReportV2 = {
      ...graph,
      refinementRelations: graph.refinementRelations.map((item) =>
        item.id === "d.3-2"
          ? {
              ...item,
              evidenceRefs: [{
                ...item.evidenceRefs[0]!,
                digest: { algorithm: "sha256", value: "b".repeat(64) },
              }],
            }
          : item),
    };

    const traversal = lower(poisoned, "semantic:l6", 0);
    expect(traversal).toMatchObject({
      terminalStatus: "empty",
      reasonCode: "REFINEMENT_DISCONNECTED",
    });
    expect(traversal.advisoryRelations.map((item) => item.id)).toContain("d.3-2");
  });

  test("coverage reports all levels, evidence, governance, proofs, advisories, and budget deterministically", () => {
    const graph = goldenGraph();
    const report = refinementCoverage(graph, "semantic:l6", 0, "lower", {
      sourceSeal: digest("9"),
      indexSeal: digest("9"),
    });
    expect(report).toMatchObject({
      schemaVersion: 1,
      terminalStatus: "success",
      coveredLevels: [0, 1, 2, 3, 4, 5, 6],
      missingLevels: [],
      levelSpan: { from: 6, to: 0 },
      sourceSeal: digest("9"),
      indexSeal: digest("9"),
    });
    expect(report.loadBearingEvidence).toHaveLength(6);
    expect(report.governingConstraints.map((item) => item.id)).toEqual(["constraint"]);
    expect(report.proofs.map((item) => item.id)).toEqual(["proof"]);
    expect(report.proofReferences).toHaveLength(1);
    expect(JSON.stringify(report)).toBe(JSON.stringify(refinementCoverage(
      { ...graph, nodes: [...graph.nodes].reverse(), refinementRelations: [...graph.refinementRelations].reverse() },
      "semantic:l6",
      0,
      "lower",
      { sourceSeal: digest("9"), indexSeal: digest("9") },
    )));
  });

  test("impact, explainWhy, and proof have distinct edge policies", () => {
    const graph = goldenGraph();
    const withStructural: CoordinateGraphReportV2 = {
      ...graph,
      nodes: [
        ...graph.nodes,
        coordinate("repo:a", null),
        coordinate("repo:b", null),
        coordinate("semantic:rationale", 6, "goal"),
      ],
      structuralEdges: [
        { from: "repo:a", to: "repo:b", relation: "imports", sourceRelation: "imports", evidenceRefs: [] },
        { from: "repo:b", to: "semantic:rationale", relation: "repository_link:file", sourceRelation: "repository_link:file", evidenceRefs: [] },
        { from: "semantic:l1", to: "semantic:rationale", relation: "serves", sourceRelation: "serves", evidenceRefs: [] },
      ],
    };

    expect(impact(withStructural, ["repo:a"]).affected.map((item) => item.id)).toEqual(["repo:b"]);
    expect(explainWhy(withStructural, "semantic:l1").rationaleIds).toEqual(["semantic:rationale"]);
    expect(proof(withStructural, "semantic:l1").map((item) => item.id)).toEqual(["proof"]);
  });
});

function goldenGraph(): CoordinateGraphReportV2 {
  const l0 = { plane: "A", kind: "observed_diff_hunk", coordinateDigest: digest("1") } as const;
  const relations = [
    relation("d.6-5", "decomposes_to", endpoint("l6"), endpoint("l5")),
    relation("d.5-4", "decomposes_to", endpoint("l5"), endpoint("l4")),
    relation("d.4-3", "decomposes_to", endpoint("l4"), endpoint("l3")),
    relation("d.3-2", "decomposes_to", endpoint("l3"), endpoint("l2")),
    relation("i.1-2", "implements", endpoint("l1"), endpoint("l2")),
    relation("i.0-1", "implements", l0, endpoint("l1")),
    relation("constraint", "constrained_by", endpoint("l3"), endpoint("l4")),
    relation("proof", "proved_by", endpoint("l1"), endpoint("l4")),
  ];
  return {
    schemaVersion: 2,
    nodes: [
      coordinate("semantic:l6", 6, "goal"),
      coordinate("semantic:l5", 5, "goal"),
      coordinate("semantic:l4", 4, "invariant"),
      coordinate("semantic:l3", 3, "capability"),
      coordinate("semantic:l2", 2, "bounded_context"),
      coordinate("semantic:l1", 1, "code_entity"),
      {
        ...coordinate(digest("1"), 0, "syntax"),
        plane: "observed",
        sourceId: digest("1"),
        sourceKind: "observed_diff_hunk",
      },
      coordinate("repo:a", null),
      coordinate("repo:b", null),
    ],
    structuralEdges: [],
    refinementRelations: relations,
    mapping: [],
    coverage: [],
    unsupported: [],
    unmapped: [],
    staleLinks: [],
    danglingReferences: [],
    compatibilityNormalization: [],
    verifiedEvidenceDigests: [`sha256:${"a".repeat(64)}`],
  };
}

function coordinate(
  id: CoordinateGraphReportV2["nodes"][number]["id"],
  level: SemanticLevel | null,
  category: CoordinateGraphReportV2["nodes"][number]["category"] = level === null ? null : "code_entity",
): CoordinateGraphReportV2["nodes"][number] {
  const plane = String(id).startsWith("semantic:") ? "semantic" : String(id).startsWith("repo:") ? "repo" : "observed";
  return {
    id,
    plane,
    sourceId: String(id).replace(/^(semantic|repo):/, ""),
    sourceKind: plane === "semantic" ? "goal" : plane === "repo" ? "function" : "observed_diff_hunk",
    appliesAtLevel: level,
    category,
    label: String(id),
    epistemicStatus: plane === "semantic" ? "human_declared" : "statically_observed",
    references: [],
  };
}

function node(id: string, kind: RepositoryGraph["nodes"][number]["kind"], name: string): RepositoryGraph["nodes"][number] {
  return { id, kind, name, filePath: `${id}.ts`, evidence: [], tags: [], metadata: {} };
}

function edge(id: string, kind: RepositoryGraph["edges"][number]["kind"], from: string, to: string): RepositoryGraph["edges"][number] {
  return { id, kind, from, to, evidence: [], metadata: {} };
}

function semantic(
  id: string,
  kind: SemanticModel["nodes"][number]["kind"],
  statement: string,
  appliesAtLevel?: AuthoredSemanticLevel,
): SemanticModel["nodes"][number] {
  return {
    id,
    kind,
    statement,
    status: "declared",
    provenance: "author",
    sourceRefs: [{ file: "intent.sem", line: 1 }],
    repositoryLinks: [],
    relations: [],
    tags: [],
    ...(appliesAtLevel === undefined ? {} : { appliesAtLevel }),
  };
}
