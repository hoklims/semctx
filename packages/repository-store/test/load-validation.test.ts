import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimSchema, ContextPackSchema, RepositoryEdgeSchema, RepositoryNodeSchema, SemctxError, TaskFrameSchema, type Claim, type ContextPack, type EvidenceRecord, type RepositoryGraph, type TaskFrame } from "@semantic-context/core";
import { SqliteRepositoryReader, SqliteRepositoryStore } from "@semantic-context/repository-store";

const graph: RepositoryGraph = {
  nodes: [{ id: "node:1", kind: "module", name: "a", evidence: [{ filePath: "a.ts", sourceKind: "code" }], tags: [], metadata: {} }],
  edges: [{ id: "edge:1", kind: "imports", from: "node:1", to: "node:1", evidence: [], metadata: {} }],
};
const claim: Claim = {
  id: "claim:1", kind: "behavior", statement: "works", subjectNodeIds: ["node:1"], evidenceIds: ["evidence:1"],
  authority: 1, freshness: 1, confidence: 1, verificationStatus: "tested", tags: [],
};
const task: TaskFrame = {
  id: "task:1", rawTask: "fix", mode: "bugfix", capabilities: [], observedBehavior: [], expectedBehavior: [],
  boundedContexts: [], hardInvariants: [], softConstraints: [], acceptanceEvidence: [], nonGoals: [], riskSurfaces: [],
  hypotheses: [], createdAt: "2026-01-01T00:00:00.000Z",
};
const pack: ContextPack = {
  taskFrame: task, hardConstraints: [claim], authoritativeClaims: [], primaryNodes: graph.nodes, secondaryNodes: [],
  impactPaths: [], relevantTests: [], contradictions: [], unknowns: [], recommendedReads: [],
  verificationPlan: { steps: [], requiredTests: [], notes: [] }, generatedAt: task.createdAt,
  evidence: [{ id: "evidence:1", filePath: "a.ts", sourceKind: "code" }], priorityExplanations: [],
  meta: { taskId: task.id, questionKind: "runtime_behavior", deterministic: true, generator: "test", candidateProviders: [], warnings: [] },
};

