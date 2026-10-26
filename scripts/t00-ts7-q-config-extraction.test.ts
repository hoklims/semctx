import { expect, test } from "bun:test";
import { graphProjection, workerProjection, extractionMatches } from "./t00-ts7-q-config-extraction";

test("worker projection preserves complete emitted facts and sanitizes external targets", () => {
  const input = { modules: ["leaf.ts", "main.ts"], symbols: [{ relPath: "leaf.ts", name: "leaf" }, { relPath: "main.ts", name: "main" }], imports: [{ fromRelPath: "main.ts", moduleSpecifier: "foreign", names: ["external"], line: 1, resolvedRelPath: "../foreign.ts", bindingTargets: [{ relPath: "../foreign.ts" }] }], calls: [{ callerRelPath: "main.ts", callerSymbolPath: "main", calleeName: "external", calleeRelPath: "/foreign.ts", calleeSymbolPath: "external", calleeUnmodeledReason: "x", line: 2 }] };
  expect(workerProjection(input, ["main.ts"])).toEqual({ modules: ["main.ts"], symbols: [{ relPath: "main.ts", name: "main" }], imports: [{ fromRelPath: "main.ts", moduleSpecifier: "foreign", names: ["external"], line: 1 }], calls: [{ callerRelPath: "main.ts", callerSymbolPath: "main", calleeName: "external", calleeSymbolPath: "external", line: 2 }] });
  expect(workerProjection({ ...input, imports: [{ ...input.imports[0], resolvedRelPath: "leaf.ts" }] }, ["main.ts"]).imports[0]).toHaveProperty("resolvedRelPath", "leaf.ts");
});

test("contract graph connects selected roots through loaded nonroots and cycles", () => {
  expect(graphProjection(["a.ts", "bridge.ts", "b.ts", "isolated.ts", "globals.d.ts", "node_modules/pkg/index.d.ts"], ["a.ts", "b.ts", "isolated.ts", "globals.d.ts"], [{ fromRelPath: "a.ts", moduleSpecifier: "./bridge", resolvedRelPath: "bridge.ts" }, { fromRelPath: "b.ts", moduleSpecifier: "./bridge", resolvedRelPath: "bridge.ts" }, { fromRelPath: "bridge.ts", moduleSpecifier: "./a", resolvedRelPath: "a.ts" }])).toEqual({ loadedRepositorySources: ["a.ts", "b.ts", "bridge.ts", "globals.d.ts", "isolated.ts"], selectedRoots: ["a.ts", "b.ts", "isolated.ts"], dependencyComponents: [["a.ts", "b.ts"], ["isolated.ts"]], resolvedEdges: [{ from: "a.ts", specifier: "./bridge", to: "bridge.ts" }, { from: "b.ts", specifier: "./bridge", to: "bridge.ts" }, { from: "bridge.ts", specifier: "./a", to: "a.ts" }] });
});

test("exact oracle comparison rejects dropped facts, order changes, emptiness and unsupported execution", () => {
  const expected = { modules: ["z.ts", "a.ts"], symbols: [{ name: "z" }], imports: [{ moduleSpecifier: "./z" }], calls: [{ calleeName: "z" }] };
  expect(extractionMatches({ executed: true, unsupported: [], extraction: expected }, expected)).toBe(true);
  for (const extraction of [{ ...expected, modules: ["a.ts", "z.ts"] }, { ...expected, calls: [] }, { modules: [], symbols: [], imports: [], calls: [] }]) expect(extractionMatches({ executed: true, unsupported: [], extraction }, expected)).toBe(false);
  expect(extractionMatches({ executed: false, unsupported: [], extraction: expected }, expected)).toBe(false);
  expect(extractionMatches({ executed: true, unsupported: ["failure"], extraction: expected }, expected)).toBe(false);
});

import { runExtractionWorkers } from "./t00-ts7-q-config-extraction";
import type { CampaignContext } from "./t00-ts7-q-config-campaign";

test("a missing candidate extraction oracle leaves every cumulative property unrun", async () => {
  const ctx: CampaignContext = { producer: "producer", helper: "helper", sdk: "sdk", oracle: "oracle", out: "/tmp/uncreated-extraction-control", platform: "macos", run: async () => { throw Error("must not execute an unbound oracle"); } };
  const results = await runExtractionWorkers(ctx, [{ index: 239, id: "worker", properties: ["sets", "malformed", "context", "parent"] }, { index: 193, id: "order", properties: ["exact emitted modules and same extraction"] }]);
  expect(results.map(item => item.status)).toEqual(["not_qualified", "not_qualified"]);
  expect(results.flatMap(item => item.properties).every(item => item.status === "not_qualified")).toBe(true);
  expect(results.flatMap(item => item.evidence)).toEqual([]);
});

test("graph projection rejects selected roots absent from the loaded repository graph", () => {
  for (const root of ["missing.ts", "../outside.ts", "node_modules/pkg/index.ts"]) expect(() => graphProjection(["a.ts", "node_modules/pkg/index.ts"], [root], [])).toThrow("outside loaded repository graph");
});

test("module declaration extensions remain loaded context and are excluded from selected extraction roots", () => {
  expect(graphProjection(["main.ts", "ambient.d.mts", "common.d.cts"], ["main.ts", "ambient.d.mts", "common.d.cts"], [])).toEqual({ loadedRepositorySources: ["ambient.d.mts", "common.d.cts", "main.ts"], selectedRoots: ["main.ts"], dependencyComponents: [["main.ts"]], resolvedEdges: [] });
});

import { contextRootChangesCallTarget } from "./t00-ts7-q-config-extraction";

test("retained context needs a target that disappears when its independent global root is omitted", () => {
  const known = [{ callerRelPath: "main.ts", calleeName: "contextHelper", calleeRelPath: "context.ts", calleeSymbolPath: "contextHelper", line: 2 }];
  const unknown = [{ callerRelPath: "main.ts", calleeName: "contextHelper", line: 2 }];
  expect(contextRootChangesCallTarget(known, unknown)).toBe(true);
  expect(contextRootChangesCallTarget(known, known)).toBe(false);
  expect(contextRootChangesCallTarget(unknown, unknown)).toBe(false);
  expect(contextRootChangesCallTarget([], [])).toBe(false);
});
