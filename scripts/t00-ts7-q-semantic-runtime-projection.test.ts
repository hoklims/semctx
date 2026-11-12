import { expect, test } from "bun:test";
import { projectRuntimeReasons } from "./t00-ts7-q-semantic-runtime-projection";

const reference = (kind: string, start: number, end: number) => ({ kind, start, end });
type FixtureNode = ReturnType<typeof reference> & {
  fields: Record<string, unknown>;
  text?: string;
  flagsBits?: number;
  type?: Record<string, unknown>;
  symbol?: Record<string, unknown>;
  signature?: Record<string, unknown>;
};
type FixtureOracle = { files: { path: string; nodes: FixtureNode[] }[] };
const sdk = { kind: "MethodSignature", path: "/sdk/lib/lib.dom.d.ts", start: 100, end: 120, defaultLibrary: true };
const stringType = { flagsBits: 32, callSignatures: [], constructSignatures: [], unionTypes: [], intersectionTypes: [] };

function resolveFacts(): FixtureOracle {
  const source = reference("SourceFile", 0, 30);
  const statement = reference("ExpressionStatement", 0, 30);
  const call = reference("CallExpression", 0, 29);
  const access = reference("PropertyAccessExpression", 0, 19);
  const meta = reference("MetaProperty", 0, 11);
  const name = reference("Identifier", 12, 19);
  const argument = reference("StringLiteral", 20, 28);
  const signature = { declaration: sdk, parameters: [{ type: stringType }] };
  return { files: [{ path: "/project/main.ts", nodes: [
    { ...source, fields: { statements: [statement] } },
    { ...statement, fields: { expression: call } },
    { ...call, fields: { expression: access, arguments: [argument] }, signature, type: stringType },
    { ...access, fields: { expression: meta, name }, type: { flagsBits: 1048576, callSignatures: [signature], constructSignatures: [], unionTypes: [], intersectionTypes: [] } },
    { ...meta, text: "import.meta", fields: {} },
    { ...name, text: "resolve", fields: {} },
    { ...argument, text: '"sample"', fields: {}, type: stringType },
  ] }] };
}

test("projects callable import.meta use from native call signatures", () => {
  expect(projectRuntimeReasons(resolveFacts(), "main.ts").reasons).toEqual(["SOURCE_IMPORT_META_CALLABLE_UNSUPPORTED"]);
});

test("does not credit absent structural facts or an unmodeled statement", () => {
  expect(projectRuntimeReasons({ files: [] }, "main.ts").reasons).toBeNull();
  const oracle = resolveFacts();
  (oracle.files[0]!.nodes[0]!.fields["statements"] as ReturnType<typeof reference>[]).push(reference("UnknownStatement", 30, 40));
  expect(projectRuntimeReasons(oracle, "main.ts").reasons).toBeNull();
});

test("does not infer a call signature from the property name", () => {
  const oracle = resolveFacts();
  const access = oracle.files[0]!.nodes.find(node => node.kind === "PropertyAccessExpression")!;
  access.type = stringType;
  expect(projectRuntimeReasons(oracle, "main.ts").reasons).toBeNull();
});

function stringAliasFacts(): FixtureOracle {
  const source = reference("SourceFile", 0, 38);
  const variableStatement = reference("VariableStatement", 0, 26);
  const list = reference("VariableDeclarationList", 0, 25);
  const declaration = reference("VariableDeclaration", 6, 25);
  const alias = reference("Identifier", 6, 9);
  const access = reference("PropertyAccessExpression", 10, 25);
  const meta = reference("MetaProperty", 10, 21);
  const name = reference("Identifier", 22, 25);
  const statement = reference("ExpressionStatement", 26, 38);
  const call = reference("CallExpression", 26, 37);
  const callee = reference("Identifier", 26, 32);
  const argument = reference("Identifier", 33, 36);
  const signature = { declaration: sdk, parameters: [{ type: { flagsBits: 1 } }] };
  return { files: [{ path: "/project/main.ts", nodes: [
    { ...source, fields: { statements: [variableStatement, statement] } },
    { ...variableStatement, fields: { declarationList: list, modifiers: [] } },
    { ...list, flagsBits: 2, fields: { declarations: [declaration] } },
    { ...declaration, fields: { name: alias, initializer: access } },
    { ...alias, text: "url", fields: {} },
    { ...access, fields: { expression: meta, name }, symbol: { name: "url", declarations: [{ ...sdk, kind: "PropertySignature" }] }, type: stringType },
    { ...meta, text: "import.meta", fields: {} },
    { ...name, text: "url", fields: {} },
    { ...statement, fields: { expression: call } },
    { ...call, fields: { expression: callee, arguments: [argument] }, signature, type: stringType },
    { ...callee, text: "String", fields: {}, symbol: { name: "String", declarations: [sdk] }, type: { flagsBits: 1048576, callSignatures: [signature] } },
    { ...argument, text: "url", fields: {}, symbol: { name: "url", declarations: [{ ...declaration, path: "/project/main.ts", defaultLibrary: false }] }, type: stringType },
  ] }] };
}

