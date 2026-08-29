import { describe, expect, it } from "bun:test";
import {
  DIVERGENT_STATEMENT_TAG,
  isLegacySymbolId,
  parseLegacySymbolId,
  parseSymbolId,
  symbolId,
  symbolScopePath,
} from "../src/ids";

describe("symbolId — line-free, scope-qualified identity (HOK-79)", () => {
  it("carries no source line: a harmless insertion above a declaration cannot change it", () => {
    // The whole point of dropping the start line from identity is that computing it never needs
    // the line in the first place — there is no line-shaped input to accidentally reintroduce.
    const id = symbolId("function", "src/a.ts", "run", ["Outer"]);
    expect(id).toBe("sym:function:src/a.ts:Outer.run");
    expect(id.split(":")).toHaveLength(4);
  });

  it("keeps two same-named symbols in different scopes distinct without a line arbitrating", () => {
    const outer = symbolId("function", "src/a.ts", "helper", []);
    const nested = symbolId("function", "src/a.ts", "helper", ["Service", "read"]);
    expect(outer).not.toBe(nested);
  });

  it("parses a canonical id back into kind/relPath/scope/name", () => {
    const parsed = parseSymbolId("sym:function:src/a.ts:Outer.helper");
    expect(parsed).toEqual({
      kind: "function",
      relPath: "src/a.ts",
      scope: ["Outer"],
      name: "helper",
    });
  });

  it("strips and reports the collision ordinal separately from the name", () => {
    const parsed = parseSymbolId("sym:function:src/a.ts:run#2");
    expect(parsed?.name).toBe("run");
    expect(parsed?.ordinal).toBe(2);
  });

  it("is undefined for a legacy line-bearing id — the two forms never overlap", () => {
    expect(parseSymbolId("sym:function:src/a.ts:run:12")).toBeUndefined();
  });

  it("recognizes the deprecated pre-HOK-79 line-bearing form and only that form", () => {
    const legacy = parseLegacySymbolId("sym:function:src/a.ts:run:12");
    expect(legacy).toEqual({ kind: "function", relPath: "src/a.ts", name: "run", startLine: 12 });
    expect(isLegacySymbolId("sym:function:src/a.ts:run:12")).toBe(true);
    expect(isLegacySymbolId("sym:function:src/a.ts:run")).toBe(false);
    expect(parseLegacySymbolId("sym:function:src/a.ts:run")).toBeUndefined();
  });

  it("symbolScopePath matches exactly what symbolId encodes as the qualified tail", () => {
    expect(symbolScopePath(["Outer"], "helper")).toBe("Outer.helper");
  });

  it("accepts the pre-HOK-79 positional startLine and explicitly ignores it", () => {
    // A caller still on the old four-argument shape (kind, relPath, name, startLine) must get the
    // same canonical, scope-empty, line-free id as calling with no fourth argument at all — never
    // a line-bearing id, and never a runtime error.
    const withLegacyLine = symbolId("function", "src/a.ts", "run", 12);
    const withNoScope = symbolId("function", "src/a.ts", "run");
    expect(withLegacyLine).toBe(withNoScope);
    expect(withLegacyLine).toBe("sym:function:src/a.ts:run");
    expect(withLegacyLine.split(":")).toHaveLength(4);
  });

  it("produces the same id for any startLine value passed through the legacy overload", () => {
    expect(symbolId("function", "src/a.ts", "run", 1)).toBe(symbolId("function", "src/a.ts", "run", 999));
  });
});

describe("DIVERGENT_STATEMENT_TAG", () => {
  it("is a stable, graph-vocabulary tag string", () => {
    expect(DIVERGENT_STATEMENT_TAG).toBe("statement-divergent");
  });
});
