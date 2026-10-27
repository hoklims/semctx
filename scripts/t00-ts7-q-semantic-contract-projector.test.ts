import { describe, expect, test } from "bun:test";
import { contractProjectionInventory, projectContract } from "./t00-ts7-q-semantic-contract-projector";

describe("contract projection", () => {
  test.each([["cwd", []], ["dlopen", ["SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED"]]] as const)("projects the frozen ordinary-process distinction for %s", (member, reasons) => {
    const text = `process.${member}();`;
    const source = { kind: "SourceFile", start: 0, end: text.length };
    const statement = { kind: "ExpressionStatement", start: 0, end: text.length };
    const call = { kind: "CallExpression", start: 0, end: text.length - 1 };
    const property = { kind: "PropertyAccessExpression", start: 0, end: text.length - 3 };
    const receiver = { kind: "Identifier", start: 0, end: 7 };
    const name = { kind: "Identifier", start: 8, end: text.length - 3 };
    const node = (reference: typeof source, parent: unknown, children: unknown[], fields: Record<string, unknown>, literalText = "") => ({
      ...reference, pos: reference.start, text: text.slice(reference.start, reference.end), literalText, parent, children, fields,
      symbol: null, typeId: "any", isTypeNode: false, canHaveModifiers: false, isExpression: true, isStringLiteralLike: false, isFunctionLike: false, isClassLike: false,
    });
    const native = { compilerConstants: { useCaseSensitiveFileNames: true, symbolFlags: { Alias: 2097152 }, typeFlags: { Any: 1, Unknown: 2, TypeParameter: 262144, Object: 1048576, StringLike: 96, NumberLike: 384, BigIntLike: 1536, BooleanLike: 3072, ESSymbolLike: 12288, Union: 2097152, Intersection: 4194304 } }, files: [{ path: "/project/main.ts", referencedFiles: [], isDeclarationFile: false, defaultLibrary: false, nodes: [
      node(source, null, [statement], { statements: [statement] }),
      node(statement, source, [call], { expression: call }),
      node(call, statement, [property], { expression: property, arguments: [] }),
      node(property, call, [receiver, name], { expression: receiver, name }),
      node(receiver, property, [], {}, "process"), node(name, property, [], {}, member),
    ], factsGraph: { types: [{ id: "any", flagsBits: 1, callSignatures: [], constructSignatures: [], unionTypes: [], intersectionTypes: [], properties: [], baseConstraint: null, symbol: null }], propertyLookups: [{ typeId: "any", name: member, symbolId: null }] } }] };
    const projection = projectContract(native, "main.ts", { "main.ts": text });
    expect(projection.gaps).toEqual([]);
    expect(projection.reasons).toEqual([...reasons]);
  });
  test("preserves optional member calls when a native symbol is absent", () => {
    const reference = { kind: "Identifier", start: 0, end: 8 };
    const statement = { kind: "ExpressionStatement", start: 0, end: 9 };
    const root = { kind: "SourceFile", start: 0, end: 9 };
    const native = {
      compilerConstants: { useCaseSensitiveFileNames: true, symbolFlags: { Alias: 2097152 } },
      files: [{ path: "/project/main.ts", referencedFiles: [], isDeclarationFile: false, defaultLibrary: false, nodes: [
        { ...root, text: "register;", pos: 0, isTypeNode: false, canHaveModifiers: false, parent: null, symbol: null, children: [statement], fields: { statements: [statement] } },
        { ...statement, text: "register;", pos: 0, isTypeNode: false, canHaveModifiers: false, parent: root, children: [reference], fields: { expression: reference } },
        { ...reference, text: "register", literalText: "register", pos: 0, isTypeNode: false, canHaveModifiers: false, parent: statement, symbol: null, children: [], fields: {} },
      ] }],
    };
    const projection = projectContract(native, "main.ts", { "main.ts": "register;" });
    expect(projection.gaps).toEqual([]);
    expect(projection.reasons).toEqual([]);
    expect(projection.helperResults.some(result => result.index === 129 && (result.value as { kind: string }).kind === "undefined")).toBe(true);
  });
  test("executes the frozen contract against captured source structure", () => {
    const native = { files: [{ path: "/project/main.ts", referencedFiles: [], isDeclarationFile: false, nodes: [{ kind: "SourceFile", start: 0, end: 0, pos: 0, text: "", fields: {}, parent: null, children: [] }] }] };
    const projection = projectContract(native, "main.ts", { "main.ts": "" });
    expect(projection.status).toBe("projected");
    expect(projection.reasons).toEqual([]);
    expect(projection.helperResults.some(result => result.index === 84)).toBe(true);
    expect(projection.sites.some(site => site.index === 84)).toBe(true);
    expect(projection.sites.some(site => site.index === 129)).toBe(false);
    expect(projection.sites.filter(site => site.index === 49).map(site => site.site).sort()).toEqual(["49:0", "49:3"]);
  });
  test("keeps unavailable native facts unprojected", () => {
    expect(projectContract({}, "main.ts", { "main.ts": "1+2;" }).status).toBe("unsupported");
  });
  test("binds every canonical site once, including repeated member expressions", () => {
    const inventory = contractProjectionInventory();
    expect(inventory.gaps).toEqual([]);
    expect(inventory.sites.filter(site => site.index === 52)).toHaveLength(7);
    expect(inventory.sites.filter(site => site.index === 129)).toHaveLength(52);
    expect(new Set(inventory.sites.map(site => site.site)).size).toBe(inventory.sites.length);
    expect(new Set(inventory.branches.map(branch => branch.id)).size).toBe(inventory.branches.length);
  });
});