test("String of an import.meta.url const alias is not primitiveValue", () => {
  expect(projectRuntimeReasons(stringAliasFacts(), "main.ts").reasons).toEqual(["SOURCE_COERCION_UNSUPPORTED"]);
});

test("does not give SDK String provenance to a shadowed constructor", () => {
  const oracle = stringAliasFacts();
  const callee = oracle.files[0]!.nodes.find(node => node.text === "String")!;
  callee.symbol = { name: "String", declarations: [{ ...sdk, defaultLibrary: false }] };
  expect(projectRuntimeReasons(oracle, "main.ts").reasons).toBeNull();
});

function constructorFacts(): FixtureOracle {
  const source = reference("SourceFile", 0, 43);
  const owner = reference("FunctionDeclaration", 0, 14);
  const ownerName = reference("Identifier", 9, 10);
  const body = reference("Block", 12, 14);
  const statement = reference("VariableStatement", 15, 43);
  const list = reference("VariableDeclarationList", 22, 43);
  const declaration = reference("VariableDeclaration", 28, 43);
  const name = reference("Identifier", 28, 29);
  const access = reference("PropertyAccessExpression", 30, 43);
  const receiver = reference("Identifier", 30, 31);
  const member = reference("Identifier", 32, 43);
  const exported = reference("ExportKeyword", 15, 21);
  const functionType = { flagsBits: 1048576, callSignatures: [], constructSignatures: [], unionTypes: [], intersectionTypes: [] };
  return { files: [{ path: "/project/main.ts", nodes: [
    { ...source, fields: { statements: [owner, statement] } },
    { ...owner, fields: { name: ownerName, body, parameters: [], modifiers: [] } },
    { ...ownerName, text: "f", fields: {} },
    { ...body, fields: { statements: [] } },
    { ...statement, fields: { declarationList: list, modifiers: [exported] } },
    { ...exported, fields: {} },
    { ...list, flagsBits: 2, fields: { declarations: [declaration] } },
    { ...declaration, fields: { name, initializer: access } },
    { ...name, text: "x", fields: {}, type: functionType },
    { ...access, fields: { expression: receiver, name: member }, type: functionType, symbol: { name: "constructor", declarations: [{ ...sdk, kind: "PropertySignature", parentKind: "InterfaceDeclaration", parentName: "Object" }] } },
    { ...receiver, text: "f", fields: {}, symbol: { name: "f", declarations: [{ ...owner, path: "/project/main.ts" }] }, type: { ...functionType, callSignatures: [{ declaration: owner }] } },
    { ...member, text: "constructor", fields: {} },
  ] }] };
}

test("Function type name without call or construct signatures is not a callable export", () => {
  expect(projectRuntimeReasons(constructorFacts(), "main.ts").reasons).toEqual(["SOURCE_DYNAMIC_EVALUATION_UNSUPPORTED"]);
});

test("requires construct signatures before excluding callable exports", () => {
  const oracle = constructorFacts();
  const name = oracle.files[0]!.nodes.find(node => node.text === "x")!;
  delete (name.type as Record<string, unknown>)["constructSignatures"];
  expect(projectRuntimeReasons(oracle, "main.ts").reasons).toBeNull();
});

test("does not treat absent body observations as an empty body", () => {
  const oracle = constructorFacts();
  const body = oracle.files[0]!.nodes.find(node => node.kind === "Block")!;
  delete (body.fields as Record<string, unknown>)["statements"];
  expect(projectRuntimeReasons(oracle, "main.ts").reasons).toBeNull();
});

test("does not ignore unobserved leading trivia or generator syntax", () => {
  const oracle = constructorFacts();
  oracle.files[0]!.nodes[0]!.start = 20;
  expect(projectRuntimeReasons(oracle, "main.ts").reasons).toBeNull();
  const generator = constructorFacts();
  generator.files[0]!.nodes.push({ ...reference("AsteriskToken", 8, 9), fields: {} });
  expect(projectRuntimeReasons(generator, "main.ts").reasons).toBeNull();
});
