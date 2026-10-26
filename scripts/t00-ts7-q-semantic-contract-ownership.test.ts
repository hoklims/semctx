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
  const nodes = raw.map(node => ({ ...node, pos: node.start, text: text.slice(node.start, node.end), parent: node.parent === null ? null : reference(node.parent), children: node.children.map(reference), fields: Object.fromEntries(Object.entries(node.fields).map(([field, value]) => [field, value === null ? null : Array.isArray(value) ? value.map(reference) : reference(value)])), ...(node.id === "cn" ? { symbol: { name: "target", flagsBits: 16, declarations: [{ ...reference("t"), path: "/project/main.ts" }] } } : {}) }));
  const native = { compilerConstants: { symbolFlags: { Alias: 2097152 } }, files: [{ path: "/project/main.ts", text, isDeclarationFile: false, nodes }] };
  const projected = projectContractOwnership(native, "main.ts", { "main.ts": text });
  expect(projected.status).toBe("projected");
  expect(compareContractOwnership(actual(), projected)).toBe(true);
});

type DeclarationFixture = { name: string; body: boolean };
const declarationFacts = (declarations: DeclarationFixture[], filePath = "main.ts") => {
  const statements: { id: string; kind: string; start: number; end: number; parent: string | null; children: string[]; fields: Record<string, string | string[] | null>; literalText?: string; symbol?: unknown }[] = [];
  let text = "";
  for (const [index, declaration] of declarations.entries()) {
    const start = text.length, id = `declaration-${index}`, name = `${id}-name`, body = `${id}-body`;
    text += `function ${declaration.name}()${declaration.body ? "{}" : ": void;"}\n`;
    statements.push({ id, kind: "FunctionDeclaration", start, end: text.length - 1, parent: "source", children: [name, ...(declaration.body ? [body] : [])], fields: { name, body: declaration.body ? body : null } });
    statements.push({ id: name, kind: "Identifier", start: start + 9, end: start + 9 + declaration.name.length, parent: id, children: [], fields: {}, literalText: declaration.name });
    if (declaration.body) statements.push({ id: body, kind: "Block", start: text.length - 3, end: text.length - 1, parent: id, children: [], fields: { statements: [] } });
  }
  const callStart = text.length, target = declarations[0]!.name;
  text += `${target}();`;
  statements.push({ id: "statement", kind: "ExpressionStatement", start: callStart, end: text.length, parent: "source", children: ["call"], fields: { expression: "call" } });
  statements.push({ id: "call", kind: "CallExpression", start: callStart, end: text.length - 1, parent: "statement", children: ["callee"], fields: { expression: "callee", arguments: [] } });
  statements.push({ id: "callee", kind: "Identifier", start: callStart, end: callStart + target.length, parent: "call", children: [], fields: {}, literalText: target });
  const roots = statements.filter(node => node.parent === "source").map(node => node.id);
  statements.unshift({ id: "source", kind: "SourceFile", start: 0, end: text.length, parent: null, children: roots, fields: { statements: roots } });
  const reference = (id: string) => { const node = statements.find(node => node.id === id)!; return { kind: node.kind, start: node.start, end: node.end }; };
  const nodes = statements.map(node => ({ ...node, pos: node.start, text: text.slice(node.start, node.end), parent: node.parent === null ? null : reference(node.parent), children: node.children.map(reference), fields: Object.fromEntries(Object.entries(node.fields).map(([field, value]) => [field, value === null ? null : Array.isArray(value) ? value.map(reference) : reference(value)])), ...(node.id === "callee" ? { symbol: { name: target, flagsBits: 16, declarations: declarations.map((_, index) => ({ ...reference(`declaration-${index}`), path: `/project/${filePath}` })) } } : {}) }));
  return { text, oracle: { compilerConstants: { symbolFlags: { Alias: 2097152 } }, files: [{ path: `/project/${filePath}`, text, isDeclarationFile: false, nodes }] } };
};

test("overload signatures share one retained coordinate with their sole implementation", () => {
  const { text, oracle } = declarationFacts([{ name: "target", body: false }, { name: "target", body: true }]);
  const projection = projectContractOwnership(oracle, "main.ts", { "main.ts": text });
  expect(projection).toMatchObject({ status: "projected", gaps: [] });
  if (projection.status !== "projected") throw Error(projection.gaps.join(","));
  expect(projection.proof.graph.nodes.map(node => [node.kind, node.name])).toEqual([["module", "main.ts"], ["function", "target"]]);
  expect(projection.proof.graph.edges).toEqual([{ kind: "calls", from: projection.proof.graph.nodes[0]!.id, to: projection.proof.graph.nodes[1]!.id, evidence: [{ filePath: "main.ts", startLine: 3 }] }]);
});

