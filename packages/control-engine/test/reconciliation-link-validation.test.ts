import { describe, expect, it } from "bun:test";
import { parseCoordinateGraphV2 } from "../src/reconciliation-validation";

function graph(staleLink: Record<string, unknown>) {
  return {
    schemaVersion: 2,
    nodes: [],
    structuralEdges: [],
    refinementRelations: [],
    verifiedEvidenceDigests: [],
    mapping: [],
    coverage: [],
    unsupported: [],
    unmapped: [],
    staleLinks: [staleLink],
    danglingReferences: [],
    compatibilityNormalization: [],
  };
}

const diagnostic = {
  ownerId: "change.anchor",
  link: { kind: "symbol" as const, ref: "sym:function:src/a.ts:run" },
  resolved: false as const,
  reason: "the symbol moved",
  reasonCode: "symbol_gone" as const,
  candidates: ["sym:function:src/a.ts:outer.run", "sym:function:src/a.ts:run"],
};

describe("Plane C reconciliation link parsing", () => {
  it("round-trips the complete coordinate diagnostic", () => {
    const wire = JSON.parse(JSON.stringify(graph(diagnostic)));
    expect(parseCoordinateGraphV2(wire).staleLinks).toEqual([diagnostic]);
  });

  it("rejects unknown fields and malformed diagnostics", () => {
    expect(() => parseCoordinateGraphV2(graph({ ...diagnostic, surprise: true }))).toThrow(/staleLinks\[0\] is invalid/);
    expect(() => parseCoordinateGraphV2(graph({ ...diagnostic, reasonCode: "unknown" }))).toThrow(/staleLinks\[0\] is invalid/);
    expect(() => parseCoordinateGraphV2(graph({ ...diagnostic, candidates: [...diagnostic.candidates].reverse() }))).toThrow(/staleLinks\[0\] is invalid/);
  });
});
