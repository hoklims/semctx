import { expect, test } from "bun:test";
import { verifyContractWitness } from "./t00-ts7-q-semantic-contract-witnesses";
import { helperResult, witness } from "./t00-ts7-q-semantic-contract-witness-types";

const node = (text: string) => ({ kind: "node", syntaxKind: "Identifier", text, start: 0, end: text.length, path: "/project/main.ts" });
const oracle = { files: [{ path: "/project/main.ts", nodes: [{ kind: "Identifier", text: "alias", start: 0, end: 5 }] }] };
const scenario = witness(51, "const-alias", "const alias=target;alias();", "let alias=target;alias();", ["const-followed", "let-retained"], [
  helperResult(51, "activate", "alias", { kind: "node", syntaxKind: "Identifier", text: "target" }, ["const-followed"]),
  helperResult(51, "control", "alias", { kind: "node", syntaxKind: "Identifier", text: "alias" }, ["let-retained"]),
]);
const projected = (argument: string, value: unknown) => ({ status: "projected", gaps: [], helperResults: [{ index: 51, arguments: [node(argument)], value }] });

test("matches a helper return at its observed input rather than a scenario label", () => {
  expect(verifyContractWitness(oracle, projected("alias", node("target")), scenario, "activate", "main.ts")).toEqual({ passed: true, gaps: [] });
  expect(verifyContractWitness(oracle, projected("alias", node("alias")), scenario, "control", "main.ts")).toEqual({ passed: true, gaps: [] });
});

test("declared alternatives without executable native assertions cannot pass", () => {
  const native = projected("alias", node("target"));
  expect(verifyContractWitness(oracle, native, { ...scenario, nativeExpectations: [] }, "activate", "main.ts").passed).toBe(false);
  expect(verifyContractWitness(oracle, native, { ...scenario, requiredAlternatives: [...scenario.requiredAlternatives, "missing-cycle"] }, "activate", "main.ts").passed).toBe(false);
  expect(verifyContractWitness(oracle, native, { ...scenario, nativeExpectations: scenario.nativeExpectations.filter(expectation => expectation.variant === "control") }, "activate", "main.ts").passed).toBe(false);
});

test("rejects the expected return observed on another argument or consumer", () => {
  expect(verifyContractWitness(oracle, projected("unrelated", node("target")), scenario, "activate", "main.ts").passed).toBe(false);
  const other = projected("alias", node("target"));
  other.helperResults[0]!.index = 62;
  expect(verifyContractWitness(oracle, other, scenario, "activate", "main.ts").passed).toBe(false);
  const foreign = projected("alias", node("target"));
  foreign.helperResults[0]!.arguments[0]!.path = "/project/other.ts";
  expect(verifyContractWitness(oracle, foreign, scenario, "activate", "main.ts").passed).toBe(false);
  expect(verifyContractWitness(oracle, projected("alias", node("target")), scenario, "control", "main.ts").passed).toBe(false);
});

test("refuses missing or unsupported execution even when labels and expected values are supplied", () => {
  expect(verifyContractWitness(oracle, { ...projected("alias", node("target")), status: "unsupported" }, scenario, "activate", "main.ts").passed).toBe(false);
  expect(verifyContractWitness(oracle, { status: "projected", gaps: [], helperResults: [] }, scenario, "activate", "main.ts").passed).toBe(false);
  expect(verifyContractWitness({ files: [] }, projected("alias", node("target")), scenario, "activate", "main.ts").passed).toBe(false);
});

test("does not turn absent declarations into an observed empty array", () => {
  const empty = witness(64, "missing", "missing();", "known();", ["missing-symbol"], [helperResult(64, "activate", "missing", { kind: "declarations", syntaxKinds: [] }, ["missing-symbol"])]);
  const projection = { status: "projected", gaps: [], helperResults: [{ index: 64, arguments: [node("missing")], value: { kind: "undefined" } as unknown }] };
  expect(verifyContractWitness(oracle, projection, empty, "activate", "main.ts").passed).toBe(false);
  projection.helperResults[0]!.value = { kind: "array", values: [] };
  expect(verifyContractWitness(oracle, projection, empty, "activate", "main.ts").passed).toBe(true);
});

