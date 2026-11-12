import { expect, test } from "bun:test";
import { combineCampaignCases, comparisonMatches, projectComparison } from "./t00-ts7-q-syntax-checker-cases.js";
import type { CampaignCase } from "./t00-ts7-q-syntax-types.js";

const witness = (name: string, indices: number[], gaps?: Record<number, string>): CampaignCase => ({
  name, indices, mode: "raw", request: {}, oracleInput: {}, checks: [], ...(gaps ? { gaps } : {}),
});

test("checker replacement removes obsolete evidence only for its owned obligations", () => {
  const result = combineCampaignCases([
    { cases: [witness("old", [176, 206], { 176: "checker missing", 206: "private boundary" })],
      gaps: { 176: "old gap" }, propertyWitnesses: { 176: { scope: ["old"] } } },
    { cases: [witness("checker", [176])], replacesIndices: [176],
      propertyWitnesses: { 176: { scope: ["checker"] } } },
  ]);
  expect(result.cases.map(item => [item.name, item.indices])).toEqual([["old", [206]], ["checker", [176]]]);
  expect(result.gaps).toEqual({ 206: "private boundary" });
  expect(result.propertyWitnesses).toEqual({ 176: { scope: ["checker"] } });
});

test("incomplete replacement retains its explicit gap and rejects an unexercised claim", () => {
  expect(combineCampaignCases([{ cases: [witness("partial", [187], { 187: "mode missing" })],
    replacesIndices: [187], propertyWitnesses: {} }]).gaps).toEqual({ 187: "mode missing" });
  expect(() => combineCampaignCases([{ cases: [], replacesIndices: [187], propertyWitnesses: {} }]))
    .toThrow("replacement has no witness");
});

test("native reasons preserve every native refusal and distinguish unrelated refusals", () => {
  expect(projectComparison([
    "SOURCE_GLOBAL_SCRIPT_UNSUPPORTED", "JAVASCRIPT_COMMONJS_UNSUPPORTED",
    "JAVASCRIPT_NATIVE_MODULE_MEMBER_UNSUPPORTED:createRequireExtra",
    "JAVASCRIPT_DYNAMIC_EVALUATION_UNSUPPORTED", "JAVASCRIPT_DYNAMIC_CALL_UNSUPPORTED",
  ], "native-reasons")).toEqual([
    "JAVASCRIPT_COMMONJS_UNSUPPORTED", "JAVASCRIPT_NATIVE_MODULE_MEMBER_UNSUPPORTED:createRequireExtra",
    "JAVASCRIPT_DYNAMIC_EVALUATION_UNSUPPORTED",
  ]);
  expect(() => projectComparison(null, "native-reasons")).toThrow();
  expect(() => projectComparison([null], "native-reasons")).toThrow();
  expect(projectComparison([{ digest: "varying", kind: "function" }], "outline-statements-without-digest"))
    .toEqual([{ kind: "function" }]);
});

test("logical calls retain endpoint coordinates and reject dangling or ambiguous graph references", () => {
  const graph = {
    nodes: [{ id: "caller", kind: "function", filePath: "main.ts" }, { id: "callee", kind: "function", filePath: "api.ts" }],
    symbols: [{ id: "caller", name: "run", scope: ["Service"] }, { id: "callee", name: "helper", scope: [] }],
    edges: [{ kind: "calls", from: "caller", to: "callee" }, { kind: "imports", from: "caller", to: "callee" }],
  };
  expect(projectComparison(graph, "logical-call-edges")).toEqual([
    { kind: "calls", from: { path: "main.ts", symbol_path: "Service.run" }, to: { path: "api.ts", symbol_path: "helper" } },
  ]);
  expect(projectComparison({ ...graph, edges: [] }, "logical-call-edges")).toEqual([]);
  for (const invalid of [
    { ...graph, nodes: [] }, { ...graph, symbols: [] },
    { ...graph, nodes: [...graph.nodes, graph.nodes[0]] },
    { ...graph, symbols: [...graph.symbols, graph.symbols[1]] },
    { ...graph, symbols: [{ ...graph.symbols[0], scope: [7] }, graph.symbols[1]] },
    { ...graph, edges: [{ kind: "calls", from: "caller", to: "missing" }] },
    { ...graph, edges: null },
  ]) expect(() => projectComparison(invalid, "logical-call-edges")).toThrow();
});

test("unordered extraction compares full multisets while retaining nested order and field presence", () => {
  const first = { name: "first", scope: ["Outer", "Inner"], bindingTargets: [{ symbolPath: "one" }, { symbolPath: "two" }] };
  const second = { name: "second", scope: [] };
  expect(comparisonMatches([first, second], [second, first], "unordered")).toBe(true);
  expect(comparisonMatches([first, second], [second, first])).toBe(false);
  expect(comparisonMatches([first, first], [first, second], "unordered")).toBe(false);
  expect(comparisonMatches([first], [first, first], "unordered")).toBe(false);
  expect(comparisonMatches([first], [{ ...first, scope: ["Inner", "Outer"] }], "unordered")).toBe(false);
  expect(comparisonMatches([first], [{ ...first, bindingTargets: [...first.bindingTargets].reverse() }], "unordered")).toBe(false);
  expect(comparisonMatches([first], [{ ...first, runtimeUsed: false }], "unordered")).toBe(false);
  expect(() => comparisonMatches(null, [], "unordered")).toThrow();
});

test("campaign projection preserves triage relations and predicates alongside checker comparisons", () => {
  expect(projectComparison([{ digest: "same" }, { digest: "same" }], "outline-digest-relation")).toBe(true);
  expect(projectComparison([{ digest: "first" }, { digest: "second" }], "outline-digest-relation")).toBe(false);
  expect(projectComparison(["SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"], "opaque-callback-reason")).toBe(true);
  expect(projectComparison([], "opaque-callback-reason")).toBe(false);
  expect(projectComparison(["SOURCE_CONSTRUCTION_UNSUPPORTED"], "construction-reason")).toBe(true);
  expect(projectComparison([], "construction-reason")).toBe(false);
  expect(projectComparison([{ kind: "calls" }, { kind: "imports" }], "call-edge-count")).toBe(1);
  expect(projectComparison([], "call-edge-count")).toBe(0);
  expect(() => projectComparison([{ digest: "only" }], "outline-digest-relation")).toThrow();
  expect(() => projectComparison([{}], "call-edge-count")).toThrow();
});
