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
  "import * as m from 'node:module'; let n; n = m; const r = n.createRequire(import.meta.url); r('./src/main.mjs');",
  "import * as m from 'node:module'; const box = { m }; const r = box.m.createRequire(import.meta.url);",
  "import * as m from 'node:module'; function forward(value) { return value; } const n = forward(m); const r = n.createRequire(import.meta.url);",
  "import { default as M } from 'node:module'; const r = M.createRequire(import.meta.url);",
  "import { 'default' as M } from 'node:module'; const r = M.createRequire(import.meta.url);",
  "import * as m from 'node:module'; const { default: M } = m; const r = M.createRequire(import.meta.url);",
  "import * as m from 'node:module'; const { 'Module': M } = m; const r = M.createRequire(import.meta.url);",
  "import * as m from 'node:module'; const { 'createRequire': make } = m; const r = make(import.meta.url);",
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
    "import * as m from 'node:module'; const n = m; export function known(name) { return n.isBuiltin(name); }",
    "import * as m from 'node:module'; const { isBuiltin } = m; export function known(name) { return isBuiltin(name); }",
    "import * as m from 'node:module'; export function known(m) { return m.isBuiltin(1); }",
    "import { default as M } from 'node:module'; export function known(name) { return M.isBuiltin(name); }",
    "import { 'default' as M } from 'node:module'; export const unused = 1;",
    "import * as m from 'node:module'; const { default: M } = m; export function known(name) { return M.isBuiltin(name); }",
    "import * as m from 'node:module'; const { 'isBuiltin': known } = m; export function query(name) { return known(name); }",
    "import { default as M } from 'node:module'; export function known(M) { return M.isBuiltin(1); }",
  ]) expect(inspectJavaScriptSource("/fixture/main.mjs", source).reasons).toEqual([]);
});