test("signature-only declarations fold into one callable graph coordinate", () => {
  const { text, oracle } = declarationFacts([{ name: "target", body: false }, { name: "target", body: false }]);
  const projection = projectContractOwnership(oracle, "main.ts", { "main.ts": text });
  expect(projection).toMatchObject({ status: "projected", gaps: [] });
  if (projection.status !== "projected") throw Error(projection.gaps.join(","));
  expect(projection.proof.graph.nodes.filter(node => node.kind === "function")).toHaveLength(1);
  expect(projection.proof.graph.edges).toHaveLength(1);
});

test("multiple implementations retain separate identities and no call to their ambiguous coordinate", () => {
  const { text, oracle } = declarationFacts([{ name: "target", body: true }, { name: "target", body: true }]);
  const projection = projectContractOwnership(oracle, "main.ts", { "main.ts": text });
  expect(projection).toMatchObject({ status: "projected", gaps: [] });
  if (projection.status !== "projected") throw Error(projection.gaps.join(","));
  const functions = projection.proof.graph.nodes.filter(node => node.kind === "function");
  expect(functions.map(node => node.name)).toEqual(["target", "target"]);
  expect(new Set(functions.map(node => node.id)).size).toBe(2);
  expect(projection.proof.graph.edges).toEqual([]);
});

const anonymousFacts = (kind: "FunctionDeclaration" | "ClassDeclaration", modifierFlagsBits: number) => {
  const text = kind === "FunctionDeclaration" ? "export default function() {}" : "export default class {}";
  const declaration = { kind, start: 0, end: text.length };
  const source = { kind: "SourceFile", start: 0, end: text.length };
  const block = { kind: "Block", start: text.length - 2, end: text.length };
  const nodes = [
    { ...source, pos: 0, text, parent: null, children: [declaration], fields: { statements: [declaration] } },
    { ...declaration, pos: 0, text, modifierFlagsBits, parent: source, children: kind === "FunctionDeclaration" ? [block] : [], fields: { name: null, body: kind === "FunctionDeclaration" ? block : null } },
    ...(kind === "FunctionDeclaration" ? [{ ...block, pos: block.start, text: "{}", parent: declaration, children: [], fields: { statements: [] } }] : []),
  ];
  return { text, oracle: { compilerConstants: { modifierFlags: { Default: 2048 }, symbolFlags: { Alias: 2097152 } }, files: [{ path: "/project/main.ts", text, isDeclarationFile: false, nodes }] } };
};

test("anonymous default function and class declarations retain the native default coordinate", () => {
  for (const kind of ["FunctionDeclaration", "ClassDeclaration"] as const) {
    const { text, oracle } = anonymousFacts(kind, 2048);
    const projection = projectContractOwnership(oracle, "main.ts", { "main.ts": text });
    expect(projection).toMatchObject({ status: "projected", gaps: [] });
    if (projection.status !== "projected") throw Error(projection.gaps.join(","));
    expect(projection.proof.graph.nodes.map(node => [node.kind, node.name])).toEqual([["module", "main.ts"], [kind === "FunctionDeclaration" ? "function" : "class", "default"]]);
  }
});

test("nested modules keep their full path and their basename as graph name", () => {
  const { text, oracle } = declarationFacts([{ name: "target", body: true }], "src/main.ts");
  const projection = projectContractOwnership(oracle, "src/main.ts", { "src/main.ts": text });
  expect(projection).toMatchObject({ status: "projected", gaps: [] });
  if (projection.status !== "projected") throw Error(projection.gaps.join(","));
  expect(projection.proof.graph.nodes[0]).toMatchObject({ kind: "module", name: "main.ts", filePath: "src/main.ts" });
});

test("anonymous names require native modifier evidence rather than source text", () => {
  const unmarked = anonymousFacts("FunctionDeclaration", 0);
  const projected = projectContractOwnership(unmarked.oracle, "main.ts", { "main.ts": unmarked.text });
  expect(projected).toMatchObject({ status: "projected", gaps: [] });
  if (projected.status !== "projected") throw Error(projected.gaps.join(","));
  expect(projected.proof.graph.nodes.map(node => node.kind)).toEqual(["module"]);
  const missing = anonymousFacts("FunctionDeclaration", 2048);
  Reflect.deleteProperty(missing.oracle.files[0]!.nodes[1]!, "modifierFlagsBits");
  const refused = projectContractOwnership(missing.oracle, "main.ts", { "main.ts": missing.text });
  expect(refused.status).toBe("unsupported");
});
