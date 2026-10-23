import { describe, expect, test } from "bun:test";
import { createContractFacts, NativeFactsRequired } from "./t00-ts7-q-semantic-contract-facts";

describe("native contract facts", () => {
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
