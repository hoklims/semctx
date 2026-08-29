import { describe, expect, it } from "bun:test";
import { degradeDivergentMarkerNodes, detectMarkerDivergence, type MarkerDeclaration } from "../src/markers";

describe("detectMarkerDivergence — non-authorizing disagreement (HOK-79)", () => {
  it("flags a slug declared with two different statements", () => {
    const declarations: MarkerDeclaration[] = [
      { tag: "invariant", slug: "must-hold", statement: "A must never exceed B", relPath: "a.ts", startLine: 5 },
      { tag: "invariant", slug: "must-hold", statement: "A must equal B", relPath: "b.ts", startLine: 9 },
    ];
    const divergences = detectMarkerDivergence(declarations);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]!.slug).toBe("must-hold");
    expect(divergences[0]!.statements).toEqual(["A must equal B", "A must never exceed B"]);
    expect(divergences[0]!.declaredAt).toHaveLength(2);
  });

  it("does not flag the same slug repeating the identical statement", () => {
    const declarations: MarkerDeclaration[] = [
      { tag: "capability", slug: "checkout", statement: "handles checkout", relPath: "a.ts", startLine: 1 },
      { tag: "capability", slug: "checkout", statement: "handles checkout", relPath: "b.ts", startLine: 2 },
    ];
    expect(detectMarkerDivergence(declarations)).toEqual([]);
  });

  // HOK-79: the graph keys a marker node by its *canonical* slug (`slugify`) — NFKD-folded,
  // lowercased, punctuation-collapsed, and truncated to 60 characters. Two raw slugs that only
  // differ in one of those ways still land on the same graph node, so divergence must be judged on
  // the canonical key, not the raw one, or these four collisions would go undetected.
  it("groups by the canonical (slugified) id, not the raw slug: punctuation", () => {
    const declarations: MarkerDeclaration[] = [
      { tag: "invariant", slug: "must-hold", statement: "A must never exceed B", relPath: "a.ts", startLine: 1 },
      { tag: "invariant", slug: "must_hold!", statement: "A must equal B", relPath: "b.ts", startLine: 2 },
    ];
    const divergences = detectMarkerDivergence(declarations);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]!.declaredAt).toHaveLength(2);
  });

  it("groups by the canonical (slugified) id, not the raw slug: case", () => {
    const declarations: MarkerDeclaration[] = [
      { tag: "invariant", slug: "Must-Hold", statement: "A must never exceed B", relPath: "a.ts", startLine: 1 },
      { tag: "invariant", slug: "must-hold", statement: "A must equal B", relPath: "b.ts", startLine: 2 },
    ];
    expect(detectMarkerDivergence(declarations)).toHaveLength(1);
  });

  it("groups by the canonical (slugified) id, not the raw slug: accents (NFKD fold)", () => {
    const declarations: MarkerDeclaration[] = [
      { tag: "invariant", slug: "dé-jà-vu", statement: "A must never exceed B", relPath: "a.ts", startLine: 1 },
      { tag: "invariant", slug: "de-ja-vu", statement: "A must equal B", relPath: "b.ts", startLine: 2 },
    ];
    expect(detectMarkerDivergence(declarations)).toHaveLength(1);
  });

  it("groups by the canonical (slugified) id, not the raw slug: 60-char truncation", () => {
    const base = "a".repeat(60);
    const declarations: MarkerDeclaration[] = [
      { tag: "invariant", slug: base, statement: "A must never exceed B", relPath: "a.ts", startLine: 1 },
      { tag: "invariant", slug: `${base}-extra-tail`, statement: "A must equal B", relPath: "b.ts", startLine: 2 },
    ];
    expect(detectMarkerDivergence(declarations)).toHaveLength(1);
  });
});

describe("degradeDivergentMarkerNodes — removing evidence never makes a verdict more optimistic", () => {
  it("strips the statement and tags only the contested node, leaving others untouched", () => {
    const contested = {
      id: "inv:must-hold",
      tags: [] as string[],
      metadata: { statement: "A must never exceed B" } as Record<string, string | number | boolean>,
    };
    const clean = {
      id: "inv:other",
      tags: [] as string[],
      metadata: { statement: "unrelated" } as Record<string, string | number | boolean>,
    };
    const divergences = detectMarkerDivergence([
      { tag: "invariant", slug: "must-hold", statement: "A must never exceed B", relPath: "a.ts", startLine: 5 },
      { tag: "invariant", slug: "must-hold", statement: "A must equal B", relPath: "b.ts", startLine: 9 },
    ]);

    degradeDivergentMarkerNodes([contested, clean], divergences);

    expect(contested.metadata["statement"]).toBeUndefined();
    expect(contested.tags).toEqual(["statement-divergent"]);
    expect(clean.metadata["statement"]).toBe("unrelated");
    expect(clean.tags).toEqual([]);
  });
});
