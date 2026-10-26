import { expect, test } from "bun:test";
import { compareExtraction, compareLeafGraph } from "./t00-ts7-q-boundary-extraction";

const extraction = { modules: ["entry.ts"], symbols: [{ relPath: "entry.ts", name: "captured", kind: "function", scope: [], startLine: 1, endLine: 1, exported: true, markers: [] }], imports: [], calls: [] };
const graph = { nodes: [{ id: "repo", kind: "repository", name: "fixture", evidence: [] }, { id: "module", kind: "module", name: "entry.ts", filePath: "entry.ts", evidence: [{ filePath: "entry.ts", sourceKind: "code" }] }, { id: "captured", kind: "function", name: "captured", filePath: "entry.ts", exported: true, evidence: [{ filePath: "entry.ts", startLine: 1, endLine: 1, sourceKind: "code" }] }], edges: [{ kind: "belongs_to", from: "module", to: "repo", evidence: [{ filePath: "entry.ts", sourceKind: "code" }] }, { kind: "declares", from: "module", to: "captured", evidence: [{ filePath: "entry.ts", startLine: 1, sourceKind: "code" }] }], integrityReasons: {} };

test("extraction comparison requires every collection, including empty controls", () => {
  expect(compareExtraction("leaf", extraction, extraction).every(row => row.pass)).toBe(true);
  expect(compareExtraction("leaf", {}, {}).some(row => !row.pass)).toBe(true);
  for (const key of ["modules", "symbols", "imports", "calls"]) {
    const altered = structuredClone(extraction) as Record<string, unknown>;
    delete altered[key];
    expect(compareExtraction("leaf", extraction, altered).some(row => !row.pass)).toBe(true);
  }
  expect(compareExtraction("leaf", extraction, { ...extraction, calls: [{ calleeName: "invented" }] }).some(row => !row.pass)).toBe(true);
});

test("leaf graph compares complete coordinates, endpoints and source provenance independently from IDs", () => {
  expect(compareLeafGraph("leaf", extraction, graph).every(row => row.pass)).toBe(true);
  for (const mutate of [
    (value: typeof graph) => { value.nodes.pop(); },
    (value: typeof graph) => { value.nodes.push(value.nodes[1]!); },
    (value: typeof graph) => { value.edges.pop(); },
    (value: typeof graph) => { value.edges[0]!.to = "foreign"; },
    (value: typeof graph) => { value.nodes[2]!.evidence = []; },
    (value: typeof graph) => { value.edges[1]!.evidence = []; },
    (value: typeof graph) => { value.nodes[2]!.exported = false; },
  ]) {
    const altered = structuredClone(graph);
    mutate(altered);
    expect(compareLeafGraph("leaf", extraction, altered).some(row => !row.pass)).toBe(true);
  }
});

test("test relation comparison rejects wrong endpoint and extra coverage", async () => {
  const { compareTestRelations } = await import("./t00-ts7-q-boundary-extraction");
  const actual = { nodes: [{ id: "test", kind: "test", filePath: "spec.ts", name: "spec.ts" }, { id: "fn", kind: "function", filePath: "main.ts", name: "main" }], edges: [{ kind: "covers", from: "test", to: "fn", evidence: [{ filePath: "spec.ts", startLine: 1, sourceKind: "test" }] }] };
  const expected = ["covers:test:spec.ts:spec.ts->function:main.ts:main"];
  expect(compareTestRelations("static", expected, actual, { path: "spec.ts", line: 1 }).every(row => row.pass)).toBe(true);
  expect(compareTestRelations("static", [], actual, { path: "spec.ts", line: 1 }).some(row => !row.pass)).toBe(true);
  expect(compareTestRelations("static", expected, actual, { path: "spec.ts", line: 2 }).some(row => !row.pass)).toBe(true);
  expect(compareTestRelations("static", expected, { ...actual, edges: [{ kind: "covers", from: "fn", to: "test" }] }, { path: "spec.ts", line: 1 }).some(row => !row.pass)).toBe(true);
});

test("simple composition compares import/call direction and line provenance", async () => {
  const { compareSimpleGraph } = await import("./t00-ts7-q-boundary-extraction");
  const expected = { modules: ["caller.ts", "target.ts"], symbols: [{ name: "target", kind: "function", relPath: "target.ts", scope: [], markers: [], exported: true, startLine: 2, endLine: 2 }], imports: [{ fromRelPath: "caller.ts", moduleSpecifier: "./target", resolvedRelPath: "target.ts", line: 1 }], calls: [{ callerRelPath: "caller.ts", calleeRelPath: "target.ts", calleeSymbolPath: "target", line: 3 }] };
  const actual = { nodes: [{ id: "repo", kind: "repository", evidence: [] }, { id: "caller", kind: "module", name: "caller.ts", filePath: "caller.ts", evidence: [{ filePath: "caller.ts", sourceKind: "code" }] }, { id: "target", kind: "module", name: "target.ts", filePath: "target.ts", evidence: [{ filePath: "target.ts", sourceKind: "code" }] }, { id: "function", kind: "function", name: "target", filePath: "target.ts", exported: true, evidence: [{ filePath: "target.ts", startLine: 2, endLine: 2, sourceKind: "code" }] }], edges: [{ kind: "belongs_to", from: "caller", to: "repo", evidence: [{ filePath: "caller.ts", sourceKind: "code" }] }, { kind: "belongs_to", from: "target", to: "repo", evidence: [{ filePath: "target.ts", sourceKind: "code" }] }, { kind: "declares", from: "target", to: "function", evidence: [{ filePath: "target.ts", startLine: 2, sourceKind: "code" }] }, { kind: "imports", from: "caller", to: "target", evidence: [{ filePath: "caller.ts", startLine: 1, sourceKind: "code" }] }, { kind: "calls", from: "caller", to: "function", evidence: [{ filePath: "caller.ts", startLine: 3, sourceKind: "code" }] }], integrityReasons: {} };
  expect(compareSimpleGraph("simple", expected, actual).every(row => row.pass)).toBe(true);
  const reversed = structuredClone(actual);
  reversed.edges.at(-1)!.from = "target";
  expect(compareSimpleGraph("simple", expected, reversed).some(row => !row.pass)).toBe(true);
  const wrongLine = structuredClone(actual);
  const callEvidence = wrongLine.edges.at(-1)!.evidence[0]!;
  if (!("startLine" in callEvidence)) throw new Error("call fixture lacks line evidence");
  callEvidence.startLine = 2;
  expect(compareSimpleGraph("simple", expected, wrongLine).some(row => !row.pass)).toBe(true);
});
