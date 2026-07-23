import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RepositoryGraph } from "@semantic-context/core";
import {
  serializeControlReport,
  type CoordinateGraphReportV2,
  type Sha256Hash,
} from "@semantic-context/control-model";
import { parseObservedDiffHunks } from "@semantic-context/context-engine";
import { hasErrors, parseSemanticSource } from "@semantic-context/semantic-dsl";
import type { SemanticModel } from "@semantic-context/semantic-model";
import {
  buildCoordinateGraph,
  lift,
  lower,
  refinementCoverage,
} from "../src";

const REPOSITORY_IDENTITY = "repo:semctx";
const GOAL = "semantic:goal.semctx.reconstructive-control";
const HUNK_ID =
  "sha256:0cef0c7583115223271b46cbbe70a91b7f783884c5ef60c840649b51780815bd" as Sha256Hash;
const CURRENT_SEAL =
  "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Sha256Hash;
const SEMANTIC_SOURCE = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  ".semctx",
  "semantic",
  "project",
  "control-plane.sem",
);
const PATCH_FIXTURE = join(import.meta.dir, "fixtures", "l6-l0-refinement.patch");
const LOAD_BEARING_RELATIONS = [
  "refinement.01.strategy-to-product",
  "refinement.02.product-to-invariant",
  "refinement.03.capability-realizes-invariant",
  "refinement.04.component-implements-capability",
  "refinement.05.contract-implements-component",
  "refinement.06.hunk-implements-contract",
] as const;
const EXPECTED_LOWER_COORDINATES = [
  GOAL,
  "semantic:goal.semctx.typed-refinement-intent",
  "semantic:invariant.semctx.plane-separation",
  "semantic:decision.semctx.typed-refinement-policy",
  "semantic:decision.semctx.control-engine-boundary",
  "semantic:proof.semctx.typed-refinement-contract",
  HUNK_ID,
] as const;
const EXPECTED_CONSTRAINTS = [
  "refinement.07.plane-separation-constraint",
  "refinement.08.fail-closed-constraint",
] as const;

describe("tracked L6-to-L0 refinement dogfood", () => {
  test("lowers the authored L6 goal to the sealed L0 hunk with complete honest coverage", () => {
    const { graph } = trackedDogfood();
    const report = refinementCoverage(graph, GOAL, 0, "lower", {
      sourceSeal: CURRENT_SEAL,
      indexSeal: CURRENT_SEAL,
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      terminalStatus: "success",
      coveredLevels: [0, 1, 2, 3, 4, 5, 6],
      missingLevels: [],
      sourceSeal: CURRENT_SEAL,
      indexSeal: CURRENT_SEAL,
      levelSpan: { from: 6, to: 0 },
    });
    expect(report.loadBearingSteps.map((step) => step.relation.id)).toEqual(
      [...LOAD_BEARING_RELATIONS],
    );
    expect(report.loadBearingSteps.map((step) => [step.fromLevel, step.toLevel])).toEqual([
      [6, 5],
      [5, 4],
      [4, 3],
      [3, 2],
      [2, 1],
      [1, 0],
    ]);
    expect(report.loadBearingSteps.map((step) => step.relation.kind)).toEqual([
      "decomposes_to",
      "decomposes_to",
      "realizes",
      "implements",
      "implements",
      "implements",
    ]);
    expect(report.loadBearingEvidence).toHaveLength(LOAD_BEARING_RELATIONS.length);
    expect(report.governingConstraints.map((relation) => relation.id)).toEqual(
      [...EXPECTED_CONSTRAINTS],
    );
    expect(report.proofs.map((relation) => relation.id)).toEqual([
      "refinement.09.contract-proof",
    ]);
    expect(report.advisorySteps.map((step) => step.relation.id)).toEqual([
      "refinement.90.llm-advisory",
      "refinement.91.multilevel-advisory",
    ]);
  });

  test("lifts the sealed L0 hunk back to the same L6 goal and governing invariants", () => {
    const { graph } = trackedDogfood();
    const lowered = lower(graph, GOAL, 0);
    const lifted = lift(graph, HUNK_ID, 6);

    expect(lowered.paths[0]?.coordinates).toEqual(EXPECTED_LOWER_COORDINATES);
    expect(lifted).toMatchObject({ terminalStatus: "success" });
    expect(lifted.paths[0]?.coordinates).toEqual([...EXPECTED_LOWER_COORDINATES].reverse());
    expect(lifted.paths[0]?.coordinates.at(-1)).toBe(GOAL);
    expect(lifted.governingConstraints.map((relation) => relation.id)).toEqual(
      [...EXPECTED_CONSTRAINTS],
    );
    expect(lifted.proofs.map((relation) => relation.id)).toEqual([
      "refinement.09.contract-proof",
    ]);
  });

  test("keeps shuffled authored and observed inputs byte-identical in canonical output", () => {
    const first = trackedDogfood();
    const shuffled = buildCoordinateGraph({
      repositoryFacts: {
        ...first.repositoryFacts,
        graph: {
          nodes: [...first.repositoryFacts.graph.nodes].reverse(),
          edges: [...first.repositoryFacts.graph.edges].reverse(),
        },
      },
      semanticModel: {
        ...first.semanticModel,
        nodes: [...first.semanticModel.nodes].reverse(),
        changes: [...first.semanticModel.changes].reverse(),
        refinementRelations: [...(first.semanticModel.refinementRelations ?? [])].reverse(),
      },
      observedHunks: [...first.observedHunks].reverse(),
      verifiedEvidenceDigests: verifiedEvidenceDigests(first.semanticModel),
    });

    const expected = refinementCoverage(first.graph, GOAL, 0, "lower", {
      sourceSeal: CURRENT_SEAL,
      indexSeal: CURRENT_SEAL,
    });
    const actual = refinementCoverage(shuffled, GOAL, 0, "lower", {
      sourceSeal: CURRENT_SEAL,
      indexSeal: CURRENT_SEAL,
    });

    expect(serializeControlReport(actual)).toBe(serializeControlReport(expected));
  });

  test("keeps import, proximity, LLM-only, and multi-level decoys outside the certified path", () => {
    const { graph } = trackedDogfood();
    const certifiedRelationIds = lower(graph, GOAL, 0).paths[0]?.steps.map(
      (step) => step.relation.id,
    );

    expect(graph.structuralEdges.map((edge) => edge.sourceRelation)).toEqual(
      expect.arrayContaining(["imports", "related_to"]),
    );
    expect(certifiedRelationIds).toEqual([...LOAD_BEARING_RELATIONS]);
    expect(certifiedRelationIds).not.toContain("refinement.90.llm-advisory");
    expect(certifiedRelationIds).not.toContain("refinement.91.multilevel-advisory");
  });

  for (const removedRelationId of LOAD_BEARING_RELATIONS) {
    test(`returns REFINEMENT_DISCONNECTED when sole load-bearing edge ${removedRelationId} is removed`, () => {
      const { graph } = trackedDogfood();
      const disconnected: CoordinateGraphReportV2 = {
        ...graph,
        refinementRelations: graph.refinementRelations.filter(
          (relation) => relation.id !== removedRelationId,
        ),
      };

      expect(lower(disconnected, GOAL, 0)).toMatchObject({
        terminalStatus: "empty",
        reasonCode: "REFINEMENT_DISCONNECTED",
        paths: [],
      });
    });
  }

  test("preserves the exact tracked patch and raw hunk bytes across projection and traversal", () => {
    const fixtureBefore = readFileSync(PATCH_FIXTURE);
    const dogfood = trackedDogfood();
    const rawHunkBefore = Buffer.from(dogfood.observedHunks[0]!.rawHunkBytes);

    lower(dogfood.graph, GOAL, 0);
    lift(dogfood.graph, HUNK_ID, 6);
    refinementCoverage(dogfood.graph, GOAL, 0, "lower", {
      sourceSeal: CURRENT_SEAL,
      indexSeal: CURRENT_SEAL,
    });

    expect(readFileSync(PATCH_FIXTURE)).toEqual(fixtureBefore);
    expect(Buffer.from(dogfood.observedHunks[0]!.rawHunkBytes)).toEqual(rawHunkBefore);
    expect(dogfood.observedHunks[0]!.identity).toBe(HUNK_ID);
  });
});

