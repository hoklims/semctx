import { expect, test } from "bun:test";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";
const path = "/fixture/main.ts";
test("typed string annotation cannot hide a real internal iterator origin", () => {
  const content = "const iterable = { *[Symbol.iterator]() { yield 1; } }; const text: string = iterable as unknown as string; export function start() { return [...text]; }";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ content, reasons }));
  expect(reasons).toContain("SOURCE_ITERATION_UNSUPPORTED");
});
test("type-only Reflect query is not a reflective runtime invocation", () => {
  const content = "export type Invocation = typeof Reflect.apply;";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ content, reasons }));
  expect(reasons).not.toContain("SOURCE_REFLECT_INVOCATION_UNSUPPORTED");
});
for (const [content, reason] of [
  ["function helper() { return 1; } export function start() { return Reflect.apply(helper, null, []); }", "REFLECT_INVOCATION_UNSUPPORTED"],
  ["const iterable = { *[Symbol.iterator]() { yield 1; } }; export function start() { for (const value of iterable) { return value; } }", "ITERATION_UNSUPPORTED"],
] as const) test(`direct ${reason} refuses unmodeled invocation`, () => {
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  const js = inspectJavaScriptSource("/fixture/main.js", content).reasons;
  console.info(JSON.stringify({ content, reasons, js }));
  expect(reasons).toContain(`SOURCE_${reason}`);
  expect(js).toContain(`JAVASCRIPT_${reason}`);
});
for (const content of [
  "function helper() {} const invoke = Reflect.apply; export function start() { return invoke(helper, null, []); }",
  "function Helper() {} const { construct: create } = Reflect; const make = create; export function start() { return make(Helper, []); }",
  "function helper() {} export function start() { return Reflect.apply.call(null, helper, null, []); }",
  "export function start(value: unknown) { return [...value]; }",
  "export function start(values: number[]) { for (const value of values) return value; }",
  "export async function start(values: unknown) { for await (const value of values) return value; }",
  "const iterable = { *[Symbol.iterator]() { yield 1; } }; export function start() { return Math.max(...iterable); }",
]) test(`unproven reflection or iteration refuses ${content}`, () => {
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  expect(reasons.some(reason => /SOURCE_(REFLECT_INVOCATION|ITERATION)_UNSUPPORTED/.test(reason))).toBe(true);
});
test("known intrinsic values, object spread and ordinary Reflect homonyms preserve their domain", () => {
  for (const content of [
    "const values = [1, 2]; export function start() { return [...values]; }",
    "export function start() { for (const value of 'abc') return value; }",
    "export function start() { return [...new Map()]; }",
    "export function start() { return {...{value: 1}}; }",
    "const Reflect = { apply(value: number) { return value; } }; export function start() { return Reflect.apply(1); }",
    "export function start() { return Reflect.get({value: 1}, 'value'); }",
  ]) {
    const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
    expect(reasons).not.toContain("SOURCE_REFLECT_INVOCATION_UNSUPPORTED");
    expect(reasons).not.toContain("SOURCE_ITERATION_UNSUPPORTED");
  }
});
