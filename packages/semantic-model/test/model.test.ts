import { describe, it, expect } from "bun:test";
import {
  semanticId,
  kindOfSemanticId,
  isValidSemanticId,
  repositoryLinkFromRef,
  repositoryLinkToRef,
  mergeModels,
  SemanticIndex,
  emptyModel,
  DEFAULT_STATUS_BY_KIND,
  PROVEN_STATUSES,
  SemanticModelSchema,
  SemanticNodeSchema,
  ChangeTargetBindingV1Schema,
  ChangeContractSchema,
  normalizeLegacySemanticModelV1,
} from "@semantic-context/semantic-model";
import type {
  AuthoredSemanticLevel,
  ChangeContractParsed,
  SemanticModel,
  SemanticNode,
  SemanticNodeParsed,
} from "@semantic-context/semantic-model";

describe("semantic ids", () => {
  it("is idempotent on an already-namespaced id", () => {
    expect(semanticId("goal", "goal.checkout.reliable-payment")).toBe("goal.checkout.reliable-payment");
  });

  it("builds a namespaced id from a free label, preserving dots", () => {
    expect(semanticId("invariant", "payment.idempotent")).toBe("invariant.payment.idempotent");
    expect(semanticId("goal", "Checkout Reliable Payment")).toBe("goal.checkout-reliable-payment");
  });

  it("infers the kind from an id prefix, including the proof→evidence alias", () => {
    expect(kindOfSemanticId("invariant.payment.idempotent")).toBe("invariant");
    expect(kindOfSemanticId("proof.test.webhook-duplicate-event")).toBe("evidence");
    expect(kindOfSemanticId("evidence.test.x")).toBe("evidence");
    expect(kindOfSemanticId("no-prefix")).toBeUndefined();
  });

  it("validates prefix ↔ kind agreement", () => {
    expect(isValidSemanticId("goal", "goal.checkout.reliable-payment")).toBe(true);
    expect(isValidSemanticId("goal", "invariant.x")).toBe(false);
    expect(isValidSemanticId("invariant", "invariant.")).toBe(false);
  });
});

describe("repository link inference", () => {
  it("maps Plane-A id prefixes to link kinds", () => {
    expect(repositoryLinkFromRef("sym:function:src/x.ts:foo:1")).toEqual({ kind: "symbol", ref: "sym:function:src/x.ts:foo:1" });
    expect(repositoryLinkFromRef("inv:confirmed-never-exceeds-capacity")).toEqual({ kind: "invariant", ref: "inv:confirmed-never-exceeds-capacity" });
    expect(repositoryLinkFromRef("claim:invariant:x")).toEqual({ kind: "claim", ref: "claim:invariant:x" });
    expect(repositoryLinkFromRef("test:test/x.test.ts")).toEqual({ kind: "test", ref: "test:test/x.test.ts" });
  });

  it("treats bare paths and file: refs as file links, round-tripping the ref", () => {
    expect(repositoryLinkFromRef("src/domain/confirmation.ts")).toEqual({ kind: "file", ref: "src/domain/confirmation.ts" });
    expect(repositoryLinkFromRef("file:src/x.ts")).toEqual({ kind: "file", ref: "src/x.ts" });
    expect(repositoryLinkToRef({ kind: "file", ref: "src/x.ts" })).toBe("file:src/x.ts");
    expect(repositoryLinkToRef({ kind: "symbol", ref: "sym:function:a:b:1" })).toBe("sym:function:a:b:1");
  });
});