test("requires an actual syntax match at the selected native file", () => {
  const selected = { ...scenario, requiredAlternatives: ["identifier"], nativeExpectations: [{ kind: "syntax" as const, variant: "activate" as const, syntaxKind: "Identifier", text: "alias", minimumCount: 1, alternatives: ["identifier"] }] };
  expect(verifyContractWitness(oracle, projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(true);
  expect(verifyContractWitness({ files: [{ path: "/project/main.ts", nodes: [{ kind: "StringLiteral", text: "alias" }] }] }, projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(false);
});

test("does not call mixed or missing declaration origins SDK provenance", () => {
  const selected = { ...scenario, requiredAlternatives: ["sdk-origin"], nativeExpectations: [{ kind: "symbol-origin" as const, variant: "activate" as const, nodeText: "alias", origin: "default-library" as const, alternatives: ["sdk-origin"] }] };
  const native = (origins: unknown[]) => ({ files: [{ path: "/project/main.ts", nodes: [{ kind: "Identifier", text: "alias", symbol: { declarations: origins } }] }] });
  expect(verifyContractWitness(native([{ defaultLibrary: true }]), projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(true);
  expect(verifyContractWitness(native([{ defaultLibrary: true }, { defaultLibrary: false }]), projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(false);
  expect(verifyContractWitness(native([]), projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(false);
  const ambiguous = native([{ defaultLibrary: true }]);
  ambiguous.files[0]!.nodes.push({ kind: "Identifier", text: "alias", symbol: { declarations: [{ defaultLibrary: false }] } });
  expect(verifyContractWitness(ambiguous, projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(false);
});

test("distinguishes observed noncallability from missing type signature facts", () => {
  const selected = { ...scenario, requiredAlternatives: ["noncallable"], nativeExpectations: [{ kind: "type" as const, variant: "activate" as const, nodeText: "alias", callable: false, constructible: false, alternatives: ["noncallable"] }] };
  const native = (type: unknown) => ({ files: [{ path: "/project/main.ts", nodes: [{ kind: "Identifier", text: "alias", type }] }] });
  expect(verifyContractWitness(native({ callSignatures: [], constructSignatures: [] }), projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(true);
  expect(verifyContractWitness(native({ text: "Function" }), projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(false);
  expect(verifyContractWitness(native({ callSignatureCount: 0, constructSignatureCount: 1 }), projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(false);
});

test("binds secondary source assertions and declaration results to their native file", () => {
  const selected = { ...scenario, requiredAlternatives: ["reexport"], nativeExpectations: [{ kind: "syntax" as const, variant: "activate" as const, syntaxKind: "ExportSpecifier", text: "target as alias", minimumCount: 1, alternatives: ["reexport"], sourcePath: "bridge.ts" }] };
  const bridge = { path: "/project/bridge.ts", nodes: [{ kind: "ExportSpecifier", text: "target as alias", start: 0, end: 15 }] };
  expect(verifyContractWitness({ files: [...oracle.files, bridge] }, projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(true);
  expect(verifyContractWitness(oracle, projected("alias", node("target")), selected, "activate", "main.ts").passed).toBe(false);
  const declarationWitness = { ...scenario, nativeExpectations: [helperResult(51, "activate", "alias", { kind: "declarations", syntaxKinds: ["FunctionDeclaration"], declarationPaths: ["/project/target.ts"] }, scenario.requiredAlternatives)] };
  const wrong = projected("alias", { kind: "array", values: [{ kind: "node", syntaxKind: "FunctionDeclaration", path: "/project/main.ts" }] });
  expect(verifyContractWitness(oracle, wrong, declarationWitness, "activate", "main.ts").passed).toBe(false);
});

test("SDK helper arguments require the declared origin path", () => {
  const selected = { ...scenario, nativeExpectations: [helperResult(51, "activate", "Date", { kind: "boolean", value: false }, scenario.requiredAlternatives, "/sdk/lib/lib.es5.d.ts")] };
  const result = projected("Date", { kind: "boolean", value: false });
  expect(verifyContractWitness(oracle, result, selected, "activate", "main.ts").passed).toBe(false);
  result.helperResults[0]!.arguments[0]!.path = "/sdk/lib/lib.es5.d.ts";
  expect(verifyContractWitness(oracle, result, selected, "activate", "main.ts").passed).toBe(true);
});

test("binds a type helper argument to one native node, kind and byte span", () => {
  const native = { compilerConstants: { typeFlags: { Object: 64, StringLike: 32 } }, files: [{ path: "/project/main.ts", nodes: [
    { kind: "Identifier", text: "f", start: 0, end: 1, typeId: "function" },
    { kind: "BindingElement", text: "f", start: 4, end: 5 },
    { kind: "Identifier", text: "f", start: 10, end: 11, typeId: "string" },
  ], factsGraph: { types: [
    { id: "function", flagsBits: 64, callSignatures: ["signature"], constructSignatures: [], unionTypes: [], intersectionTypes: [] },
    { id: "string", flagsBits: 32, callSignatures: [], constructSignatures: [], unionTypes: [], intersectionTypes: [] },
  ] } }] };
  const selected = witness(99, "type-binding", "f", "f", ["callable"], [helperResult(99, "activate", {
    kind: "type", native: { nodeText: "f", syntaxKind: "Identifier", nativeByteStart: 0, target: "type" }, callable: true,
  }, { kind: "boolean", value: true }, ["callable"])]);
  const actual = { status: "projected", gaps: [], helperResults: [{ index: 99, arguments: [{ kind: "type", nativeId: "function", checkerFile: "/project/main.ts", callSignatureCount: 1 }], value: { kind: "boolean", value: true } }] };
  expect(verifyContractWitness(native, actual, selected, "activate", "main.ts").passed).toBe(true);
  const wrongType = structuredClone(actual); wrongType.helperResults[0]!.arguments[0]!.nativeId = "string";
  expect(verifyContractWitness(native, wrongType, selected, "activate", "main.ts").passed).toBe(false);
  const wrongChecker = structuredClone(actual); wrongChecker.helperResults[0]!.arguments[0]!.checkerFile = "/project/other.ts";
  expect(verifyContractWitness(native, wrongChecker, selected, "activate", "main.ts").passed).toBe(false);
  const ambiguous = structuredClone(selected);
  const assertion = ambiguous.nativeExpectations[0]!;
  if (assertion.kind === "helper-return" && assertion.argument?.kind === "type") delete assertion.argument.native!.nativeByteStart;
  expect(verifyContractWitness(native, actual, ambiguous, "activate", "main.ts").passed).toBe(false);
  const sameType = structuredClone(native); sameType.files[0]!.nodes[2]!.typeId = "function";
  expect(verifyContractWitness(sameType, actual, ambiguous, "activate", "main.ts").passed).toBe(true);
});

test("uses positional argument constraints and ordered record contents in the same invocation", () => {
  const selected = witness(120, "operation-args", "alias", "alias", ["names"], [{
    ...helperResult(120, "activate", "alias", { kind: "object", properties: { arguments: { kind: "array", values: [{ kind: "string", value: "first" }, { kind: "undefined" }] } } }, ["names"]),
    argumentConstraints: [{ position: 1, expected: { kind: "array", values: [{ kind: "string", value: "create" }] } }],
  }]);
  const value = { kind: "object", properties: { arguments: { kind: "array", values: [{ kind: "string", value: "first" }, { kind: "undefined" }] } } };
  const actual = { status: "projected", gaps: [], helperResults: [{ index: 120, arguments: [node("alias"), { kind: "array", values: [{ kind: "string", value: "create" }] }], value }] };
  expect(verifyContractWitness(oracle, actual, selected, "activate", "main.ts").passed).toBe(true);
  const wrong = structuredClone(actual); wrong.helperResults[0]!.arguments[1] = { kind: "array", values: [{ kind: "string", value: "setPrototypeOf" }] };
  expect(verifyContractWitness(oracle, wrong, selected, "activate", "main.ts").passed).toBe(false);
  const reversed = structuredClone(actual); reversed.helperResults[0]!.value.properties.arguments.values.reverse();
  expect(verifyContractWitness(oracle, reversed, selected, "activate", "main.ts").passed).toBe(false);
});

test("rehydrates omitted node text from native sources and respects UTF16 argument positions", () => {
  const selected = { ...scenario, nativeExpectations: scenario.nativeExpectations.map((entry, index) => index === 0 ? { ...entry, argumentStart: 1 } : entry) };
  const native = { ...oracle, sourceFiles: [{ path: "/project/main.ts", text: "éalias;target" }] };
  const argument = { kind: "node", syntaxKind: "Identifier", path: "/project/main.ts", start: 1, end: 6, nativeByteStart: 2, nativeByteEnd: 7 };
  const value = { kind: "node", syntaxKind: "Identifier", path: "/project/main.ts", start: 7, end: 13, nativeByteStart: 8, nativeByteEnd: 14 };
  const actual = { status: "projected", gaps: [], helperResults: [{ index: 51, arguments: [argument], value }] };
  expect(verifyContractWitness(native, actual, selected, "activate", "main.ts").passed).toBe(true);
  const wrong = structuredClone(actual); wrong.helperResults[0]!.arguments[0]!.start = 2;
  expect(verifyContractWitness(native, wrong, selected, "activate", "main.ts").passed).toBe(false);
});

test("binds SDK parameter type identities through the selected signature and position", () => {
  const declaration = { path: "/sdk/lib/lib.d.ts", kind: "CallSignature", start: 10, end: 20 };
  const native = { files: [{ path: "/project/main.ts", nodes: [{ kind: "Identifier", text: "consume", start: 0, end: 7, typeId: "callee" }], factsGraph: {
    types: [{ id: "callee", callSignatures: ["signature"] }, { id: "callback", callSignatures: ["callback-signature"] }, { id: "number", callSignatures: [] }],
    signatures: [{ id: "signature", declaration, parameters: ["first", "second"] }],
    symbols: [{ id: "first", name: "value", declarations: [] }, { id: "second", name: "value", declarations: [] }],
    symbolTypes: [{ symbolId: "first", location: declaration, typeId: "callback" }, { symbolId: "second", location: declaration, typeId: "number" }],
  } }] };
  const selected = witness(59, "parameter", "consume", "consume", ["callback"], [helperResult(59, "activate", {
    kind: "type", callable: true, native: { nodeText: "consume", syntaxKind: "Identifier", target: "type", steps: [{ op: "callSignature", index: 0 }, { op: "parameter", index: 0 }, { op: "symbolType", location: "signatureDeclaration" }] },
  }, { kind: "boolean", value: true }, ["callback"])]);
  const actual = { status: "projected", gaps: [], helperResults: [{ index: 59, arguments: [{ kind: "type", nativeId: "callback", checkerFile: "/project/main.ts", callSignatureCount: 1 }], value: { kind: "boolean", value: true } }] };
  expect(verifyContractWitness(native, actual, selected, "activate", "main.ts").passed).toBe(true);
  const changed = structuredClone(selected);
  const expectation = changed.nativeExpectations[0];
  if (expectation?.kind === "helper-return" && expectation.argument?.kind === "type") expectation.argument.native!.steps![1] = { op: "parameter", index: 1 };
  expect(verifyContractWitness(native, actual, changed, "activate", "main.ts").passed).toBe(false);
});

test("distinguishes shorthand value symbols from homonymous property symbols", () => {
  const native = { files: [{ path: "/project/main.ts", nodes: [{ kind: "ShorthandPropertyAssignment", text: "value", start: 0, end: 5, symbolId: "property", shorthandValueSymbolId: "binding" }], factsGraph: {
    symbols: [{ id: "property", name: "value", declarations: [] }, { id: "binding", name: "value", declarations: [] }],
  } }] };
  const selected = witness(56, "symbol", "value", "value", ["binding"], [helperResult(56, "activate", { kind: "symbol", name: "value", native: { nodeText: "value", syntaxKind: "ShorthandPropertyAssignment", target: "shorthandValueSymbol" } }, { kind: "boolean", value: false }, ["binding"])]);
  const actual = { status: "projected", gaps: [], helperResults: [{ index: 56, arguments: [{ kind: "symbol", name: "value", nativeId: "binding", checkerFile: "/project/main.ts" }], value: { kind: "boolean", value: false } }] };
  expect(verifyContractWitness(native, actual, selected, "activate", "main.ts").passed).toBe(true);
  actual.helperResults[0]!.arguments[0]!.nativeId = "property";
  expect(verifyContractWitness(native, actual, selected, "activate", "main.ts").passed).toBe(false);
});

test.each([["TypeLiteral", true], ["InterfaceDeclaration", false]] as const)("requires the observed %s parent before crediting absence of descendant visits", (syntaxKind, isTypeNode) => {
  const native = { files: [{ path: "/project/main.ts", nodes: [{ kind: syntaxKind, text: "{value:number}", start: 0, end: 14, isTypeNode }] }] };
  const selected = witness(134, "type-boundary", "{value:number}", "", ["type-not-visited"], [{ kind: "helper-descendants-absent", variant: "activate", consumerIndex: 134, parent: { nodeText: "{value:number}", syntaxKind, nativeByteStart: 0 }, alternatives: ["type-not-visited"] }]);
  const parent = { kind: "node", syntaxKind: syntaxKind as string, path: "/project/main.ts", start: 0, end: 14, nativeByteStart: 0, nativeByteEnd: 14 };
  const actual = { status: "projected", gaps: [], helperResults: [{ index: 134, arguments: [parent], value: { kind: "undefined" } }] };
  expect(verifyContractWitness(native, actual, selected, "activate", "main.ts").passed).toBe(true);
  const child = { ...parent, syntaxKind: "Identifier", start: 1, end: 6, nativeByteStart: 1, nativeByteEnd: 6 };
  actual.helperResults.push({ index: 134, arguments: [child], value: { kind: "undefined" } });
  expect(verifyContractWitness(native, actual, selected, "activate", "main.ts").passed).toBe(false);
  expect(verifyContractWitness(native, { ...actual, helperResults: actual.helperResults.slice(1) }, selected, "activate", "main.ts").passed).toBe(false);
});
