import { describe, expect, it } from "bun:test";
import {
  GraphIndex,
  computeChangeImpact,
  parseUnifiedDiffChanges,
  type ChangeImpactCore,
  type ComputeChangeImpactArgs,
  type ImpactFileOutline,
  type UnindexedModuleLink,
} from "@semantic-context/context-engine";
import type { EdgeKind, NodeKind, RepositoryEdge, RepositoryGraph, RepositoryNode, SurfaceMap } from "@semantic-context/core";

/*
 * src/a.ts, as indexed (line numbers are the old side of every diff below):
 *
 *  1 import { x } from "./x";
 *  2
 *  3 export function F(): number {
 *  4   return H();
 *  5 }
 *  6
 *  7 const K = 1;
 *  8 /** H doc *\/
 *  9 export function H(): number {
 * 10   return K;
 * 11 }
 *
 * G (src/b.ts) calls F; the test imports F by name; src/c.ts only imports the file.
 */

function node(id: string, kind: NodeKind, filePath: string, exported: boolean, lines?: [number, number]): RepositoryNode {
  const name = id.slice(id.lastIndexOf(":") + 1);
  return {
    id,
    kind,
    name,
    filePath,
    exported,
    evidence: lines === undefined ? [] : [{ filePath, startLine: lines[0], endLine: lines[1], sourceKind: "code" }],
    tags: [],
    metadata: {},
  } as RepositoryNode;
}

function edge(kind: EdgeKind, from: string, to: string, line?: number): RepositoryEdge {
  return {
    id: `${kind}:${from}->${to}`,
    kind,
    from,
    to,
    evidence: line === undefined ? [] : [{ filePath: "", startLine: line, endLine: line, sourceKind: "code" }],
    metadata: {},
  } as RepositoryEdge;
}

const F = "sym:function:src/a.ts:F";
const H = "sym:function:src/a.ts:H";
const G = "sym:function:src/b.ts:G";
const T = "test:test/a.test.ts";
const MOD_A = "mod:src/a.ts";
const MOD_B = "mod:src/b.ts";
const MOD_C = "mod:src/c.ts";

function graph(extra: { nodes?: RepositoryNode[]; edges?: RepositoryEdge[] } = {}): RepositoryGraph {
  return {
    nodes: [
      node(F, "function", "src/a.ts", true, [3, 5]),
      node(H, "function", "src/a.ts", true, [9, 11]),
      node(G, "function", "src/b.ts", true, [1, 3]),
      node(T, "test", "test/a.test.ts", false),
      node(MOD_A, "module", "src/a.ts", false),
      node(MOD_B, "module", "src/b.ts", false),
      node(MOD_C, "module", "src/c.ts", false),
      ...(extra.nodes ?? []),
    ],
    edges: [
      edge("declares", MOD_A, F),
      edge("declares", MOD_A, H),
      edge("declares", MOD_B, G),
      edge("calls", F, H, 4),
      edge("calls", G, F, 2),
      edge("tested_by", F, T, 1),
      edge("imports", MOD_B, MOD_A, 1),
      edge("imports", MOD_C, MOD_A, 1),
      ...(extra.edges ?? []),
    ],
  };
}

const OUTLINE_A: ImpactFileOutline = {
  statements: [
    { kind: "import", startLine: 1, endLine: 1, leadingStartLine: 1, declaredNames: ["x"], referencedNames: [], executesOnLoad: true },
    { kind: "function", startLine: 3, endLine: 5, leadingStartLine: 3, declaredNames: ["F"], referencedNames: ["H", "number"], executesOnLoad: false },
    { kind: "variable", startLine: 7, endLine: 7, leadingStartLine: 7, declaredNames: ["K"], referencedNames: [], executesOnLoad: false },
    { kind: "function", startLine: 9, endLine: 11, leadingStartLine: 8, declaredNames: ["H"], referencedNames: ["K", "number"], executesOnLoad: false },
  ],
  exportedNames: ["F", "H"],
  hasSyntaxErrors: false,
};