describe("model helpers", () => {
  const model: SemanticModel = {
    nodes: [
      { id: "goal.b", kind: "goal", statement: "B", status: "declared", provenance: "author", sourceRefs: [], repositoryLinks: [], relations: [], tags: [] },
      { id: "goal.a", kind: "goal", statement: "A", status: "declared", provenance: "author", sourceRefs: [], repositoryLinks: [], relations: [], tags: [] },
      { id: "invariant.x", kind: "invariant", statement: "X", status: "declared", provenance: "author", sourceRefs: [], repositoryLinks: [], relations: [], tags: [] },
    ],
    changes: [
      { id: "change.c", statement: "C", lifecycle: "draft", provenance: "author", sourceRefs: [], serves: [], preserves: [], requiresEvidence: [], openUnknowns: [], repositoryLinks: [], tags: [] },
    ],
  };

  it("indexes and looks up nodes and changes", () => {
    const index = new SemanticIndex(model);
    expect(index.node("goal.a")?.statement).toBe("A");
    expect(index.change("change.c")?.lifecycle).toBe("draft");
    expect(index.has("invariant.x")).toBe(true);
    expect(index.nodesOfKind("goal").map((n) => n.id)).toEqual(["goal.a", "goal.b"]);
  });

  it("merges deterministically with later models winning and sorted output", () => {
    const overlay: SemanticModel = {
      ...emptyModel(),
      changes: [{ id: "change.c", statement: "C2", lifecycle: "active", provenance: "agent", sourceRefs: [], serves: [], preserves: [], requiresEvidence: [], openUnknowns: [], repositoryLinks: [], tags: [] }],
    };
    const merged = mergeModels(model, overlay);
    expect(merged.changes).toHaveLength(1);
    expect(merged.changes[0]?.statement).toBe("C2");
    expect(merged.nodes.map((n) => n.id)).toEqual(["goal.a", "goal.b", "invariant.x"]);
  });

  it("exposes default statuses and the proven set", () => {
    expect(DEFAULT_STATUS_BY_KIND.assumption).toBe("assumed");
    expect(DEFAULT_STATUS_BY_KIND.goal).toBe("declared");
    expect(PROVEN_STATUSES.has("tested")).toBe(true);
    expect(PROVEN_STATUSES.has("declared")).toBe(false);
  });
});

describe("authored change target binding", () => {
  const hash = `sha256:${"a".repeat(64)}` as const;
  const binding = {
    schemaVersion: 1 as const,
    targetId: "checkout-v2",
    revision: 2,
    artifactHash: hash,
  };
  const change = {
    id: "change.checkout",
    statement: "Adopt the reviewed checkout architecture",
    lifecycle: "active" as const,
    provenance: "author" as const,
    sourceRefs: [],
    serves: [],
    preserves: [],
    requiresEvidence: [],
    openUnknowns: [],
    repositoryLinks: [],
    tags: [],
  };

  it("validates a strict, versioned target identity without changing legacy contracts", () => {
    expect(ChangeTargetBindingV1Schema.parse(binding)).toEqual(binding);
    expect(ChangeContractSchema.parse(change)).toEqual(change);
    expect(normalizeLegacySemanticModelV1({ nodes: [], changes: [change] }).model.changes[0]).toEqual(change);
  });

  it("refuses future versions, unsafe ids, invalid revisions, hashes, and unknown fields", () => {
    for (const invalid of [
      { ...binding, schemaVersion: 2 },
      { ...binding, targetId: "../checkout" },
      { ...binding, targetId: "Checkout" },
      { ...binding, revision: 0 },
      { ...binding, revision: 1.5 },
      { ...binding, artifactHash: `sha256:${"A".repeat(64)}` },
      { ...binding, futureField: true },
    ]) {
      expect(ChangeTargetBindingV1Schema.safeParse(invalid).success).toBe(false);
    }
    expect(ChangeContractSchema.safeParse({ ...change, targetBinding: binding, futureField: true }).success).toBe(false);
  });

  it("preserves a valid binding through compatibility normalization without aliasing it", () => {
    const normalized = normalizeLegacySemanticModelV1({
      nodes: [],
      changes: [{ ...change, targetBinding: binding }],
    });
    expect(normalized.model.changes[0]?.targetBinding).toEqual(binding);
    expect(normalized.model.changes[0]?.targetBinding).not.toBe(binding);
  });
});

