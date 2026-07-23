import { describe, expect, test } from "bun:test";
import {
  ArchitectureSnapshotSchema,
  MigrationPlanSchema,
  type ArchitectureSnapshot,
  type CoordinateGraphReport,
  type CoordinateGraphReportV2,
} from "@semantic-context/control-model";
import { compareArchitectures, compileMigrationPlan, fingerprintCoordinateGraph, snapshotArchitecture } from "../src";

const change = { id: "change.a", serves: ["goal.a"], preserves: ["inv"], requiredEvidence: [], openUnknowns: [] };

const current: ArchitectureSnapshot = {
  id: "current", commit: "abc", capturedAt: "2026-07-19T10:00:00.000Z",
  elements: [element("repo:old", 1, "code_entity", "old"), element("semantic:inv", 4, "invariant", "stable")],
  relations: [],
};
const target: ArchitectureSnapshot = {
  id: "target", commit: "def", capturedAt: "2026-07-19T11:00:00.000Z",
  elements: [element("repo:new", 1, "code_entity", "new"), element("semantic:inv", 4, "invariant", "changed")],
  relations: [],
};

describe("architecture comparison and migration", () => {
  test("delta is stable across input ordering and records L4 changes", () => {
    const first = compareArchitectures(current, target);
    const second = compareArchitectures({ ...current, elements: [...current.elements].reverse() }, { ...target, elements: [...target.elements].reverse() });
    expect(JSON.stringify(first.delta)).toBe(JSON.stringify(second.delta));
    expect(first.delta.added.map((item) => item.id)).toEqual(["repo:new"]);
    expect(first.delta.removed.map((item) => item.id)).toEqual(["repo:old"]);
    expect(first.delta.changedInvariantIds).toEqual(["semantic:inv"]);
  });

  test("federated graph identity is stable across input ordering", () => {
    const graph: CoordinateGraphReport = {
      schemaVersion: 1,
      nodes: [
        { id: "repo:é", plane: "repo", sourceId: "é", sourceKind: "module", level: 2, category: "module", label: "accent", epistemicStatus: "statically_observed", references: [] },
        { id: "repo:!", plane: "repo", sourceId: "!", sourceKind: "module", level: 2, category: "module", label: "punctuation", epistemicStatus: "statically_observed", references: [] },
        { id: "repo:A", plane: "repo", sourceId: "A", sourceKind: "module", level: 2, category: "module", label: "case", epistemicStatus: "statically_observed", references: [] },
        { id: "repo:b", plane: "repo", sourceId: "b", sourceKind: "module", level: 2, category: "module", label: "B", epistemicStatus: "statically_observed", references: [] },
        { id: "repo:a", plane: "repo", sourceId: "a", sourceKind: "module", level: 2, category: "module", label: "A", epistemicStatus: "statically_observed", references: [] },
      ],
      edges: [], mapping: [],
      coverage: [{ level: 2, categories: ["module"], coordinateIds: ["repo:b", "repo:a"] }],
      unsupported: [], unmapped: [],
      staleLinks: [], danglingReferences: [],
    };
    const reordered = { ...graph, nodes: [...graph.nodes].reverse(), coverage: [{ ...graph.coverage[0]!, coordinateIds: [...graph.coverage[0]!.coordinateIds].reverse() }] };

    expect(fingerprintCoordinateGraph(graph)).toBe(fingerprintCoordinateGraph(reordered));
    expect(fingerprintCoordinateGraph(graph)).toMatch(/^[a-f0-9]{64}$/);
  });

  test("v2 snapshots retain only relations whose endpoints have explicit-level elements", () => {
    const graph: CoordinateGraphReportV2 = {
      schemaVersion: 2,
      nodes: [
        {
          id: "repo:unmapped",
          plane: "repo",
          sourceId: "unmapped",
          sourceKind: "module",
          appliesAtLevel: null,
          category: null,
          label: "unmapped",
          epistemicStatus: "statically_observed",
          references: [],
        },
        {
          id: "semantic:a",
          plane: "semantic",
          sourceId: "a",
          sourceKind: "decision",
          appliesAtLevel: 2,
          category: "bounded_context",
          label: "A",
          epistemicStatus: "human_declared",
          references: [],
        },
        {
          id: "semantic:b",
          plane: "semantic",
          sourceId: "b",
          sourceKind: "goal",
          appliesAtLevel: 3,
          category: "capability",
          label: "B",
          epistemicStatus: "human_declared",
          references: [],
        },
      ],
      structuralEdges: [
        { from: "repo:unmapped", to: "semantic:a", relation: "repository_link:file", evidenceRefs: [] },
      ],
      refinementRelations: [{
        schemaVersion: 1,
        id: "relation.a-b",
        kind: "implements",
        source: { plane: "B", kind: "semantic_node", nodeId: "a" },
        target: { plane: "B", kind: "semantic_node", nodeId: "b" },
        epistemicStatus: "human_declared",
        provenance: "author",
        evidenceRefs: [{
          schemaVersion: 1,
          kind: "semantic_node",
          locator: "a",
          digest: { algorithm: "sha256", value: "a".repeat(64) },
        }],
      }],
      mapping: [],
      coverage: [],
      unsupported: [],
      unmapped: [],
      staleLinks: [],
      danglingReferences: [],
      compatibilityNormalization: [],
      verifiedEvidenceDigests: [],
    };

    const snapshot = snapshotArchitecture(graph, {
      id: "v2",
      commit: "abc",
      capturedAt: "2026-07-23T10:00:00.000Z",
    });

    expect(snapshot.elements.map((item) => item.id)).toEqual(["semantic:a", "semantic:b"]);
    expect(snapshot.relations.map((item) => [item.from, item.to, item.relation])).toEqual([
      ["semantic:a", "semantic:b", "implements"],
    ]);
    expect(ArchitectureSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(fingerprintCoordinateGraph({
      ...graph,
      verifiedEvidenceDigests: [`sha256:${"a".repeat(64)}`],
    })).not.toBe(fingerprintCoordinateGraph(graph));
  });

  test("v2 snapshots are schema-valid and empty when no coordinate has an explicit level", () => {
    const graph: CoordinateGraphReportV2 = {
      schemaVersion: 2,
      nodes: [{
        id: "repo:unmapped",
        plane: "repo",
        sourceId: "unmapped",
        sourceKind: "module",
        appliesAtLevel: null,
        category: null,
        label: "unmapped",
        epistemicStatus: "statically_observed",
        references: [],
      }],
      structuralEdges: [],
      refinementRelations: [],
      mapping: [],
      coverage: [],
      unsupported: [],
      unmapped: [],
      staleLinks: [],
      danglingReferences: [],
      compatibilityNormalization: [],
      verifiedEvidenceDigests: [],
    };
    const snapshot = snapshotArchitecture(graph, {
      id: "empty-v2",
      commit: "abc",
      capturedAt: "2026-07-23T10:00:00.000Z",
    });

    expect(snapshot).toMatchObject({ elements: [], relations: [] });
    expect(ArchitectureSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  test("plans are blocked without target and reject an inconsistent supplied delta", () => {
    expect(compileMigrationPlan({ change, current }).plan).toMatchObject({ status: "BLOCKED", blockedReason: "target_architecture_missing", steps: [] });
    const delta = compareArchitectures(current, target).delta;
    const inconsistent = { ...delta, added: [] };
    expect(compileMigrationPlan({ change, current, target, delta: inconsistent }).plan).toMatchObject({ status: "BLOCKED", blockedReason: "architecture_delta_inconsistent", steps: [] });
  });

  test("blocks open unknowns and unsatisfied Plane B evidence with versioned details", () => {
    const plan = compileMigrationPlan({ change: { ...change, openUnknowns: ["unknown.runtime"], requiredEvidence: [{ id: "evidence.shadow", status: "unsatisfied", satisfied: false, attestationIds: [] }] }, current, target }).plan;
    expect(plan).toMatchObject({ status: "BLOCKED", blockedReason: "open_unknowns" });
    expect(plan.blockedDetails).toEqual([
      { schemaVersion: 1, reason: "open_unknowns", subjectIds: ["unknown.runtime"], message: expect.any(String) },
      { schemaVersion: 1, reason: "required_evidence_unsatisfied", subjectIds: ["evidence.shadow"], message: expect.any(String) },
    ]);
  });

  test("a target compiles an adjacent, acyclic, proof-bearing READY DAG", () => {
    const plan = compileMigrationPlan({ change, current, target }).plan;
    expect(plan.status).toBe("READY");
    expect(plan.steps.map((step) => step.kind)).toEqual(["capture", "characterize", "introduce", "introduce", "shadow_compare", "cutover", "observe", "deletion_check"]);
    expect(plan.steps.every((step, index) => index === 0 || step.dependsOn[0] === plan.steps[index - 1]!.id)).toBe(true);
    expect(plan.steps.filter((step) => step.risk === "R2" || step.risk === "R3").every((step) => step.rollback && step.proofObligations.includes("rollback_ready"))).toBe(true);
    expect(plan.steps.every((step) => step.changesL4Invariant)).toBe(true);
    expect(plan.steps).toHaveLength(8);
    expect(new Set(plan.steps.map((step) => step.profile)).size).toBe(8);
    expect(plan.steps.every((step) => step.affectedCoordinateIds.includes("semantic:goal.a") && step.affectedCoordinateIds.includes("semantic:inv"))).toBe(true);
    expect(MigrationPlanSchema.safeParse({ ...plan, steps: [...plan.steps].reverse() }).success).toBe(false);
  });
});

function element(id: ArchitectureSnapshot["elements"][number]["id"], level: ArchitectureSnapshot["elements"][number]["level"], category: ArchitectureSnapshot["elements"][number]["category"], fingerprint: string): ArchitectureSnapshot["elements"][number] {
  return { id, level, category, fingerprint };
}
