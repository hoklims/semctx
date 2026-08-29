/**
 * A broken anchor must say *how* it is broken.
 *
 * "Stale link" was one sentence for three different repairs: change the anchor's kind, find where
 * the symbol went, or disambiguate between several. Each case below pins the machine code, the
 * candidate list, and — for ambiguity — that nothing was chosen on the author's behalf.
 */

import { describe, expect, it } from "bun:test";
import type { RepositoryGraph, RepositoryNode } from "@semantic-context/core";
import {
  LEGACY_SYMBOL_ANCHOR_SHIPPED_IN,
  LEGACY_SYMBOL_ANCHOR_SUPPORT,
  MAX_LINK_CANDIDATES,
  buildRepositoryLinkIndex,
  resolveRepositoryLink,
} from "@semantic-context/semantic-model";

function symbol(id: string, name: string, kind: RepositoryNode["kind"], filePath: string): RepositoryNode {
  return { id, kind, name, filePath, evidence: [], tags: [], metadata: {} };
}

function index(...nodes: RepositoryNode[]) {
  const graph: RepositoryGraph = { nodes, edges: [] };
  return buildRepositoryLinkIndex({ graph, claims: [], evidence: [] });
}

const RUN = symbol("sym:function:src/a.ts:run", "run", "function", "src/a.ts");

describe("exact identity", () => {
  it("resolves an anchor that names an existing symbol, with no legacy marking", () => {
    const result = resolveRepositoryLink({ kind: "symbol", ref: RUN.id }, index(RUN));

    expect(result.resolved).toBe(true);
    expect(result.targets).toEqual([{ kind: "repository_node", id: RUN.id }]);
    expect(result.legacy).toBeUndefined();
    expect(result.reasonCode).toBeUndefined();
  });
});

describe("role_removed", () => {
  // The declaration is still there under that exact name and scope — it is an interface now. The
  // author must change the anchor's kind, not go looking for a function that moved.
  it("is reported when the coordinate exists under a different kind", () => {
    const result = resolveRepositoryLink(
      { kind: "symbol", ref: "sym:function:src/a.ts:Shape" },
      index(symbol("sym:interface:src/a.ts:Shape", "Shape", "interface", "src/a.ts")),
    );

    expect(result.resolved).toBe(false);
    expect(result.reasonCode).toBe("role_removed");
    expect(result.candidates).toEqual(["sym:interface:src/a.ts:Shape"]);
  });

  it("is preferred over symbol_gone, because the repair differs", () => {
    const result = resolveRepositoryLink(
      { kind: "symbol", ref: "sym:function:src/a.ts:outer.helper" },
      index(symbol("sym:class:src/a.ts:outer.helper", "helper", "class", "src/a.ts")),
    );

    expect(result.reasonCode).toBe("role_removed");
    expect(result.reasonCode).not.toBe("symbol_gone");
  });
});

describe("symbol_gone", () => {
  it("is reported when nothing at all matches", () => {
    const result = resolveRepositoryLink(
      { kind: "symbol", ref: "sym:function:src/a.ts:vanished" },
      index(RUN),
    );

    expect(result.resolved).toBe(false);
    expect(result.reasonCode).toBe("symbol_gone");
    expect(result.targets).toEqual([]);
  });

  it("is reported for a deprecated anchor whose symbol no longer exists", () => {
    const result = resolveRepositoryLink(
      { kind: "symbol", ref: "sym:function:src/a.ts:vanished:12" },
      index(RUN),
    );

    expect(result.resolved).toBe(false);
    expect(result.reasonCode).toBe("symbol_gone");
    // Candidates are offered from the same file so the author has somewhere to look.
    expect(result.candidates).toEqual([RUN.id]);
  });
});

describe("non-symbol missing nodes", () => {
  it("uses node_absent rather than misclassifying the link as a vanished symbol", () => {
    for (const kind of ["invariant", "contract", "capability", "test", "migration"] as const) {
      const result = resolveRepositoryLink({ kind, ref: `${kind}.missing` }, index(RUN));
      expect(result.resolved).toBe(false);
      expect(result.reasonCode).toBe("node_absent");
      expect(result.reasonCode).not.toBe("symbol_gone");
    }
  });
});

describe("ambiguous", () => {
  const outer = symbol("sym:function:src/a.ts:outer.parse", "parse", "function", "src/a.ts");
  const top = symbol("sym:function:src/a.ts:parse", "parse", "function", "src/a.ts");

  // The load-bearing property: the resolution is refused. A code alone would not prove that, since
  // a resolution could carry `ambiguous` and still hand back a target.
  it("refuses to choose and reports every candidate, sorted", () => {
    const result = resolveRepositoryLink(
      { kind: "symbol", ref: "sym:function:src/a.ts:parse:7" },
      index(outer, top),
    );

    expect(result.resolved).toBe(false);
    expect(result.targets).toEqual([]);
    expect(result.reasonCode).toBe("ambiguous");
    expect(result.candidates).toEqual([outer.id, top.id].sort());
  });

  it("bounds and sorts the candidate list deterministically", () => {
    const many = Array.from({ length: MAX_LINK_CANDIDATES + 5 }, (_unused, position) =>
      symbol(`sym:function:src/a.ts:s${String(position).padStart(2, "0")}.parse`, "parse", "function", "src/a.ts"));

    const first = resolveRepositoryLink({ kind: "symbol", ref: "sym:function:src/a.ts:parse:1" }, index(...many));
    const again = resolveRepositoryLink({ kind: "symbol", ref: "sym:function:src/a.ts:parse:1" }, index(...[...many].reverse()));

    expect(first.candidates).toHaveLength(MAX_LINK_CANDIDATES);
    expect(first.candidates).toEqual([...first.candidates!].sort());
    // Input order must not leak into the diagnostic.
    expect(again.candidates).toEqual(first.candidates);
  });
});

