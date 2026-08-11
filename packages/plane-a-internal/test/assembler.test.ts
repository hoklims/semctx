import { describe, expect, it } from "bun:test";
import type { PlaneAFact } from "../src/index";

const api = await import("../src/index").catch(() => null);

const scope = {
  repositoryIdentity: "repo:fixture",
  sourceStateDigest: "sha256:source",
  selectedPathSetDigest: "sha256:paths",
  selectedPaths: ["src/a.ts"],
  language: "typescript",
  dialectVersion: "5.6",
} as const;

const producer = {
  identity: "@semantic-context/ts-analyzer",
  version: "0.1.0",
} as const;

interface RejectionCase {
  name: string;
  expectedCode: string;
  facts: readonly PlaneAFact[];
}

function batch(facts: readonly PlaneAFact[]) {
  return {
    schemaVersion: 1 as const,
    batchId: "batch:typescript",
    scope,
    producer,
    producerConfigurationDigest: "sha256:config",
    factSchemaDigest: "sha256:schema",
    sourceDigest: "sha256:source",
    factKinds: ["module", "import"] as const,
    capabilityProfileIds: ["cap:typescript"],
    evidenceContract: "source-lines-v1",
    facts,
  };
}

describe("provisional Plane A graph assembly", () => {
  it("exists only behind the private internal package", () => {
    expect(api).not.toBeNull();
  });

  it("normalizes fact order while preserving legacy compatible enrichment semantics", () => {
    if (api === null) throw new Error("internal Plane A API is unavailable");
    const facts = [
      {
        factType: "edge",
        ordinal: 2,
        kind: "belongs_to",
        from: "mod:src/a.ts",
        to: "repo:fixture",
        evidence: [{ filePath: "src/a.ts", sourceKind: "code" }],
        metadata: {},
      },
      {
        factType: "node",
        ordinal: 3,
        id: "mod:src/a.ts",
        kind: "module",
        name: "a.ts",
        filePath: "src/a.ts",
        evidence: [{ filePath: "src/a.ts", startLine: 2, sourceKind: "code" }],
        tags: ["enriched"],
        metadata: { later: true },
      },
      {
        factType: "node",
        ordinal: 0,
        id: "repo:fixture",
        kind: "repository",
        name: "fixture",
        evidence: [],
        tags: [],
        metadata: { root: "/fixture" },
      },
      {
        factType: "node",
        ordinal: 1,
        id: "mod:src/a.ts",
        kind: "module",
        name: "a.ts",
        filePath: "src/a.ts",
        evidence: [{ filePath: "src/a.ts", startLine: 1, sourceKind: "code" }],
        tags: [],
        metadata: { first: true },
      },
    ] as const;

    const forward = api.assembleFactBatches([batch(facts)]);
    const reverse = api.assembleFactBatches([batch([...facts].reverse())]);

    expect(reverse).toEqual(forward);
    expect(forward.graph.nodes.find((node) => node.id === "mod:src/a.ts")).toEqual({
      id: "mod:src/a.ts",
      kind: "module",
      name: "a.ts",
      filePath: "src/a.ts",
      evidence: [
        { filePath: "src/a.ts", startLine: 1, sourceKind: "code" },
        { filePath: "src/a.ts", startLine: 2, sourceKind: "code" },
      ],
      tags: ["enriched"],
      metadata: { first: true, later: true },
    });
  });

  it.each([
    {
      name: "true node id conflicts",
      expectedCode: "FACT_ID_CONFLICT",
      facts: [
        { factType: "node", ordinal: 0, id: "same", kind: "module", name: "a", evidence: [], tags: [], metadata: {} },
        { factType: "node", ordinal: 1, id: "same", kind: "test", name: "b", evidence: [], tags: [], metadata: {} },
      ],
    },
    {
      name: "invalid evidence ranges",
      expectedCode: "INVALID_EVIDENCE_RANGE",
      facts: [
        {
          factType: "node",
          ordinal: 0,
          id: "bad-range",
          kind: "module",
          name: "bad",
          filePath: "src/a.ts",
          evidence: [{ filePath: "src/a.ts", startLine: 4, endLine: 2, sourceKind: "code" }],
          tags: [],
          metadata: {},
        },
      ],
    },
    {
      name: "out-of-scope facts",
      expectedCode: "FACT_OUT_OF_SCOPE",
      facts: [
        {
          factType: "node",
          ordinal: 0,
          id: "outside",
          kind: "module",
          name: "outside",
          filePath: "src/outside.ts",
          evidence: [],
          tags: [],
          metadata: {},
        },
      ],
    },
    {
      name: "edges with missing endpoints",
      expectedCode: "MISSING_ENDPOINT",
      facts: [
        {
          factType: "edge",
          ordinal: 0,
          kind: "imports",
          from: "missing:a",
          to: "missing:b",
          evidence: [{ filePath: "src/a.ts", sourceKind: "code" }],
          metadata: {},
        },
      ],
    },
  ] satisfies readonly RejectionCase[])("rejects $name deterministically", ({ expectedCode, facts }) => {
    if (api === null) throw new Error("internal Plane A API is unavailable");
    expect(() => api.assembleFactBatches([batch(facts)])).toThrow(
      expect.objectContaining({ code: expectedCode }),
    );
  });

  // A missing endpoint on an internally derived edge stays fatal (covered above): it means the
  // assembler contradicted itself. An authored cross-reference is different — it is user input, and
  // naming a target this repository does not contain is an unresolved link, not an assembly defect.
  it("records an authored cross-reference to an absent endpoint instead of aborting the assembly", () => {
    if (api === null) throw new Error("internal Plane A API is unavailable");
    const evidence = [{ filePath: "src/a.ts", startLine: 1, sourceKind: "document" as const }];
    const facts: readonly PlaneAFact[] = [
      {
        factType: "node",
        ordinal: 0,
        id: "doc:src/a.ts",
        kind: "document",
        name: "a",
        filePath: "src/a.ts",
        evidence,
        tags: [],
        metadata: {},
      },
      {
        factType: "edge",
        ordinal: 1,
        kind: "contradicts",
        from: "doc:src/a.ts",
        to: "doc:docs/absent.md",
        evidence,
        metadata: { declared: true },
      },
    ];

    const assembled = api.assembleFactBatches([batch(facts)]);

    expect(assembled.graph.nodes.map((node) => node.id)).toEqual(["doc:src/a.ts"]);
    expect(assembled.graph.edges).toEqual([]);
    expect(assembled.unresolvedReferences).toEqual([
      expect.objectContaining({
        kind: "contradicts",
        from: "doc:src/a.ts",
        to: "doc:docs/absent.md",
        missing: "doc:docs/absent.md",
      }),
    ]);
  });

  it("validates every fact against its own batch scope rather than the union of batch paths", () => {
    if (api === null) throw new Error("internal Plane A API is unavailable");
    const wrongScopeFact = {
      factType: "node" as const,
      ordinal: 0,
      id: "mod:src/b.ts",
      kind: "module" as const,
      name: "b.ts",
      filePath: "src/b.ts",
      evidence: [{ filePath: "src/b.ts", sourceKind: "code" as const }],
      tags: [],
      metadata: {},
    };
    const secondScope = {
      ...scope,
      selectedPathSetDigest: "sha256:paths-b",
      selectedPaths: ["src/b.ts"],
    };

    expect(() => api.assembleFactBatches([
      batch([wrongScopeFact]),
      {
        ...batch([]),
        batchId: "batch:b",
        scope: secondScope,
      },
    ])).toThrow(expect.objectContaining({ code: "FACT_OUT_OF_SCOPE" }));
  });

  it("rejects colliding node and edge metadata instead of keeping whichever fact arrived first", () => {
    if (api === null) throw new Error("internal Plane A API is unavailable");
    const nodes: PlaneAFact[] = [
      {
        factType: "node" as const,
        ordinal: 0,
        id: "repo:fixture",
        kind: "repository" as const,
        name: "fixture",
        evidence: [],
        tags: [],
        metadata: {},
      },
      {
        factType: "node" as const,
        ordinal: 1,
        id: "mod:src/a.ts",
        kind: "module" as const,
        name: "a.ts",
        filePath: "src/a.ts",
        evidence: [],
        tags: [],
        metadata: { owner: "one" },
      },
      {
        factType: "node" as const,
        ordinal: 2,
        id: "mod:src/a.ts",
        kind: "module" as const,
        name: "a.ts",
        filePath: "src/a.ts",
        evidence: [],
        tags: [],
        metadata: { owner: "two" },
      },
    ];
    expect(() => api.assembleFactBatches([batch(nodes)])).toThrow(
      expect.objectContaining({ code: "FACT_ID_CONFLICT" }),
    );

    const edges: PlaneAFact[] = [
      ...nodes.slice(0, 2).map((node, ordinal) => ({ ...node, ordinal })),
      {
        factType: "edge" as const,
        ordinal: 2,
        kind: "belongs_to" as const,
        from: "mod:src/a.ts",
        to: "repo:fixture",
        evidence: [],
        metadata: { source: "one" },
      },
      {
        factType: "edge" as const,
        ordinal: 3,
        kind: "belongs_to" as const,
        from: "mod:src/a.ts",
        to: "repo:fixture",
        evidence: [],
        metadata: { source: "two" },
      },
    ];
    expect(() => api.assembleFactBatches([batch(edges)])).toThrow(
      expect.objectContaining({ code: "FACT_ID_CONFLICT" }),
    );
  });
});