function database(test: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "semctx-invalid-load-"));
  const path = join(dir, "test.db");
  const store = SqliteRepositoryStore.open(path);
  try {
    store.replaceIndex({ graph, evidence: pack.evidence, claims: [claim], metadata: {} });
    store.saveTaskFrame(task);
    store.saveContextPack(pack);
  } finally {
    store.close();
  }
  try {
    test(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectLoadError(load: () => unknown, table: string, id: string): void {
  expect(load).toThrow(SemctxError);
  try {
    load();
  } catch (error) {
    expect(error).toMatchObject({ name: "SemctxError", code: "STORE_ERROR", details: { table, id } });
  }
}

const corruptions = [
  ["nodes", "node:1", "kind", "unknown"],
  ["nodes", "node:1", "exported", 2],
  ["nodes", "node:1", "exported", "bad"],
  ["nodes", "node:1", "evidence", "{"],
  ["nodes", "node:1", "evidence", "null"],
  ["nodes", "node:1", "evidence", "[null]"],
  ["nodes", "node:1", "evidence", '[{"filePath":"a.ts","sourceKind":"unknown"}]'],
  ["nodes", "node:1", "evidence", '[{"filePath":"a.ts","sourceKind":"code","startLine":"1"}]'],
  ["nodes", "node:1", "tags", "[1]"],
  ["nodes", "node:1", "metadata", '{"nested":{}}'],
  ["edges", "edge:1", "kind", "unknown"],
  ["edges", "edge:1", "evidence", "[{}]"],
  ["edges", "edge:1", "metadata", "[]"],
  ["evidence", "evidence:1", "source_kind", "unknown"],
  ["evidence", "evidence:1", "start_line", "zero"],
  ["claims", "claim:1", "kind", "unknown"],
  ["claims", "claim:1", "evidence_ids", "[{}]"],
  ["claims", "claim:1", "subject_node_ids", "{}"],
  ["claims", "claim:1", "verification_status", "unknown"],
  ["claims", "claim:1", "confidence", 2],
  ["task_frames", "task:1", "payload", "{"],
  ["task_frames", "task:1", "payload", "null"],
  ["task_frames", "task:1", "payload", JSON.stringify({ ...task, hypotheses: [{ status: "unknown" }] })],
  ["task_frames", "task:1", "payload", JSON.stringify({ ...task, capabilities: [1] })],
  ["context_packs", "task:1", "payload", "{"],
  ["context_packs", "task:1", "payload", "{}"],
  ["context_packs", "task:1", "payload", JSON.stringify({ ...pack, primaryNodes: [{ ...graph.nodes[0], kind: "unknown" }] })],
  ["context_packs", "task:1", "payload", JSON.stringify({ ...pack, hardConstraints: [{ ...claim, evidenceIds: [1] }] })],
] as const;

describe("SQLite load validation", () => {
  for (const field of ["tags", "evidence"] as const) {
    it(`rejects masked invalid indexed node ${field} in public and context schemas`, () => {
      const masked: unknown[] = [1];
      Object.defineProperty(masked, Symbol.iterator, { value: function* () { yield field === "tags" ? "valid" : { filePath: "a.ts", sourceKind: "code" }; } });
      const node = { ...graph.nodes[0]!, [field]: masked };
      expect(RepositoryNodeSchema.safeParse(node).success).toBe(false);
      expect(ContextPackSchema.safeParse({ ...pack, primaryNodes: [node] }).success).toBe(false);
    });
  }

  it("accepts standard JSON node arrays and rejects sparse arrays", () => {
    expect(RepositoryNodeSchema.safeParse(JSON.parse(JSON.stringify(graph.nodes[0]))).success).toBe(true);
    for (const field of ["tags", "evidence"] as const) {
      expect(RepositoryNodeSchema.safeParse({ ...graph.nodes[0], [field]: new Array(1) }).success).toBe(false);
    }
  });

  it("rejects masked indexed values in task payload arrays", () => {
    const capabilities: unknown[] = [1];
    Object.defineProperty(capabilities, Symbol.iterator, { value: function* () { yield "valid"; } });
    const invalidTask = { ...task, capabilities };
    expect(TaskFrameSchema.safeParse(invalidTask).success).toBe(false);
    expect(ContextPackSchema.safeParse({ ...pack, taskFrame: invalidTask }).success).toBe(false);
  });

  function ownProto<T extends object>(value: T): T {
    return JSON.parse(`${JSON.stringify(value).slice(0, -1)},"__proto__":{"items":["original"]}}`) as T;
  }

  function protoPayload(): ContextPack {
    return ownProto({
      ...pack,
      taskFrame: ownProto({ ...task, hypotheses: [ownProto({ id: "hypothesis:1", statement: "works", confidence: 1, evidenceIds: [], status: "supported" as const })] }),
      hardConstraints: [ownProto(claim)],
      impactPaths: [ownProto({ nodeIds: ["node:1"], edgeKinds: ["imports" as const], description: "path" })],
      recommendedReads: [ownProto({ path: "a.ts", reason: "inspect", priority: "high" as const, evidenceIds: [] })],
      verificationPlan: ownProto({ ...pack.verificationPlan, steps: [ownProto({ description: "inspect", kind: "manual_review" as const, targetNodeIds: [], evidenceIds: [] })] }),
      meta: ownProto(pack.meta),
    });
  }

  function expectOwnProto(value: object): void {
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Reflect.get(value, "__proto__")).toEqual({ items: ["original"] });
  }

  it("preserves own __proto__ data through public payload schemas", () => {
    const original = protoPayload();
    expectOwnProto(TaskFrameSchema.parse(original.taskFrame));
    expectOwnProto(ClaimSchema.parse(original.hardConstraints[0]));
    const parsed = ContextPackSchema.parse(original);
    for (const value of [parsed, parsed.taskFrame, parsed.taskFrame.hypotheses[0]!, parsed.hardConstraints[0]!, parsed.impactPaths[0]!, parsed.recommendedReads[0]!, parsed.verificationPlan, parsed.verificationPlan.steps[0]!, parsed.meta]) expectOwnProto(value);
    expect(parsed).toEqual(original);
  });

  it("preserves own __proto__ data and independent reloads through SQLite payload readers", () => database((path) => {
    const original = protoPayload();
    const store = SqliteRepositoryStore.open(path);
    try {
      store.saveTaskFrame(original.taskFrame);
      store.saveContextPack(original);
      expectOwnProto(store.getTaskFrame(task.id)!);
      expectOwnProto(store.listTaskFrames()[0]!);
      const loaded = store.getContextPack(task.id)!;
      for (const value of [loaded, loaded.taskFrame, loaded.taskFrame.hypotheses[0]!, loaded.hardConstraints[0]!, loaded.impactPaths[0]!, loaded.recommendedReads[0]!, loaded.verificationPlan, loaded.verificationPlan.steps[0]!, loaded.meta]) expectOwnProto(value);
      (Reflect.get(loaded.meta, "__proto__") as { items: string[] }).items[0] = "modified";
      expect(store.getContextPack(task.id)).toEqual(original);
    } finally { store.close(); }
    const reader = SqliteRepositoryReader.openExisting(path);
    try { expectOwnProto(reader.getTaskFrame(task.id)!); } finally { reader.close(); }
  }));

  it("preserves JSON extensions throughout task and context payloads", () => database((path) => {
    const extendedTask = {
      ...task, extension: { owner: "consumer" },
      hypotheses: [{ id: "hypothesis:1", statement: "works", confidence: 1, evidenceIds: [], status: "supported" as const, extension: ["hypothesis"] }],
    };
    const extendedClaim = { ...claim, extension: { policy: ["consumer"] } };
    const extendedPack = {
      ...pack, taskFrame: extendedTask, hardConstraints: [extendedClaim], extension: { version: 2 },
      impactPaths: [{ nodeIds: ["node:1"], edgeKinds: ["imports" as const], description: "path", extension: true }],
      recommendedReads: [{ path: "a.ts", reason: "inspect", priority: "high" as const, evidenceIds: [], extension: "read" }],
      verificationPlan: {
        ...pack.verificationPlan, extension: "plan",
        steps: [{ description: "inspect", kind: "manual_review" as const, targetNodeIds: [], evidenceIds: [], extension: "step" }],
      },
      meta: { ...pack.meta, extension: "meta" },
    };
    const store = SqliteRepositoryStore.open(path);
    try {
      store.saveTaskFrame(extendedTask);
      store.saveContextPack(extendedPack);
      expect(store.getTaskFrame(task.id)).toEqual(extendedTask);
      expect(store.listTaskFrames()).toEqual([extendedTask]);
      expect(store.getContextPack(task.id)).toEqual(extendedPack);
    } finally { store.close(); }
    const reader = SqliteRepositoryReader.openExisting(path);
    try { expect(reader.getTaskFrame(task.id)).toEqual(extendedTask); } finally { reader.close(); }
  }));

  it("preserves valid JSON extension fields without changing object prototypes", () => database((path) => {
    const attached = JSON.parse('{"id":"evidence:extended","filePath":"a.ts","sourceKind":"code","extension":{"items":["original"]},"__proto__":"evidence-value"}') as EvidenceRecord;
    const metadata = JSON.parse('{"value":"original","__proto__":"metadata-value"}') as RepositoryGraph["nodes"][number]["metadata"];
    const extendedGraph: RepositoryGraph = {
      nodes: graph.nodes.map((node) => ({ ...node, evidence: [attached], metadata })),
      edges: graph.edges.map((edge) => ({ ...edge, evidence: [attached], metadata })),
    };
    const writer = SqliteRepositoryStore.open(path);
    try { writer.saveGraph(extendedGraph, [attached]); } finally { writer.close(); }
    for (const open of [(value: string) => SqliteRepositoryStore.open(value), (value: string) => SqliteRepositoryReader.openExisting(value)]) {
      const reader = open(path);
      try {
        const loaded = reader.loadGraph();
        expect(loaded).toEqual(extendedGraph);
        for (const item of [...loaded.nodes, ...loaded.edges]) {
          expect(Object.hasOwn(item.metadata, "__proto__")).toBe(true);
          expect(Object.getPrototypeOf(item.metadata)).toBe(Object.prototype);
          expect(Object.hasOwn(item.evidence[0]!, "__proto__")).toBe(true);
          expect(Object.getPrototypeOf(item.evidence[0]!)).toBe(Object.prototype);
        }
      } finally { reader.close(); }
    }
  }));

  it("reloads independent graph values after a returned graph is deeply modified", () => database((path) => {
    const attached: EvidenceRecord & { extension: { items: string[] } } = {
      id: "evidence:extended", filePath: "a.ts", sourceKind: "code", extension: { items: ["original"] },
    };
    const independentGraph: RepositoryGraph = {
      nodes: graph.nodes.map((node) => ({ ...node, evidence: [attached], tags: ["original"], metadata: { value: "original" } })),
      edges: graph.edges.map((edge) => ({ ...edge, evidence: [attached], metadata: { value: "original" } })),
    };
    const writer = SqliteRepositoryStore.open(path);
    try { writer.saveGraph(independentGraph, [attached]); } finally { writer.close(); }
    for (const open of [(value: string) => SqliteRepositoryStore.open(value), (value: string) => SqliteRepositoryReader.openExisting(value)]) {
      const reader = open(path);
      try {
        const loaded = reader.loadGraph();
        loaded.nodes[0]!.name = "modified";
        loaded.nodes[0]!.tags[0] = "modified";
        loaded.nodes[0]!.metadata["value"] = "modified";
        loaded.edges[0]!.metadata["value"] = "modified";
        const extension = Reflect.get(loaded.nodes[0]!.evidence[0]!, "extension") as { items: string[] };
        extension.items[0] = "modified";
        expect(reader.loadGraph()).toEqual(independentGraph);
      } finally { reader.close(); }
    }
  }));

  it("preserves valid node extension fields within context packs", () => database((path) => {
    const extended = { ...graph.nodes[0]!, extension: { notes: ["original"] } };
    const extendedPack: ContextPack = { ...pack, primaryNodes: [extended] };
    const store = SqliteRepositoryStore.open(path);
    try {
      store.saveContextPack(extendedPack);
      expect(store.getContextPack(task.id)).toEqual(extendedPack);
    } finally { store.close(); }
  }));

  it("retains attached evidence record ids through both graph readers", () => database((path) => {
    const record: EvidenceRecord = { id: "evidence:attached", filePath: "a.ts", sourceKind: "code" };
    const attachedGraph: RepositoryGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, evidence: [record] })),
    };
    const store = SqliteRepositoryStore.open(path);
    try {
      store.saveGraph(attachedGraph, [record]);
      expect(store.loadGraph()).toEqual(attachedGraph);
    } finally {
      store.close();
    }
    const reader = SqliteRepositoryReader.openExisting(path);
    try {
      expect(reader.loadGraph()).toEqual(attachedGraph);
    } finally {
      reader.close();
    }
  }));

  for (const [index, [table, id, column, value]] of corruptions.entries()) {
    it(`identifies ${table}.${column} corruption case ${index + 1}`, () => database((path) => {
      const db = new Database(path);
      db.query(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(value, id);
      db.close();
      const store = SqliteRepositoryStore.open(path);
      try {
        const load = table === "nodes" || table === "edges" ? () => store.loadGraph()
          : table === "claims" ? () => store.loadClaims()
          : table === "evidence" ? () => store.loadEvidence()
          : table === "task_frames" ? () => store.getTaskFrame(id)
          : () => store.getContextPack(id);
        expectLoadError(load, table, id);
        if (table === "task_frames") expectLoadError(() => store.listTaskFrames(), table, id);
      } finally {
        store.close();
      }
      const reader = SqliteRepositoryReader.openExisting(path);
      try {
        if (table === "nodes" || table === "edges") expectLoadError(() => reader.loadGraph(), table, id);
        if (table === "claims") expectLoadError(() => reader.loadClaims(), table, id);
        if (table === "evidence") expectLoadError(() => reader.loadEvidence(), table, id);
        if (table === "task_frames") expectLoadError(() => reader.getTaskFrame(id), table, id);
      } finally {
        reader.close();
      }
      const unchanged = new Database(path, { readonly: true });
      try {
        expect(unchanged.query(`SELECT ${column} AS value FROM ${table} WHERE id = ?`).get(id)).toEqual({ value });
      } finally {
        unchanged.close();
      }
    }));
  }

  it("round-trips valid nested payloads and preserves absent-row results", () => database((path) => {
    const store = SqliteRepositoryStore.open(path);
    try {
      expect(store.loadGraph()).toEqual(graph);
      expect(store.loadClaims()).toEqual([claim]);
      expect(store.getTaskFrame(task.id)).toEqual(task);
      expect(store.listTaskFrames()).toEqual([task]);
      expect(store.getContextPack(task.id)).toEqual(pack);
      expect(store.getTaskFrame("missing")).toBeUndefined();
      expect(store.getContextPack("missing")).toBeUndefined();
    } finally {
      store.close();
    }
  }));
});

