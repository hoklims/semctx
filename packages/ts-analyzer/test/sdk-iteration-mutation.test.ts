import { expect, test } from "bun:test";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";
const path = "/fixture/main.ts";
for (const [content, reason] of [
  ["function* iterator() { yield 1; } const value = { [Symbol.iterator]: iterator }; export function run() { return Array.from(value); }", "SDK_ITERATION_UNSUPPORTED"],
  ["function helper() { return 1; } Object.assign(Math, { random: helper }); export function run() { return Math.random(); }", "SDK_MUTATION_UNSUPPORTED"],
] as const) test(`actual SDK protocol refuses ${reason}`, () => {
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  const js = inspectJavaScriptSource("/fixture/main.js", content).reasons;
  console.info(JSON.stringify({ content, reasons, js }));
  expect(reasons).toContain(`SOURCE_${reason}`);
  expect(js).toContain(`JAVASCRIPT_${reason}`);
});

test("SDK iterable literals and ordinary data APIs preserve their boundaries", () => {
  for (const content of [
    "export function run() { return Array.from([1]); }",
    "export function run() { return Array.from('abc'); }",
    "const values = new Set([1]); export function run() { return Array.from(values); }",
    "const own = { from(value) { return 1; }, assign(target, value) { return 2; } }; export function run() { return own.from({}) === own.assign({}, {}); }",
    "export function run() { return Object.assign({}, { value: 1 }); }",
    "export function run() { return Object.assign(Math, { extra: 1 }); }",
  ]) {
    const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
    expect(reasons).not.toContain("SOURCE_SDK_ITERATION_UNSUPPORTED");
    expect(reasons).not.toContain("SOURCE_SDK_MUTATION_UNSUPPORTED");
  }
});

test("SDK aliases and helper dispatch cannot drop protocol obligations", () => {
  for (const content of [
    "function* iterator() { yield 1; } const value = { [Symbol.iterator]: iterator }; const from = Array.from; export function run() { return from(value); }",
    "function* iterator() { yield 1; } const value = { [Symbol.iterator]: iterator }; export function run() { return Array.from.call(Array, value); }",
    "function helper() { return 1; } const { assign } = Object; assign.call(Object, Math, { random: helper }); export function run() { return Math.random(); }",
    "function helper() { return 1; } const patch = { random: helper }; Object.assign(Math, patch); export function run() { return Math.random(); }",
  ]) expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]])).some(reason => /SOURCE_SDK_(ITERATION|MUTATION)_UNSUPPORTED/.test(reason))).toBe(true);
});
