import { expect, test } from "bun:test";
import ts from "typescript";
import { inspectJavaScriptSource, inspectNativeModuleBindings, hasNodeCreateRequireUse } from "../src/javascript-diagnostics";

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
  "import M from 'node:module'; const value = M._load('./src/main.mjs', undefined, false);",
  "import { _load as nativeLoad } from 'module'; const value = nativeLoad('./src/main.mjs', undefined, false);",
]) test("selected JavaScript diagnoses Node CommonJS loader bindings", () => {
  expect(inspectJavaScriptSource("/fixture/main.mjs", source).reasons).toContain("JAVASCRIPT_COMMONJS_UNSUPPORTED");
});
for (const [source, member] of [
  ["import { default as p } from 'node:process'; const M = p.getBuiltinModule('module');", "process.getBuiltinModule"],
  ["import { 'default' as p } from 'process'; const M = p.getBuiltinModule('module');", "process.getBuiltinModule"],
  ["const { 'getBuiltinModule': get } = process; const M = get('module');", "process.getBuiltinModule"],
  ["export { getBuiltinModule as get } from 'node:process';", "process.getBuiltinModule"],
  ["const { getBuiltinModule: get } = await import('node:process'); const M = get('module');", "process.getBuiltinModule"],
  ["const p = await import('process'); const M = p.getBuiltinModule('module');", "process.getBuiltinModule"],
  ["import M from 'node:module'; const loader = M.prototype.require;", "prototype"],
  ["import { _resolveFilename as resolveName } from 'node:module'; const value = resolveName('./file');", "_resolveFilename"],
  ["const get = process.getBuiltinModule; const M = get('module'); const r = M.createRequire(import.meta.url);", "process.getBuiltinModule"],
  ["import P from 'node:process'; const M = P.getBuiltinModule('module');", "process.getBuiltinModule"],
  ["import { getBuiltinModule as get } from 'process'; const M = get('module');", "process.getBuiltinModule"],
] as const) test("unknown used native members remain explicitly unmodeled", () => {
  const reasons = inspectJavaScriptSource("/fixture/main.mjs", source).reasons;
  expect(reasons).toContain(`JAVASCRIPT_NATIVE_MODULE_MEMBER_UNSUPPORTED:${member}`);
  expect(reasons).not.toContain("JAVASCRIPT_COMMONJS_UNSUPPORTED");
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
    "import { builtinModules } from 'node:module'; export const known = builtinModules;",
    "import { _resolveFilename } from 'node:module'; export const unused = 1;",
    "import { _resolveFilename as resolveName } from 'node:module'; export function known(resolveName) { return resolveName(1); }",
    "const process = { getBuiltinModule(value) { return value; } }; export function known() { return process.getBuiltinModule(1); }",
    "export function known(process) { return process.getBuiltinModule(1); }",
    "import P from 'node:process'; export function known() { return P.platform; }",
    "import { getBuiltinModule as get } from 'node:process'; export const unused = 1;",
    "import { default as p } from 'node:process'; export const ordinary = p.platform;",
    "const { platform } = process; export const ordinary = platform;",
    "export { platform } from 'node:process';",
    "const p = await import('node:process'); export const ordinary = p.platform;",
    "const process = { getBuiltinModule(value) { return value; } }; const { getBuiltinModule: get } = process; export const ordinary = get(1);",
    "import { default as p } from 'node:process'; export function ordinary(p) { return p.getBuiltinModule(1); }",
  ]) expect(inspectJavaScriptSource("/fixture/main.mjs", source).reasons).toEqual([]);
});
test("type-only native bindings are inert and the compatibility predicate makes no opaque-member execution claim", () => {
  const typeOnly = ts.createSourceFile("/fixture/main.ts", "import type { _resolveFilename as Native } from 'node:module'; export type Alias = Native;", ts.ScriptTarget.Latest, true);
  expect(inspectNativeModuleBindings(typeOnly)).toEqual({ commonJsUnsupported: false, unmodeledMembers: [] });
  const processTypeOnly = ts.createSourceFile("/fixture/main.ts", "import type { default as p } from 'node:process'; export type Alias = typeof p.getBuiltinModule; export type { getBuiltinModule } from 'node:process';", ts.ScriptTarget.Latest, true);
  expect(inspectNativeModuleBindings(processTypeOnly)).toEqual({ commonJsUnsupported: false, unmodeledMembers: [] });
  const unknown = ts.createSourceFile("/fixture/main.mjs", "import M from 'node:module'; const loader = M.prototype.require;", ts.ScriptTarget.Latest, true);
  expect(hasNodeCreateRequireUse(unknown)).toBe(false);
  expect(inspectNativeModuleBindings(unknown)).toEqual({ commonJsUnsupported: false, unmodeledMembers: ["prototype"] });
});
