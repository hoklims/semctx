import { expect, test } from "bun:test";
import { resolveContractQueries } from "./t00-ts7-q-semantic-contract-queries";

const query = { id: "member", file: "/project/main.ts", route: { anchor: { path: "/project/main.ts", kind: "Identifier", start: 0, end: 5 }, steps: [{ op: "type" }] }, operation: "properties" };
const ready = { status: "projected" as const, gaps: [] };
const needs = { status: "unsupported" as const, gaps: ["NATIVE_PROPERTIES_MISSING"], queries: [query] };

test("requested native facts are recaptured and projected before completing", () => {
  const result = resolveContractQueries({ phase: "initial" }, oracle => (oracle as { phase: string }).phase === "expanded" ? ready : needs, queries => {
    expect(queries).toEqual([query]);
    return { phase: "expanded" };
  });
  expect(result.projection.status).toBe("projected");
  expect(result.rounds).toBe(2);
  expect(result.oracle).toEqual({ phase: "expanded" });
});

test("unchanged missing facts cannot loop or grant success", () => {
  const result = resolveContractQueries({}, () => needs, () => ({}));
  expect(result.projection.status).toBe("unsupported");
  expect(result.projection.gaps).toContain("NATIVE_QUERY_NO_PROGRESS:member");
});

test("a reused query identity with a different operation is refused", () => {
  const result = resolveContractQueries(0, oracle => oracle === 0 ? needs : { ...needs, queries: [{ ...query, operation: "symbolType" }] }, () => 1);
  expect(result.projection.status).toBe("unsupported");
  expect(result.projection.gaps).toContain("NATIVE_QUERY_ID_CONFLICT:member");
});

test("missing query identity and exhaustion remain incomplete", () => {
  const invalid = resolveContractQueries({}, () => ({ ...needs, queries: [{}] }), () => { throw Error("must not run"); });
  expect(invalid.projection.gaps).toContain("NATIVE_QUERY_INVALID_ID");
  const exhausted = resolveContractQueries(0, oracle => ({ ...needs, queries: [{ ...query, id: String(oracle) }] }), (_queries, round) => round);
  expect(exhausted.projection.status).toBe("unsupported");
  expect(exhausted.projection.gaps).toContain("NATIVE_QUERY_ROUND_LIMIT:64");
});