describe("versioned authored refinement model", () => {
  it("keeps authored public and parsed levels within L1 through L6", () => {
    const acceptAuthoredLevel = (_level: AuthoredSemanticLevel): void => {};
    const acceptNodeLevel = (_level: NonNullable<SemanticNode["appliesAtLevel"]>): void => {};
    const acceptParsedNodeLevel = (_level: NonNullable<SemanticNodeParsed["appliesAtLevel"]>): void => {};
    const acceptParsedChangeLevel = (_level: NonNullable<ChangeContractParsed["appliesAtLevel"]>): void => {};

    acceptAuthoredLevel(1);
    acceptNodeLevel(6);
    acceptParsedNodeLevel(2);
    acceptParsedChangeLevel(5);
    // @ts-expect-error L0 is reserved for observed hunks, not authored semantics.
    acceptAuthoredLevel(0);
    // @ts-expect-error SemanticNode must not expose L0 as an authored level.
    acceptNodeLevel(0);
    // @ts-expect-error Zod inference must preserve the authored-level restriction.
    acceptParsedNodeLevel(0);
    // @ts-expect-error ChangeContract Zod inference must preserve the authored-level restriction.
    acceptParsedChangeLevel(0);
  });

  it("keeps semantic kind independent from an explicit appliesAtLevel", () => {
    const base = {
      id: "goal.checkout",
      kind: "goal" as const,
      statement: "Checkout remains dependable",
      status: "declared" as const,
      provenance: "author" as const,
      sourceRefs: [],
      repositoryLinks: [],
      relations: [],
      tags: [],
    };

    expect(SemanticNodeSchema.parse({ ...base, appliesAtLevel: 2 }).kind).toBe("goal");
    expect(SemanticNodeSchema.parse({ ...base, appliesAtLevel: 6 }).kind).toBe("goal");
    expect(SemanticNodeSchema.parse({ ...base, kind: "invariant", appliesAtLevel: 6 }).appliesAtLevel).toBe(6);
    expect(SemanticNodeSchema.safeParse({ ...base, appliesAtLevel: 0 }).success).toBe(false);
    expect(ChangeContractSchema.safeParse({
      id: "change.checkout",
      statement: "Change checkout",
      lifecycle: "draft",
      provenance: "author",
      sourceRefs: [],
      serves: [],
      preserves: [],
      requiresEvidence: [],
      openUnknowns: [],
      repositoryLinks: [],
      tags: [],
      appliesAtLevel: 0,
    }).success).toBe(false);
  });

  it("reads a legacy model without inventing a level or certifying bare relations", () => {
    const legacy: SemanticModel = {
      nodes: [{
        id: "goal.legacy",
        kind: "goal",
        statement: "Legacy",
        status: "declared",
        provenance: "author",
        sourceRefs: [],
        repositoryLinks: [],
        relations: [{ kind: "implements", to: "invariant.legacy" }],
        tags: [],
      }],
      changes: [{
        id: "change.legacy",
        statement: "Legacy change",
        lifecycle: "draft",
        provenance: "author",
        sourceRefs: [],
        serves: [],
        preserves: [],
        requiresEvidence: [],
        openUnknowns: [],
        repositoryLinks: [],
        tags: [],
      }],
    };

    const normalized = normalizeLegacySemanticModelV1(legacy);
    expect(normalized.model.nodes[0]?.appliesAtLevel).toBeUndefined();
    expect(normalized.model.changes[0]?.appliesAtLevel).toBeUndefined();
    expect(normalized.model.refinementRelations).toEqual([]);
    expect(normalized.compatibility).toEqual([
      {
        schemaVersion: 1,
        source: "legacy_semantic_dsl_v1",
        subjectId: "goal.legacy",
        uncertainties: ["appliesAtLevel", "refinementEvidence"],
      },
      {
        schemaVersion: 1,
        source: "legacy_semantic_dsl_v1",
        subjectId: "change.legacy",
        uncertainties: ["appliesAtLevel"],
      },
    ]);
    expect(SemanticModelSchema.parse(normalized.model).nodes[0]?.kind).toBe("goal");
  });
});
