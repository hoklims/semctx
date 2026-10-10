import { expect, test } from "bun:test";
import { inspectJavaScriptSource } from "../src/javascript-diagnostics";

for (const source of [
  "import { createRequire as make } from 'node:module'; const load = make(import.meta.url);",
  "import * as nodeModule from 'module'; const factory = nodeModule.createRequire; const load = factory(import.meta.url);",
  "import nodeModule from 'node:module'; const { createRequire: make } = nodeModule; const load = make(import.meta.url);",
  "const { createRequire: make } = await import('node:module'); const load = make(import.meta.url);",
  "const load = (await import('node:module')).createRequire(import.meta.url);",
  "export { createRequire as make } from 'node:module';",
  "export * from 'node:module';",
  "export { default as Module } from 'node:module';",
  "import { Module } from 'node:module'; const load = Module.createRequire(import.meta.url);",
  "import nodeModule from 'node:module'; export default nodeModule;",
  "import nodeModule from 'node:module'; export { nodeModule as Module };",
  "import nodeModule from 'node:module'; export const Module = nodeModule;",
]) test("selected JavaScript diagnoses Node CommonJS loader bindings", () => {
  expect(inspectJavaScriptSource("/fixture/main.mjs", source).reasons).toContain("JAVASCRIPT_COMMONJS_UNSUPPORTED");
});
test("ordinary Node APIs and unrelated factories remain ordinary static JavaScript", () => {
  for (const source of [
    "import * as nodeModule from 'node:module'; export function known(name) { return nodeModule.isBuiltin(name); }",
    "function createRequire(value) { return value; } export function known() { return createRequire(1); }",
    "const opaque = { createRequire(value) { return value; } }; export function known() { return opaque.createRequire(1); }",
    "import { createRequire } from 'node:module'; export const unusedFactoryImport = 1;",
    "import { createRequire as make } from 'node:module'; export function known(make) { return make(1); }",
    "import { createRequire } from 'node:module'; const opaque = { createRequire(value) { return value; } }; export function known() { return opaque.createRequire(1); }",
    "export { isBuiltin } from 'node:module';",
  ]) expect(inspectJavaScriptSource("/fixture/main.mjs", source).reasons).toEqual([]);
});
