import { expect, test } from "bun:test";
import { selectContractMatrix } from "./t00-ts7-q-semantic-contract-witnesses";
import { selectSemanticSublot } from "./t00-ts7-q-semantic-sublots";

const rows = [49, ...Array.from({ length: 86 }, (_, position) => position + 50), 145, 166].map(index => ({ index }));

test("routes each semantic family independently and excludes delivered or reserved obligations", () => {
  const a = selectSemanticSublot(rows, "a"), b = selectSemanticSublot(rows, "b"), c = selectSemanticSublot(rows, "c");
  expect(a.some(row => row.index === 50)).toBe(true);
  expect(b.some(row => row.index === 93)).toBe(true);
  expect(c.some(row => row.index === 69)).toBe(true);
  expect(a.some(row => [69, 93].includes(row.index))).toBe(false);
  expect(b.some(row => [50, 69].includes(row.index))).toBe(false);
  expect(c.some(row => [50, 93].includes(row.index))).toBe(false);
  const selected = [...a, ...b, ...c].map(row => row.index);
  expect(new Set(selected).size).toBe(selected.length);
  expect(selected.some(index => [49, 52, 61, 97, 102, 145, 166].includes(index))).toBe(false);
});

test("rejects unknown sublots, incomplete inputs and duplicate observations", () => {
  expect(() => selectSemanticSublot(rows, "d")).toThrow("INVALID_SEMANTIC_SUBLOT");
  expect(() => selectSemanticSublot(rows.filter(row => row.index !== 50), "a")).toThrow("SEMANTIC_SUBLOT_INVENTORY_INCOMPLETE");
  expect(() => selectSemanticSublot([...rows, { index: 50 }], "a")).toThrow("SEMANTIC_SUBLOT_INVENTORY_INCOMPLETE");
});


test("development sublots activate their local scenarios while default promotion remains limited to 52", () => {
  expect(selectContractMatrix(51).length).toBe(0);
  expect(selectContractMatrix(52).length).toBeGreaterThan(0);
  expect(selectContractMatrix(51, "a").some(witness => witness.idSuffix === "const-versus-let-alias")).toBe(true);
  expect(selectContractMatrix(93, "b").length).toBeGreaterThan(0);
  expect(selectContractMatrix(69, "c").length).toBeGreaterThan(0);
  expect(() => selectContractMatrix(69, "a")).toThrow("SEMANTIC_SUBLOT_OBLIGATION_MISMATCH");
});
