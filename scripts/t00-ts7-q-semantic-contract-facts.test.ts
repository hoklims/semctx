import { describe, expect, test } from "bun:test";
import { createContractFacts, NativeFactsRequired } from "./t00-ts7-q-semantic-contract-facts";

describe("native contract facts", () => {
  test("keeps long source text outside descriptors without replacing it by a truncated string", () => {
    const text = "a".repeat(2048);
    const facts = createContractFacts({ files: [{ path: "/project/main.ts", text, nodes: [{ kind: "SourceFile", start: 0, end: text.length, text, parent: null, fields: {}, children: [] }] }] }, "main.ts", { "main.ts": text });
    expect(facts.describe(facts.source)).not.toHaveProperty("text");
    expect(facts.describe(facts.source)).toMatchObject({ kind: "node", path: "/project/main.ts", start: 0, end: 2048, byteLength: 2048 });
    expect(facts.source["text"]).toBe(text);
  });
  test("describes native type shape and symbol declarations without losing their checker provenance", () => {
    const anchor = { path: "/project/main.ts", kind: "SourceFile", start: 0, end: 6 };
    const route = { anchor, steps: [{ op: "type" }] };
    const declaration = { path: anchor.path, kind: "Parameter", start: 2, end: 3, fields: { dotDotDotToken: null } };
    const native = { compilerConstants: { typeFlags: { Union: 64, StringLike: 32, NumberLike: 16 } }, files: [{ path: anchor.path, text: "éa;b;", defaultLibrary: false, nodes: [{ ...anchor, typeId: "union", symbolId: "symbol", text: "éa;b;" }], factsGraph: {
      types: [{ id: "union", route, text: "number | string", flagsBits: 64, callSignatures: [], constructSignatures: ["ctor"], unionTypes: ["number", "string"], intersectionTypes: [], baseConstraint: null }, { id: "number", text: "number", flagsBits: 16 }, { id: "string", text: "string", flagsBits: 32 }],
      symbols: [{ id: "symbol", route: { anchor, steps: [{ op: "symbol" }] }, name: "value", flagsBits: 2, declarations: [declaration] }],
    } }] };
    const facts = createContractFacts(native, "main.ts", { "main.ts": "éa;b;" });
    const type = facts.describe(facts.checker["getTypeAtLocation"]!(facts.source));
    expect(type).toMatchObject({ kind: "type", nativeId: "union", checkerFile: anchor.path, route, flagsNames: ["Union"], callSignatureCount: 0, constructSignatureCount: 1, baseConstraintPresent: false, unionTypes: [{ flagsNames: ["NumberLike"] }, { flagsNames: ["StringLike"] }], intersectionTypes: [] });
    const symbol = facts.describe(facts.checker["getSymbolAtLocation"]!(facts.source));
    expect(symbol).toMatchObject({ kind: "symbol", nativeId: "symbol", checkerFile: anchor.path, name: "value", declarations: [{ kind: "node", syntaxKind: "Parameter", path: anchor.path, start: 1, end: 2, nativeByteStart: 2, nativeByteEnd: 3, defaultLibrary: false, rest: false }] });
    const changed = structuredClone(native);
    changed.files[0]!.nodes[0]!.typeId = "string";
    changed.files[0]!.factsGraph.symbols[0]!.declarations[0]!.start = 4;
    changed.files[0]!.factsGraph.symbols[0]!.declarations[0]!.end = 5;
    changed.files[0]!.factsGraph.symbols[0]!.route.anchor = { ...anchor, start: 4 };
    const changedFacts = createContractFacts(changed, "main.ts", { "main.ts": "éa;b;" });
    expect(changedFacts.describe(changedFacts.checker["getTypeAtLocation"]!(changedFacts.source))).toMatchObject({ nativeId: "string", flagsNames: ["StringLike"] });
    const homonym = changedFacts.describe(changedFacts.checker["getSymbolAtLocation"]!(changedFacts.source));
    expect(homonym).not.toEqual(symbol);
    expect(homonym).toMatchObject({ name: "value", declarations: [{ start: 3, end: 4 }], route: { anchor: { start: 4 } } });
  });
  test("preserves record properties and array positions without executing getters", () => {
    const facts = createContractFacts({ files: [{ path: "/project/main.ts", nodes: [{ kind: "SourceFile", start: 0, end: 0, text: "" }] }] }, "main.ts", { "main.ts": "" });
    let reads = 0;
    const value = { callee: facts.source, arguments: ["first", undefined, "third"], get receiver() { reads++; return "forbidden"; } };
    expect(facts.describe(value)).toMatchObject({ kind: "object", properties: { callee: { kind: "node" }, arguments: { kind: "array", values: [{ kind: "string", value: "first" }, { kind: "undefined" }, { kind: "string", value: "third" }] }, receiver: { kind: "unavailable", reason: "ACCESSOR_PROPERTY" } } });
    expect(reads).toBe(0);
    const proxy = new Proxy({}, { ownKeys() { reads++; return []; }, get() { reads++; return undefined; } });
    expect(facts.describe(proxy)).toEqual({ kind: "unavailable", reason: "UNBOUND_PROXY" });
    expect(reads).toBe(0);
    const cyclic: Record<string, unknown> = {}; cyclic["self"] = cyclic;
    expect(facts.describe(cyclic)).toEqual({ kind: "object", properties: { self: { kind: "unavailable", reason: "DESCRIPTION_CYCLE" } } });
  });
  test("omits uncaptured semantic shape instead of querying or manufacturing an empty list", () => {
    const facts = createContractFacts({ files: [{ path: "/project/main.ts", nodes: [{ kind: "SourceFile", start: 0, end: 0, text: "", typeId: "unknown" }], factsGraph: { types: [{ id: "unknown", text: "unknown", flagsBits: 2 }] } }] }, "main.ts", { "main.ts": "" });
    const value = facts.describe(facts.checker["getTypeAtLocation"]!(facts.source)) as Record<string, unknown>;
    expect(value["nativeId"]).toBe("unknown");
    expect(value).not.toHaveProperty("callSignatureCount");
    expect(value).not.toHaveProperty("unionTypes");
    expect(value).not.toHaveProperty("flagsNames");
  });
  test("uses native symbol-type observations only at their exact location", () => {
    const anchor = { path: "/project/main.ts", kind: "SourceFile", start: 0, end: 1 };
    const native = { files: [{ path: anchor.path, nodes: [{ ...anchor, text: "x", symbolId: "s1" }], factsGraph: {
      symbols: [{ id: "s1", name: "x", flagsBits: 2, declarations: [] }],
      types: [{ id: "wrong", flagsBits: 1 }, { id: "right", flagsBits: 32 }],
      symbolTypes: [{ symbolId: "s1", location: { ...anchor, start: 1 }, typeId: "wrong" }, { symbolId: "s1", location: anchor, typeId: "right" }],
    } }] };
    const facts = createContractFacts(native, "main.ts", { "main.ts": "x" });
    const symbol = facts.checker["getSymbolAtLocation"]!(facts.source);
    const type = facts.checker["getTypeOfSymbolAtLocation"]!(symbol, facts.source) as Record<string, unknown>;
    expect(type["flags"]).toBe(32);
  });
  test("never reuses checker-local IDs from another captured root file", () => {
    const sourceNode = { kind: "SourceFile", start: 0, end: 1, pos: 0 };
    const native = { sourceFiles: [{ path: "/project/main.ts", text: "x", sourceNode }, { path: "/project/other.ts", text: "y", sourceNode }], files: [
      { path: "/project/main.ts", nodes: [{ ...sourceNode, text: "x", symbolId: "s1" }], factsGraph: { symbols: [{ id: "s1", name: "main", flagsBits: 1, declarations: [] }] } },
      { path: "/project/other.ts", nodes: [{ ...sourceNode, text: "y", symbolId: "s1" }], factsGraph: { symbols: [{ id: "s1", name: "other", flagsBits: 1, declarations: [] }] } },
    ] };
    const facts = createContractFacts(native, "main.ts", { "main.ts": "x", "other.ts": "y" });
    const other = (facts.program["getSourceFile"] as (path: string) => unknown)("/project/other.ts");
    expect(() => facts.checker["getSymbolAtLocation"]!(other)).toThrow("NATIVE_QUERY_REQUIRED:resolve");
  });
  test("keeps full native source text when the source node starts after leading trivia", () => {
    const text = "// lead\n1;";
    const facts = createContractFacts({ sourceFiles: [{ path: "/project/main.ts", text }], files: [{ path: "/project/main.ts", nodes: [{ kind: "SourceFile", start: 8, end: 10, pos: 0, text: "1;", parent: null, fields: {}, children: [] }] }] }, "main.ts", { "main.ts": text });
    expect(facts.source["text"]).toBe(text);
  });
  test("refuses a truncated native graph even if the visible source is empty", () => {
    expect(() => createContractFacts({ files: [{ path: "/project/main.ts", factsGraph: { truncated: true }, nodes: [{ kind: "SourceFile", start: 0, end: 0, text: "" }] }] }, "main.ts", { "main.ts": "" })).toThrow("NATIVE_GRAPH_TRUNCATED");
  });
  test("requests symbol types at the native location without substituting a global type", () => {
    const source = { kind: "SourceFile", start: 0, end: 1, text: "x", parent: null, fields: {}, children: [], symbolId: "s1" };
    const native = { files: [{ path: "/project/main.ts", nodes: [source], factsGraph: { symbols: [{ id: "s1", name: "x", flagsBits: 2, declarations: [], route: { anchor: { path: "/project/main.ts", kind: "Identifier", start: 0, end: 1 }, steps: [{ op: "symbol" }] }, type: "globally-declared" }] } }] };
    const facts = createContractFacts(native, "main.ts", { "main.ts": "x" });
    const symbol = facts.checker["getSymbolAtLocation"]!(facts.source);
    let failure: unknown;
    try { facts.checker["getTypeOfSymbolAtLocation"]!(symbol, facts.source); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(NativeFactsRequired);
    const query = (failure as NativeFactsRequired).queries[0]!;
    expect(query.operation).toBe("symbolType");
    expect(query.location).toEqual({ path: "/project/main.ts", kind: "SourceFile", start: 0, end: 1 });
  });
  test("converts native byte offsets to UTF16 and recognizes CR line endings", () => {
    const text = "é😀\r\nx\ry";
    const identifier = { kind: "Identifier", start: 8, pos: 8, end: 9, text: "x", literalText: "x", parent: { kind: "SourceFile", start: 0, end: 11 }, fields: {}, children: [] };
    const facts = createContractFacts({ files: [{ path: "/project/main.ts", text, nodes: [{ kind: "SourceFile", start: 0, pos: 0, end: 11, text, parent: null, fields: { statements: [identifier] }, children: [identifier] }, identifier] }] }, "main.ts", { "main.ts": text });
    const statement = (facts.source["statements"] as Record<string, unknown>[])[0]!;
    expect((statement["getStart"] as () => number)()).toBe(5);
    expect((statement["getEnd"] as () => number)()).toBe(6);
    const line = facts.source["getLineAndCharacterOfPosition"] as (position: number) => unknown;
    expect(line(5)).toEqual({ line: 1, character: 0 });
    expect(line(7)).toEqual({ line: 2, character: 0 });
  });
  test("does not approximate unknown composite predicates by syntax kind equality", () => {
    const facts = createContractFacts({ files: [{ path: "/project/main.ts", nodes: [{ kind: "SourceFile", start: 0, end: 0, text: "", children: [], fields: {}, parent: null }] }] }, "main.ts", { "main.ts": "" });
    expect(() => (facts.ts["isLiteralExpression"] as (value: unknown) => boolean)(facts.source)).toThrow("NATIVE_PREDICATE_UNSUPPORTED");
  });
  test("refuses an absent native checker fact rather than inventing an unknown type", () => {
    const facts = createContractFacts({ files: [{ path: "/project/main.ts", text: "x", referencedFiles: [], isDeclarationFile: false, nodes: [{ kind: "SourceFile", start: 0, pos: 0, end: 1, text: "x", parent: null, fields: {}, children: [] }] }] }, "main.ts", { "main.ts": "x" });
    expect(() => facts.checker["getTypeAtLocation"]!(facts.source)).toThrow("NATIVE_QUERY_REQUIRED:resolve");
  });
  test("refuses source text inconsistent with native captured text", () => {
    expect(() => createContractFacts({ files: [{ path: "/project/main.ts", text: "x", nodes: [{ kind: "SourceFile", start: 0, end: 1, text: "x" }] }] }, "main.ts", { "main.ts": "y" })).toThrow("SOURCE_TEXT_MISMATCH");
  });
});