function trackedDogfood(): {
  graph: CoordinateGraphReportV2;
  semanticModel: SemanticModel;
  observedHunks: ReturnType<typeof parseObservedDiffHunks>;
  repositoryFacts: {
    graph: RepositoryGraph;
    claims: [];
    evidence: [];
  };
} {
  const source = readFileSync(SEMANTIC_SOURCE, "utf8");
  const parsed = parseSemanticSource(source, ".semctx/semantic/project/control-plane.sem");
  expect(hasErrors(parsed.diagnostics)).toBe(false);
  expect(parsed.model.nodes.every((node) => node.appliesAtLevel !== undefined)).toBe(true);

  const patchBytes = readFileSync(PATCH_FIXTURE);
  const observedHunks = parseObservedDiffHunks({
    repositoryIdentity: REPOSITORY_IDENTITY,
    diffBytes: patchBytes,
  });
  expect(observedHunks).toHaveLength(1);
  expect(observedHunks[0]?.identity).toBe(HUNK_ID);

  const repositoryFacts = {
    graph: decoyRepositoryGraph(),
    claims: [] as [],
    evidence: [] as [],
  };
  return {
    graph: buildCoordinateGraph({
      repositoryFacts,
      semanticModel: parsed.model,
      observedHunks,
      verifiedEvidenceDigests: verifiedEvidenceDigests(parsed.model),
    }),
    semanticModel: parsed.model,
    observedHunks,
    repositoryFacts,
  };
}

function verifiedEvidenceDigests(model: SemanticModel): Sha256Hash[] {
  return [...new Set(
    (model.refinementRelations ?? []).flatMap((relation) =>
      relation.evidenceRefs.map((reference) =>
        `sha256:${reference.digest.value}` as Sha256Hash)),
  )].sort();
}

function decoyRepositoryGraph(): RepositoryGraph {
  const nodes: RepositoryGraph["nodes"] = [
    repositoryNode(
      "repo.control-engine.traversal",
      "module",
      "packages/control-engine/src/traversal.ts",
    ),
    repositoryNode(
      "repo.control-engine.golden-test",
      "test",
      "packages/control-engine/test/l6-l0-refinement-round-trip.test.ts",
    ),
    repositoryNode(
      "repo.semantic-layer-doc",
      "document",
      "docs/architecture/semantic-layer-v1.md",
    ),
  ];
  return {
    nodes,
    edges: [
      {
        id: "decoy.import",
        kind: "imports",
        from: "repo.control-engine.golden-test",
        to: "repo.control-engine.traversal",
        evidence: [],
        metadata: {},
      },
      {
        id: "decoy.proximity",
        kind: "related_to",
        from: "repo.control-engine.traversal",
        to: "repo.semantic-layer-doc",
        evidence: [],
        metadata: {},
      },
    ],
  };
}

function repositoryNode(
  id: string,
  kind: RepositoryGraph["nodes"][number]["kind"],
  filePath: string,
): RepositoryGraph["nodes"][number] {
  return {
    id,
    kind,
    name: filePath,
    filePath,
    evidence: [],
    tags: [],
    metadata: {},
  };
}
