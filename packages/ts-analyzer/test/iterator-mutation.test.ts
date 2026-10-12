import { expect, test } from "bun:test";
import ts from "typescript";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";
const path = "/fixture/main.ts";
for (const content of [
  "function helper() { return { next() { return { done: true, value: 1 }; } }; } const values = [1]; values[Symbol.iterator] = helper; export function start() { return [...values]; }",
  "function helper() { return { next() { return { done: true, value: 1 }; } }; } const values = [1]; const key = Symbol.iterator; const alias = key; values[alias] = helper; export function start() { for (const value of values) { return value; } }",
  "function helper() { return { next() { return { done: true, value: 1 }; } }; } const values = [1]; values[Symbol.asyncIterator] = helper; export async function start() { for await (const value of values) { break; } }",
  "function helper() { return { next() { return { done: true, value: 1 }; } }; } const values = [1]; const { iterator: key } = Symbol; values[key] = helper; export function start() { const [value] = values; return value; }",
  "function helper() { return { next() { return { done: true, value: 1 }; } }; } const values = [1]; values[Symbol.iterator] = helper; export function* start() { yield* values; }",
]) test(`iterator protocol mutation refuses ${content}`, () => {
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  const js = inspectJavaScriptSource("/fixture/main.js", content).reasons;
  console.info(JSON.stringify({ content, reasons, js }));
  expect(reasons).toContain("SOURCE_ITERATOR_MUTATION_UNSUPPORTED");
  expect(js).toContain("JAVASCRIPT_ITERATOR_MUTATION_UNSUPPORTED");
});
test("unmodified array/string origins and own string iterator properties remain distinct", () => {
  for (const content of [
    "const values = [1]; export function start() { return [...values]; }",
    "const values = [1]; export function start() { const [value] = values; return value; }",
    "const values = [1]; export function* start() { yield* values; }",
    "const text = 'abc'; export function start() { return [...text]; }",
    "const values = new Set([1]); export function start() { return [...values]; }",
    "function helper() { return 1; } const values = [1]; values['iterator'] = helper; export function start() { return [...values]; }",
    "function helper() { return 1; } const Symbol = { iterator: 'iterator' }; const values = [1]; values[Symbol.iterator] = helper; export function start() { return 1; }",
  ]) expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).not.toContain("SOURCE_ITERATOR_MUTATION_UNSUPPORTED");
});
test("type-only references and ordinary TypeScript without a snapshot retain their boundary", () => {
  const typeOnly = "export type Key = typeof Symbol.iterator;";
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, typeOnly]]))).not.toContain("SOURCE_ITERATOR_MUTATION_UNSUPPORTED");
  const content = "function helper() { return { next() { return { done: true, value: 1 }; } }; } const values = [1]; values[Symbol.iterator] = helper; export function start() { return [...values]; }";
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  expect(inspectModuleConfiguration(path, "/fixture", undefined, source)).not.toContain("SOURCE_ITERATOR_MUTATION_UNSUPPORTED");
});