describe("owned graph decoding matches canonical JSON schemas", () => {
  it("retains canonical inherited enumerable metadata semantics", () => database((path) => {
    const key = "semctxOwnedMetadataInheritedTest";
    try {
      for (const value of ["accepted", {}]) {
        Object.defineProperty(Object.prototype, key, { value, enumerable: true, configurable: true });
        const valid = typeof value === "string";
        expect(RepositoryNodeSchema.safeParse(graph.nodes[0]).success).toBe(valid);
        expect(RepositoryEdgeSchema.safeParse(graph.edges[0]).success).toBe(valid);
        for (const open of [(p: string) => SqliteRepositoryStore.open(p), (p: string) => SqliteRepositoryReader.openExisting(p)]) {
          const reader = open(path);
          try {
            if (valid) expect(reader.loadGraph()).toEqual(graph);
            else expectLoadError(() => reader.loadGraph(), "nodes", "node:1");
          } finally { reader.close(); }
        }
      }
    } finally { Reflect.deleteProperty(Object.prototype, key); }
  }));

  const cases = [
    ["nodes", "name", 42, true], // TEXT affinity returns a string.
    ["nodes", "file_path", null, true],
    ["nodes", "bounded_context", null, true],
    ["nodes", "exported", "1", true], // INTEGER affinity returns 1.
    ["nodes", "exported", 0, true],
    ["nodes", "exported", null, true],
    ["nodes", "exported", 1.5, false],
    ["nodes", "name", new Uint8Array([97]), false],
    ["nodes", "file_path", new Uint8Array([97]), false],
    ["nodes", "bounded_context", new Uint8Array([97]), false],
    ["nodes", "id", "", false],
    ["nodes", "id", null, false],
    ["edges", "id", "", false],
    ["edges", "from_id", "", false],
    ["edges", "to_id", new Uint8Array([97]), false],
    ["nodes", "tags", "null", false],
    ["nodes", "tags", "{}", false],
    ["nodes", "tags", '["", "x", "x"]', true],
    ["nodes", "evidence", '[[]]', false],
    ["nodes", "evidence", '[{"filePath":1,"sourceKind":"code"}]', false],
    ["nodes", "evidence", '[{"filePath":"","sourceKind":"manual","startLine":9007199254740991,"endLine":1,"excerpt":"","extension":{"n":1e400},"__proto__":{"keep":true}}]', true],
    ["nodes", "evidence", '[{"filePath":"a","sourceKind":"code","startLine":9007199254740992}]', false],
    ["nodes", "evidence", '[{"filePath":"a","sourceKind":"code","endLine":1e400}]', false],
    ["nodes", "evidence", '[{"filePath":"a","sourceKind":"code","startLine":0}]', false],
    ["edges", "evidence", '[{"filePath":"a","sourceKind":"git","endLine":-1}]', false],
    ["edges", "evidence", '[{"filePath":"a","sourceKind":"runtime","excerpt":null}]', false],
    ["edges", "evidence", '[{"filePath":"","sourceKind":"test","extension":[1,null],"__proto__":"keep"}]', true],
    ["nodes", "metadata", 'null', false],
    ["nodes", "metadata", '{"n":1e400}', false],
    ["edges", "metadata", '{"n":-1e400}', false],
    ["edges", "metadata", '{"n":null}', false],
    ["nodes", "metadata", '{"__proto__":"keep","n":9007199254740992,"b":false,"s":""}', true],
    ["edges", "metadata", '{"__proto__":{"nested":true}}', false],
  ] as const;

  for (const [index, [table, column, value, valid]] of cases.entries()) {
    it(`matches canonical ${table}.${column} case ${index + 1}`, () => database((path) => {
      const originalId = table === "nodes" ? "node:1" : "edge:1";
      const db = new Database(path);
      let raw: Record<string, unknown>;
      try {
        db.query(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(value, originalId);
        raw = db.query(`SELECT * FROM ${table}`).get() as Record<string, unknown>;
      } finally { db.close(); }
      const expected = table === "nodes" ? {
        id: raw["id"], kind: raw["kind"], name: raw["name"],
        ...(raw["file_path"] !== null ? { filePath: raw["file_path"] } : {}),
        ...(raw["bounded_context"] !== null ? { boundedContext: raw["bounded_context"] } : {}),
        ...(raw["exported"] !== null ? { exported: raw["exported"] === 1 } : {}),
        evidence: JSON.parse(raw["evidence"] as string) as unknown,
        tags: JSON.parse(raw["tags"] as string) as unknown,
        metadata: JSON.parse(raw["metadata"] as string) as unknown,
      } : {
        id: raw["id"], kind: raw["kind"], from: raw["from_id"], to: raw["to_id"],
        evidence: JSON.parse(raw["evidence"] as string) as unknown,
        metadata: JSON.parse(raw["metadata"] as string) as unknown,
      };
      const canonical = (table === "nodes" ? RepositoryNodeSchema : RepositoryEdgeSchema).safeParse(expected);
      // SQLite's exported encoding is stricter than a decoded boolean.
      if (column === "exported" && !valid) expect(canonical.success).toBe(true);
      else expect(canonical.success).toBe(valid);
      for (const open of [(p: string) => SqliteRepositoryStore.open(p), (p: string) => SqliteRepositoryReader.openExisting(p)]) {
        const reader = open(path);
        try {
          if (valid) {
            const loaded = reader.loadGraph()[table][0]!;
            expect(loaded as unknown).toEqual(expected);
            expect(JSON.stringify(loaded)).toBe(JSON.stringify(expected));
          } else {
            expect(() => reader.loadGraph()).toThrow(SemctxError);
            try { reader.loadGraph(); } catch (error) {
              expect(error).toMatchObject({ code: "STORE_ERROR", details: { table, id: raw["id"], cause: expect.any(String) } });
            }
          }
        } finally { reader.close(); }
      }
    }));
  }
});
