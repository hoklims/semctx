import { expect, test } from "bun:test";
import { compareContractOwnership, projectContractOwnership } from "./t00-ts7-q-semantic-contract-ownership";
import type { OwnershipProjection } from "./t00-ts7-q-semantic-contract-ownership";

const expected: OwnershipProjection = {
  status: "projected", gaps: [], proof: { root: "/project", callbacks: new Map(), graph: {
    nodes: [
      { id: "m", kind: "module", filePath: "main.ts", name: "main.ts", metadata: {} },
      { id: "o", kind: "function", filePath: "main.ts", name: "owner", metadata: {} },
      { id: "t", kind: "function", filePath: "main.ts", name: "target", metadata: {} },
    ],
    edges: [{ kind: "calls", from: "o", to: "t", evidence: [{ filePath: "main.ts", startLine: 3 }] }],
  } },
};
const actual = () => ({ assembly: {
  nodes: expected.proof.graph.nodes.map(node => ({ ...node, id: `producer-${node.id}` })),
  edges: [{ kind: "calls", from: "producer-o", to: "producer-t", evidence: [{ filePath: "main.ts", startLine: 3 }] }],
} });

test("retained ownership compares coordinates and calls independently of producer IDs", () => {
  expect(compareContractOwnership(actual(), expected)).toBe(true);
});

test("missing edges, stale lines, duplicate owners and absent graph cannot pass", () => {
  const missing = actual();
  missing.assembly.edges = [];
  expect(compareContractOwnership(missing, expected)).toBe(false);
  const stale = actual();
  stale.assembly.edges[0]!.evidence[0]!.startLine = 4;
  expect(compareContractOwnership(stale, expected)).toBe(false);
  const duplicate = actual();
  duplicate.assembly.nodes.push({ ...duplicate.assembly.nodes[1]!, id: "duplicate" });
  expect(compareContractOwnership(duplicate, expected)).toBe(false);
  expect(compareContractOwnership({}, expected)).toBe(false);
  expect(compareContractOwnership(actual(), { status: "unsupported", gaps: ["missing"] })).toBe(false);
});

test("source declarations and a resolved call produce the ownership relation at its native line", () => {
  const text = "function target(){}\nfunction owner(){\n target();\n}";
  const raw = [
    { id: "s", kind: "SourceFile", start: 0, end: text.length, parent: null, children: ["t", "o"], fields: { statements: ["t", "o"] } },
    { id: "t", kind: "FunctionDeclaration", start: 0, end: 19, parent: "s", children: ["tn", "tb"], fields: { name: "tn", body: "tb" } },
    { id: "tn", kind: "Identifier", start: 9, end: 15, parent: "t", children: [], fields: {}, literalText: "target" },
    { id: "tb", kind: "Block", start: 17, end: 19, parent: "t", children: [], fields: { statements: [] } },
    { id: "o", kind: "FunctionDeclaration", start: 20, end: text.length, parent: "s", children: ["on", "ob"], fields: { name: "on", body: "ob" } },
    { id: "on", kind: "Identifier", start: 29, end: 34, parent: "o", children: [], fields: {}, literalText: "owner" },
    { id: "ob", kind: "Block", start: 36, end: text.length, parent: "o", children: ["e"], fields: { statements: ["e"] } },
    { id: "e", kind: "ExpressionStatement", start: 39, end: 48, parent: "ob", children: ["c"], fields: { expression: "c" } },
    { id: "c", kind: "CallExpression", start: 39, end: 47, parent: "e", children: ["cn"], fields: { expression: "cn", arguments: [] } },
    { id: "cn", kind: "Identifier", start: 39, end: 45, parent: "c", children: [], fields: {}, literalText: "target" },
  ];
  const reference = (id: string) => { const node = raw.find(node => node.id === id)!; return { kind: node.kind, start: node.start, end: node.end }; };
  const nodes = raw.map(node => ({ ...node, pos: node.start, text: text.slice(node.start, node.end), parent: node.parent === null ? null : reference(node.parent), children: node.children.map(reference), fields: Object.fromEntries(Object.entries(node.fields).map(([field, value]) => [field, Array.isArray(value) ? value.map(reference) : reference(value)])), ...(node.id === "cn" ? { symbol: { name: "target", flagsBits: 16, declarations: [{ ...reference("t"), path: "/project/main.ts" }] } } : {}) }));
  const native = { compilerConstants: { symbolFlags: { Alias: 2097152 } }, files: [{ path: "/project/main.ts", text, isDeclarationFile: false, nodes }] };
  const projected = projectContractOwnership(native, "main.ts", { "main.ts": text });
  expect(projected.status).toBe("projected");
  expect(compareContractOwnership(actual(), projected)).toBe(true);
});
