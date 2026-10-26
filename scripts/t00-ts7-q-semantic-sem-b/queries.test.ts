import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { batchSdkSyntax } from "./queries";
import type { ContractProjection } from "../t00-ts7-q-semantic-contract-projector";

const anchor = (start: number, path = "/sdk/lib/lib.es2015.promise.d.ts") => ({ end: start + 1, kind: "Identifier", path, start });
const query = (start: number) => {
  const payload = { file: "/project/main.ts", route: { anchor: anchor(start), steps: [] }, operation: "node" as const };
  return { id: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), ...payload };
};
const projection = (): ContractProjection => ({ status: "unsupported", reasons: [], gaps: ["NATIVE_QUERY_REQUIRED"], sites: [], branches: [], helperResults: [], queries: [query(1)] });
const oracle = (children: unknown[]) => ({ files: [{ path: "/project/main.ts", factsGraph: { nodes: [{ ...anchor(0), children }] } }] });

test("batches uncaptured native siblings without changing the outstanding query or verdict", () => {
  const pending = projection();
  const actual = batchSdkSyntax(pending, oracle([{ anchor: anchor(1) }, { anchor: anchor(2) }]), "/project/main.ts");
  expect(actual.queries).toEqual([query(1), query(2)]);
  expect(actual.status).toBe("unsupported");
  expect(actual.gaps).toEqual(pending.gaps);
  expect(pending.queries).toEqual([query(1)]);
});

test("does not query captured nodes, foreign files or malformed anchors", () => {
  const native = oracle([{ anchor: anchor(2) }, { anchor: anchor(3, "/project/main.ts") }, { anchor: anchor(4, "/sdk/lib/lib.dom.d.ts") }, { anchor: { ...anchor(5), start: -1 } }]);
  native.files[0]!.factsGraph.nodes.push({ ...anchor(2), children: [] });
  expect(batchSdkSyntax(projection(), native, "/project/main.ts").queries).toEqual([query(1)]);
  expect(batchSdkSyntax(projection(), native, "/project/other.ts").queries).toEqual([query(1)]);
});

test("keeps speculative requests bounded and preserves query identity across rounds", () => {
  const native = oracle(Array.from({ length: 100 }, (_, index) => ({ anchor: anchor(index + 2) })));
  const actual = batchSdkSyntax(projection(), native, "/project/main.ts");
  expect(actual.queries).toHaveLength(65);
  expect(actual.queries?.slice(1)).toEqual(Array.from({ length: 64 }, (_, index) => query(index + 2)));
  expect(batchSdkSyntax({ ...projection(), status: "projected", queries: undefined }, native, "/project/main.ts").queries).toBeUndefined();
});