/** One-line replacement of `line` in src/a.ts; old and new sides share coordinates. */
function edit(line: number, path = "src/a.ts"): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${line} +${line} @@\n-old\n+new\n`;
}

function run(diffText: string, overrides: Partial<ComputeChangeImpactArgs> = {}): ChangeImpactCore {
  const outline = new Map([["src/a.ts", OUTLINE_A]]);
  return computeChangeImpact({
    index: new GraphIndex(graph()),
    diff: parseUnifiedDiffChanges(diffText),
    rangeSide: "old",
    outlines: { bound: outline, other: outline },
    untrackedPaths: [],
    packages: [
      { root: "src", identity: "@demo/src" },
      { root: "test", identity: "@demo/test" },
    ],
    surfaces: null,
    isPathSelected: () => true,
    hasCallEdges: () => true,
    moduleLinks: [],
    wholeModuleReads: [],
    ...overrides,
  });
}

const ids = (targets: readonly { id: string }[] | null): string[] => (targets ?? []).map((target) => target.id).sort();
const codes = (core: ChangeImpactCore): string[] => core.unresolved.map((gap) => gap.code);

describe("computeChangeImpact — reach direction and tiers", () => {
  it("follows dependents of a changed function, never its dependencies", () => {
    const core = run(edit(4));
    expect(core.units.map((unit) => [unit.kind, unit.id])).toEqual([["symbol", F]]);
    expect(ids(core.directlyAffected)).toEqual([G, T]);
    const reasons = Object.fromEntries(core.directlyAffected.map((target) => [target.id, target.reason]));
    expect(reasons[G]).toBe("CALLS_CHANGED");
    expect(reasons[T]).toBe("TEST_IMPORTS_CHANGED_BY_NAME");
    // H is what F calls: a dependency, not a dependent.
    expect([...ids(core.directlyAffected), ...ids(core.transitivelyAffected), ...ids(core.possiblyAffected)]).not.toContain(H);
  });

  it("lists a file-only importer as possible, and nothing as unaffected", () => {
    const core = run(edit(4));
    expect(core.possiblyAffected.map((target) => [target.id, target.reason])).toEqual([[MOD_C, "IMPORTS_FILE_OF_CHANGED_DECLARATION"]]);
    // b.ts already carries a known target (G): its module is not repeated as possible.
    expect(ids(core.possiblyAffected)).not.toContain(MOD_B);
    expect(core.complete).toBe(true);
    expect(core).not.toHaveProperty("explicitlyUnaffected");
  });

  it("propagates a non-exported constant through same-file references and calls", () => {
    const core = run(edit(7));
    expect(core.units.map((unit) => [unit.kind, unit.id, unit.exported, unit.behavioral])).toEqual([
      ["declaration", "decl:src/a.ts:K", false, true],
    ]);
    expect(core.directlyAffected.map((target) => [target.id, target.reason])).toEqual([[H, "REFERENCES_CHANGED_DECLARATION"]]);
    expect(ids(core.transitivelyAffected)).toEqual([F, G, T]);
    const g = core.transitivelyAffected.find((target) => target.id === G)!;
    expect(g.via.map((step) => step.relation)).toEqual(["referenced_by", "called_by", "called_by"]);
    // K is not exported: no importer can read it, so no structural (possible) dependent exists.
    expect(core.possiblyAffected).toEqual([]);
    expect(core.blastRadius.scope).toBe("repository");
  });

  it("exposes the changed file itself as possible, never as changed", () => {
    expect(run(edit(7)).exposure.get(MOD_A)).toBe("possible");
    expect(run(edit(6)).exposure.has(MOD_A)).toBe(false);
  });

  it("reports a comment or blank-line change as non-behavioural with an empty reach", () => {
    for (const line of [6, 8]) {
      const core = run(edit(line));
      expect(core.units.every((unit) => !unit.behavioral)).toBe(true);
      expect(core.units[0]!.kind).toBe(line === 8 ? "doc_comment" : "trivia");
      expect(core.directlyAffected).toEqual([]);
      expect(core.transitivelyAffected).toEqual([]);
      expect(core.possiblyAffected).toEqual([]);
      expect(core.blastRadius).toMatchObject({ scope: "local", complete: true, rationale: ["NO_BEHAVIORAL_CHANGE"] });
    }
  });

  it("scopes the blast radius to the changed package when the known reach stays there", () => {
    const core = run(edit(4), { packages: [{ root: "src", identity: "@demo/src" }, { root: "test", identity: "@demo/src-tests" }] });
    expect(core.blastRadius.known.packages).toEqual(["@demo/src", "@demo/src-tests"]);
    expect(core.blastRadius.scope).toBe("repository");
    const local = run(edit(4), { packages: [{ root: "src", identity: "@demo/src" }, { root: "test", identity: "@demo/src" }] });
    expect(local.blastRadius.scope).toBe("package");
    expect(local.blastRadius.rationale).toEqual(["WITHIN_CHANGED_PACKAGES"]);
  });
});

describe("computeChangeImpact — boundaries are reported, never absorbed", () => {
  it("turns an unclassifiable change into a reach gap and a structural possible tier", () => {
    const core = run(edit(7), { outlines: { bound: new Map(), other: new Map() } });
    expect(core.units.map((unit) => unit.kind)).toEqual(["unclassified"]);
    expect(codes(core)).toContain("CHANGE_NOT_CLASSIFIED");
    expect(core.complete).toBe(false);
    expect(core.blastRadius.scope).toBe("unknown");
    const reasons = new Set(core.possiblyAffected.map((target) => target.reason));
    expect(reasons).toEqual(new Set(["IMPORTS_FILE_WITH_UNCLASSIFIED_CHANGE", "SHARES_FILE_WITH_UNCLASSIFIED_CHANGE"]));
  });

  it("names a depth truncation instead of stopping silently", () => {
    const core = run(edit(10), { bounds: { maxDistance: 1, maxTargets: 250 } });
    expect(ids(core.directlyAffected)).toEqual([F]);
    expect(core.transitivelyAffected).toEqual([]);
    expect(core.unresolved.find((gap) => gap.code === "TRAVERSAL_TRUNCATED")).toMatchObject({ scope: "node", nodeId: F, affects: "reach" });
    expect(core.complete).toBe(false);
    expect(core.blastRadius.scope).toBe("unknown");
  });

  it("never reports a surface as not reached once the possible tier was truncated", () => {
    const importers = ["d", "e", "f"].map((name) => node(`mod:src/${name}.ts`, "module", `src/${name}.ts`, false));
    const surfaces: SurfaceMap = {
      schemaVersion: 1,
      surfaces: [
        { name: "importers", include: ["src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"] },
        { name: "elsewhere", include: ["lib/**"] },
      ],
    };
    const index = new GraphIndex(graph({ nodes: importers, edges: importers.map((mod) => edge("imports", mod.id, MOD_A, 1)) }));
    const core = run(edit(4), { index, surfaces, bounds: { maxDistance: 4, maxTargets: 2 } });
    expect(core.possiblyAffected).toHaveLength(2);
    expect(core.blastRadius.possible.omitted).toBe(2);
    expect(codes(core)).toContain("POSSIBLE_TIER_TRUNCATED");
    expect(core.surfaces!.find((surface) => surface.name === "elsewhere")!.exposure).toBe("unknown");
    // Omitted targets are not listed but stay exposed, so claims anchored to them are not lost.
    for (const id of [MOD_C, ...importers.map((mod) => mod.id)]) expect(core.exposure.get(id)).toBe("possible");
  });

  it("reports binary and unrecognized blocks as unanalyzed paths", () => {
    const diff = "diff --git a/img.png b/img.png\nindex 1111111..2222222 100644\nBinary files a/img.png and b/img.png differ\n";
    const core = run(diff);
    expect(core.files).toEqual([{ path: "img.png", status: "binary", hunks: 0 }]);
    expect(core.unresolved.find((gap) => gap.file === "img.png")).toMatchObject({ code: "CHANGED_PATH_NOT_ANALYZED", affects: "reach" });
    expect(core.complete).toBe(false);
  });

  it("is deterministic whatever the graph order", () => {
    const shuffled = graph();
    shuffled.nodes.reverse();
    shuffled.edges.reverse();
    const first = run(edit(7));
    const second = run(edit(7), { index: new GraphIndex(shuffled) });
    expect(JSON.stringify({ ...second, exposure: [...second.exposure] })).toBe(JSON.stringify({ ...first, exposure: [...first.exposure] }));
  });
});

describe("computeChangeImpact — module links the index holds no edge for", () => {
  const BARREL = "mod:src/index.ts";
  const APP = "mod:app/main.ts";
  const barrelGraph = (): GraphIndex =>
    new GraphIndex(graph({
      nodes: [node(BARREL, "module", "src/index.ts", false), node(APP, "module", "app/main.ts", false)],
      edges: [edge("imports", APP, BARREL, 1)],
    }));
  const reexport: UnindexedModuleLink = { from: "src/index.ts", kind: "reexport", line: 1, target: { path: "src/a.ts" } };

  it("lists a re-exporting barrel and the modules importing it", () => {
    const core = run(edit(4), { index: barrelGraph(), moduleLinks: [reexport] });
    const byId = new Map(core.possiblyAffected.map((target) => [target.id, target]));
    expect(byId.get(BARREL)).toMatchObject({ reason: "REEXPORTS_CHANGED_FILE", distance: 1 });
    expect(byId.get(APP)).toMatchObject({ reason: "IMPORTS_REEXPORTER_OF_CHANGED_FILE", distance: 2 });
    expect(byId.get(APP)!.via.map((step) => [step.from, step.to])).toEqual([[F, BARREL], [BARREL, APP]]);
    expect(core.complete).toBe(true);
  });

  it("reports the reach as unknown when module links were not scanned", () => {
    const core = run(edit(4), { index: barrelGraph(), moduleLinks: undefined });
    expect(ids(core.possiblyAffected)).not.toContain(APP);
    expect(core.unresolved.find((gap) => gap.code === "MODULE_LINKS_NOT_SCANNED")).toMatchObject({ scope: "run", affects: "reach" });
    expect(core.complete).toBe(false);
  });

  it("reports a non-literal load as an unresolved boundary", () => {
    const core = run(edit(4), { moduleLinks: [{ from: "src/c.ts", kind: "dynamic_import", line: 3, target: { nonLiteral: true } }] });
    expect(core.unresolved.find((gap) => gap.code === "MODULE_LOAD_NOT_RESOLVED")).toMatchObject({ file: "src/c.ts", affects: "reach" });
  });

  it("uses an unresolved package-name import only when no imports edge covers it", () => {
    const LIB = "mod:lib/x.ts";
    const link: UnindexedModuleLink = { from: "lib/x.ts", kind: "import", line: 1, target: { package: "@demo/src" } };
    const unresolved = run(edit(4), {
      index: new GraphIndex(graph({ nodes: [node(LIB, "module", "lib/x.ts", false)] })),
      moduleLinks: [link],
    });
    expect(unresolved.possiblyAffected.find((target) => target.id === LIB)).toMatchObject({ reason: "IMPORTS_PACKAGE_WITH_CHANGED_FILE" });
    const resolved = run(edit(4), {
      index: new GraphIndex(graph({ nodes: [node(LIB, "module", "lib/x.ts", false)], edges: [edge("imports", LIB, MOD_A, 1)] })),
      moduleLinks: [link],
    });
    expect(resolved.possiblyAffected.find((target) => target.id === LIB)).toMatchObject({ reason: "IMPORTS_FILE_OF_CHANGED_DECLARATION" });
  });
});

describe("computeChangeImpact — an export added to a module read whole", () => {
  // `export function Z` appended to src/a.ts (new side, line 13) after a blank line.
  const APPEND_Z = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -11,0 +12,2 @@\n+\n+export function Z(): number { return 0; }\n";
  const OUTLINE_A_WITH_Z: ImpactFileOutline = {
    ...OUTLINE_A,
    statements: [
      ...OUTLINE_A.statements,
      { kind: "function", startLine: 13, endLine: 13, leadingStartLine: 13, declaredNames: ["Z"], referencedNames: ["number"], executesOnLoad: false },
    ],
    exportedNames: ["F", "H", "Z"],
  };
  const appendZ = (overrides: Partial<ComputeChangeImpactArgs> = {}): ChangeImpactCore =>
    run(APPEND_Z, { outlines: { bound: new Map([["src/a.ts", OUTLINE_A]]), other: new Map([["src/a.ts", OUTLINE_A_WITH_Z]]) }, ...overrides });
  // The blank line before the export is a `trivia` unit.
  const added = (core: ChangeImpactCore) => core.units.filter((unit) => unit.kind !== "trivia").map((unit) => [unit.kind, unit.names, unit.behavioral]);

  it("stays inert when no module reads the file whole", () => {
    const core = appendZ();
    expect(added(core)).toEqual([["added_declaration", ["Z"], false]]);
    expect(ids(core.possiblyAffected)).toEqual([]);
  });

  it("lists the file's importers when a module reads it whole", () => {
    const core = appendZ({ wholeModuleReads: [{ from: "src/c.ts", kind: "import", line: 1, target: { path: "src/a.ts" } }] });
    expect(added(core)).toEqual([["added_declaration", ["Z"], true]]);
    expect(ids(core.possiblyAffected)).toEqual([MOD_B, MOD_C]);
    expect(core.possiblyAffected.every((target) => target.reason === "IMPORTS_FILE_OF_CHANGED_DECLARATION")).toBe(true);
    expect(codes(core)).toContain("REVERSE_REACH_NOT_MODELED");
  });

  it("takes a workspace package read whole to read every file of the package", () => {
    const core = appendZ({ wholeModuleReads: [{ from: "lib/x.ts", kind: "dynamic_import", line: 2, target: { package: "@demo/src" } }] });
    expect(added(core)).toEqual([["added_declaration", ["Z"], true]]);
  });

  it("takes any module to be read whole when module links were not scanned", () => {
    const core = appendZ({ wholeModuleReads: undefined });
    expect(added(core)).toEqual([["added_declaration", ["Z"], true]]);
  });
});