describe("deprecated line-bearing anchors", () => {
  // The whole point of dropping the line number: a symbol that merely moved must keep resolving.
  it("re-anchors to the single symbol of that kind and name in the file", () => {
    const result = resolveRepositoryLink({ kind: "symbol", ref: "sym:function:src/a.ts:run:42" }, index(RUN));

    expect(result.resolved).toBe(true);
    expect(result.targets).toEqual([{ kind: "repository_node", id: RUN.id }]);
    expect(result.legacy).toBe(true);
  });

  it("does not cross file or kind boundaries to find a match", () => {
    const elsewhere = symbol("sym:function:src/b.ts:run", "run", "function", "src/b.ts");
    const wrongKind = symbol("sym:class:src/a.ts:run", "run", "class", "src/a.ts");

    const result = resolveRepositoryLink(
      { kind: "symbol", ref: "sym:function:src/a.ts:run:42" },
      index(elsewhere, wrongKind),
    );

    expect(result.resolved).toBe(false);
    expect(result.reasonCode).toBe("symbol_gone");
  });
});

describe("the compatibility gate drives the resolver", () => {
  const literal = symbol("sym:function:src/a.ts:run:42", "run", "function", "src/a.ts");

  it("resolves a legacy anchor while support is deprecated", () => {
    const result = resolveRepositoryLink(
      { kind: "symbol", ref: "sym:function:src/a.ts:run:42" },
      index(RUN),
      { legacySupport: "deprecated" },
    );

    expect(result.resolved).toBe(true);
    expect(result.legacy).toBe(true);
  });

  it("stops resolving a legacy anchor once support is removed", () => {
    const result = resolveRepositoryLink(
      { kind: "symbol", ref: "sym:function:src/a.ts:run:42" },
      index(RUN),
      { legacySupport: "removed" },
    );

    expect(result.resolved).toBe(false);
    expect(result.targets).toEqual([]);
    expect(result.reasonCode).toBe("symbol_gone");
    expect(result.candidates).toEqual([RUN.id]);
  });

  it("stops honouring a line-bearing id an old graph persists verbatim", () => {
    const result = resolveRepositoryLink(
      { kind: "symbol", ref: literal.id },
      index(literal),
      { legacySupport: "removed" },
    );

    expect(result.resolved).toBe(false);
    expect(result.targets).toEqual([]);
  });

  it("ships deprecated, and records the release the removal is owed to", () => {
    expect(LEGACY_SYMBOL_ANCHOR_SUPPORT).toBe("deprecated");
    expect(LEGACY_SYMBOL_ANCHOR_SHIPPED_IN).toBeNull();
  });
});

describe("a collision discriminator is a fact, never an address", () => {
  const first = symbol("sym:function:src/a.ts:outer.run#1", "run", "function", "src/a.ts");
  const second = symbol("sym:function:src/a.ts:outer.run#2", "run", "function", "src/a.ts");

  it("refuses the unqualified coordinate rather than binding it to a member", () => {
    const result = resolveRepositoryLink(
      { kind: "symbol", ref: "sym:function:src/a.ts:outer.run" },
      index(first, second),
    );

    expect(result.resolved).toBe(false);
    expect(result.targets).toEqual([]);
    expect(result.reasonCode).toBe("ambiguous");
    expect(result.candidates).toEqual([first.id, second.id]);
  });

  // The kind did not change: two functions are declared right there. Saying `role_removed` would
  // send the author looking for a role that never went anywhere.
  it("does not misreport the collision as role_removed", () => {
    const result = resolveRepositoryLink(
      { kind: "symbol", ref: "sym:function:src/a.ts:outer.run" },
      index(first, second),
    );

    expect(result.reasonCode).not.toBe("role_removed");
  });

  it("refuses an ordinal-bearing anchor even though the node exists", () => {
    const result = resolveRepositoryLink({ kind: "symbol", ref: second.id }, index(first, second));

    expect(result.resolved).toBe(false);
    expect(result.targets).toEqual([]);
    expect(result.reasonCode).toBe("ambiguous");
    expect(result.candidates).toEqual([first.id, second.id]);
  });
});

describe("no fuzzy matching", () => {
  it("never resolves a near-miss name", () => {
    const result = resolveRepositoryLink(
      { kind: "symbol", ref: "sym:function:src/a.ts:runn" },
      index(RUN),
    );

    expect(result.resolved).toBe(false);
    expect(result.targets).toEqual([]);
  });

  it("never resolves a same-name symbol in another file", () => {
    const result = resolveRepositoryLink(
      { kind: "symbol", ref: "sym:function:src/b.ts:run" },
      index(RUN),
    );

    expect(result.resolved).toBe(false);
    expect(result.targets).toEqual([]);
  });
});
