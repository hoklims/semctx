/**
 * The doctrine has to be mechanical, and it has to be *narrow*.
 *
 * A warning that fired on every `sym:` anchor would be noise an author learns to ignore; a warning
 * that fired on none would be a comment in a document. Both halves are asserted here: the durable
 * kinds warn, and `change` / `evidence` provably do not.
 */

import { describe, expect, it } from "bun:test";
import type { RepositoryGraph } from "@semantic-context/core";
import type { SemanticModel, SemanticNodeKind } from "@semantic-context/semantic-model";
import { checkSemanticModel } from "@semantic-context/semantic-engine";

const SYMBOL_REF = "sym:function:src/a.ts:run";

function node(kind: SemanticNodeKind, id: string, refs: string[]) {
  return {
    id,
    kind,
    statement: `statement for ${id}`,
    status: "declared" as const,
    provenance: "author" as const,
    sourceRefs: [],
    repositoryLinks: refs.map((ref) => ({ kind: "symbol" as const, ref })),
    relations: [],
    tags: [],
  };
}

function change(id: string, refs: string[]) {
  return {
    id,
    statement: `statement for ${id}`,
    lifecycle: "draft" as const,
    provenance: "author" as const,
    sourceRefs: [],
    serves: [],
    preserves: [],
    requiresEvidence: [],
    openUnknowns: [],
    repositoryLinks: refs.map((ref) => ({ kind: "symbol" as const, ref })),
    tags: [],
  };
}

const graph: RepositoryGraph = {
  nodes: [{ id: SYMBOL_REF, kind: "function", name: "run", filePath: "src/a.ts", evidence: [], tags: [], metadata: {} }],
  edges: [],
};

function check(model: SemanticModel) {
  return checkSemanticModel({
    model,
    diagnostics: [],
    duplicateIds: [],
    facts: { graph, claims: [], evidence: [] },
    graphIndexed: true,
  });
}

describe("durable intent must not anchor on a transient coordinate", () => {
  for (const kind of ["goal", "invariant", "decision"] as const) {
    it(`warns when a ${kind} anchors on sym:`, () => {
      const report = check({ nodes: [node(kind, `${kind}.durable`, [SYMBOL_REF])], changes: [] });

      expect(report.reasonCodes).toContain("DURABLE_ANCHOR_IS_TRANSIENT");
      const finding = report.anchorFindings.find((item) => item.code === "DURABLE_ANCHOR_IS_TRANSIENT");
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe("warning");
      expect(finding?.ownerId).toBe(`${kind}.durable`);
      expect(finding?.ref).toBe(SYMBOL_REF);
      expect(finding?.message).toContain("inv:");
      // A warning must not turn a valid model into a failing one.
      expect(report.ok).toBe(true);
      expect(report.counts.warnings).toBe(1);
    });
  }
});

describe("short-lived coordinates stay legitimate", () => {
  it("does not warn when a change anchors on sym:", () => {
    const report = check({ nodes: [], changes: [change("change.one", [SYMBOL_REF])] });

    expect(report.anchorFindings).toEqual([]);
    expect(report.reasonCodes).not.toContain("DURABLE_ANCHOR_IS_TRANSIENT");
    expect(report.counts.warnings).toBe(0);
  });

  it("does not warn when evidence anchors on sym:", () => {
    const report = check({ nodes: [node("evidence", "evidence.one", [SYMBOL_REF])], changes: [] });

    expect(report.anchorFindings).toEqual([]);
    expect(report.reasonCodes).not.toContain("DURABLE_ANCHOR_IS_TRANSIENT");
  });

  it("does not warn when durable intent anchors on a durable id", () => {
    const durable: SemanticModel = {
      nodes: [{
        ...node("invariant", "invariant.durable", []),
        repositoryLinks: [{ kind: "invariant", ref: "inv:payment-idempotent" }],
      }],
      changes: [],
    };

    expect(check(durable).anchorFindings).toEqual([]);
  });
});

describe("deprecated anchor form", () => {
  // Distinct from the doctrine warning: this one fires on a `change`, which doctrine leaves alone.
  it("warns when a link survives only through the line-bearing form", () => {
    const report = check({
      nodes: [],
      changes: [change("change.legacy", ["sym:function:src/a.ts:run:42"])],
    });

    expect(report.reasonCodes).toContain("DEPRECATED_SYMBOL_ANCHOR");
    const finding = report.anchorFindings.find((item) => item.code === "DEPRECATED_SYMBOL_ANCHOR");
    expect(finding?.ownerId).toBe("change.legacy");
    expect(finding?.message).toContain("semctx migrate anchors");
    // The link still resolves — deprecation is not breakage.
    expect(report.staleLinks).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("does not warn when the canonical form is used", () => {
    const report = check({ nodes: [], changes: [change("change.modern", [SYMBOL_REF])] });

    expect(report.reasonCodes).not.toContain("DEPRECATED_SYMBOL_ANCHOR");
    expect(report.anchorFindings).toEqual([]);
  });
});

describe("authority is monotone", () => {
  // Losing the anchor's target must never read better than having it. The `ok` flag is the
  // load-bearing half: a report that stayed ok while its anchor vanished would let a change close.
  it("degrades, never improves, when the anchored symbol disappears", () => {
    const model: SemanticModel = { nodes: [], changes: [change("change.one", [SYMBOL_REF])] };

    const withSymbol = check(model);
    const withoutSymbol = checkSemanticModel({
      model,
      diagnostics: [],
      duplicateIds: [],
      facts: { graph: { nodes: [], edges: [] }, claims: [], evidence: [] },
      graphIndexed: true,
    });

    expect(withSymbol.ok).toBe(true);
    expect(withoutSymbol.ok).toBe(false);
    expect(withoutSymbol.staleLinks).toHaveLength(1);
    expect(withoutSymbol.staleLinks[0]?.reasonCode).toBe("symbol_gone");
    expect(withoutSymbol.counts.errors).toBeGreaterThan(withSymbol.counts.errors);
  });

  it("degrades when the anchor becomes ambiguous", () => {
    const model: SemanticModel = {
      nodes: [],
      changes: [change("change.one", ["sym:function:src/a.ts:run:42"])],
    };

    const single = check(model);
    const ambiguous = checkSemanticModel({
      model,
      diagnostics: [],
      duplicateIds: [],
      facts: {
        graph: {
          nodes: [
            { id: "sym:function:src/a.ts:run", kind: "function", name: "run", filePath: "src/a.ts", evidence: [], tags: [], metadata: {} },
            { id: "sym:function:src/a.ts:outer.run", kind: "function", name: "run", filePath: "src/a.ts", evidence: [], tags: [], metadata: {} },
          ],
          edges: [],
        },
        claims: [],
        evidence: [],
      },
      graphIndexed: true,
    });

    expect(single.ok).toBe(true);
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.staleLinks[0]?.reasonCode).toBe("ambiguous");
    // Fail-closed: no target was picked on the author's behalf.
    expect(ambiguous.staleLinks[0]?.candidates).toHaveLength(2);
  });
});
