import { describe, expect, it } from "bun:test";
import { groupSymbols } from "../src/symbol-grouping";
import type { ExtractedSymbol } from "../src/ts-symbols";

function symbol(overrides: Partial<ExtractedSymbol> & Pick<ExtractedSymbol, "name" | "startLine" | "endLine">): ExtractedSymbol {
  return {
    kind: "function",
    relPath: "src/a.ts",
    scope: [],
    exported: false,
    markers: [],
    ...overrides,
  };
}

describe("groupSymbols — overload sets fold, homonym collisions split (HOK-79)", () => {
  it("folds an overload set (signatures + one implementation) into one logical symbol", () => {
    const symbols: ExtractedSymbol[] = [
      symbol({ name: "run", startLine: 1, endLine: 1, signatureOnly: true }),
      symbol({ name: "run", startLine: 2, endLine: 2, signatureOnly: true }),
      symbol({ name: "run", startLine: 3, endLine: 6, exported: true }),
    ];
    const grouped = groupSymbols(symbols);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.id).toBe("sym:function:src/a.ts:run");
    expect(grouped[0]!.declarations).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 2, endLine: 2 },
      { startLine: 3, endLine: 6 },
    ]);
    expect(grouped[0]!.exported).toBe(true);
  });

  it("splits two genuine homonym collisions into ordinal-suffixed ids, neither keeping the bare id", () => {
    // Two full function bodies sharing a (kind, relPath, scope, name) key — legal in nested
    // blocks. Merging them would attach one function's evidence/markers to the other.
    const symbols: ExtractedSymbol[] = [
      symbol({ name: "run", startLine: 1, endLine: 3 }),
      symbol({ name: "run", startLine: 10, endLine: 13 }),
    ];
    const grouped = groupSymbols(symbols);
    const ids = grouped.map((g) => g.id).sort();
    expect(ids).toEqual(["sym:function:src/a.ts:run#1", "sym:function:src/a.ts:run#2"]);
    // The unqualified coordinate stays unowned — an anchor written against it must resolve to
    // "several, pick one", never to whichever declaration happens to come first today.
    expect(grouped.some((g) => g.id === "sym:function:src/a.ts:run")).toBe(false);
  });

  it("attributes a marker to the declaration that actually carried it, not the group's first line", () => {
    const symbols: ExtractedSymbol[] = [
      symbol({ name: "run", startLine: 1, endLine: 1, signatureOnly: true }),
      symbol({
        name: "run",
        startLine: 2,
        endLine: 5,
        markers: [{ tag: "invariant", slug: "run-once", statement: "runs exactly once" }],
      }),
    ];
    const grouped = groupSymbols(symbols);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.markers).toEqual([
      { tag: "invariant", slug: "run-once", statement: "runs exactly once", startLine: 2 },
    ]);
  });
});
