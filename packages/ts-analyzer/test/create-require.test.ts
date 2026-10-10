import { expect, test } from "bun:test";
import ts from "typescript";
import { inspectJavaScriptSource, inspectNativeModuleBindings, hasNodeCreateRequireUse } from "../src/javascript-diagnostics";
for (const source of ["module.exports = require('./src/main.ts');", "module.exports = 1;", "exports.value = 1;"]) test(`round4 CommonJS synthetic symbols remain ambient: ${source}`, () => {
  expect(inspectNativeModuleBindings(ts.createSourceFile("hidden.mjs", source, ts.ScriptTarget.Latest, true)).commonJsUnsupported).toBe(true);
});
for (const source of ["const module = { exports: 0 }; module.exports = 1; export {};", "const require = value => value; const module = { exports: 0 }; module.exports = require(1); export {};"]) test(`round4 actual module and require bindings remain ordinary: ${source}`, () => {
  expect(inspectNativeModuleBindings(ts.createSourceFile("local.mjs", source, ts.ScriptTarget.Latest, true)).commonJsUnsupported).toBe(false);
});
for (const source of ["const require = value => value; require('x'); export {};", "function use(require, path) { return require(path); } export {};", "function require(...values) { return values; } require(1, 2); export {};"]) test(`round3 local require calls remain ordinary JavaScript: ${source}`, () => {
  expect(inspectJavaScriptSource("/fixture/main.mjs", source).reasons).not.toContain("JAVASCRIPT_COMMONJS_UNSUPPORTED");
});
for (const source of ["exports.legacy = 1;", "Object.assign(exports, { value: 1 });", "const target = globalThis.exports; target.value = 1;"]) test(`round2 ambient exports have CommonJS origin: ${source}`, () => {
  expect(inspectNativeModuleBindings(ts.createSourceFile("/fixture/main.ts", source, ts.ScriptTarget.Latest, true)).commonJsUnsupported).toBe(true);
});
for (const source of ["const exports = { legacy: 0 }; exports.legacy = 1;", "function update(exports) { Object.assign(exports, { value: 1 }); }"]) test(`round2 local exports keep ordinary origin: ${source}`, () => {
  expect(inspectNativeModuleBindings(ts.createSourceFile("/fixture/main.ts", source, ts.ScriptTarget.Latest, true)).commonJsUnsupported).toBe(false);
  expect(inspectJavaScriptSource("/fixture/main.mjs", source).reasons).not.toContain("JAVASCRIPT_COMMONJS_UNSUPPORTED");
});
for (const source of [
  "globalThis.eval('code');", "window.eval('code');", "const load = self.Function('code'); load();",
  "const run = eval; run('code');", "const Build = globalThis.Function; new Build('code');",
  "const { eval: run } = globalThis; run('code');", "const host = globalThis; host['Function']('code');",
  "const name = 'eval'; window[name]('code');", "const browser = window; browser['ev' + 'al']('code');",
  "const name = 'Function'; self[name]('code');", "const box = { browser: window }; box.browser.eval('code');",
  "(0, eval)('code');", "eval.call(null, 'code');", "Function('code');",
]) test(`round2 JavaScript intrinsic references remain unsupported: ${source}`, () => {
  expect(inspectJavaScriptSource("/fixture/main.mjs", source).reasons).toContain("JAVASCRIPT_DYNAMIC_EVALUATION_UNSUPPORTED");
});
for (const source of [
  "function eval(value) { return value; } eval('code');",
  "function Function(value) { return value; } new Function('code');",
  "function run(globalThis) { return globalThis.eval('code'); }",
  "function run(window) { return window.eval('code'); }", "const self = { Function: value => () => value }; self.Function('code')();",
  "const globalThis = { eval: value => value }; const run = globalThis.eval; run('code');",
  "const tools = { eval: value => value }; tools.eval('code');",
  "const window = { eval: value => value }; const name = 'eval'; window[name]('code');",
  "import { eval as run } from 'ordinary'; run('code');",
]) test(`round2 local evaluation-like bindings keep ordinary origin: ${source}`, () => {
  expect(inspectJavaScriptSource("/fixture/main.mjs", source).reasons).not.toContain("JAVASCRIPT_DYNAMIC_EVALUATION_UNSUPPORTED");
});

for (const source of [
  "const load = globalThis.require; const hidden = load('./src/main.mjs');",
  "const load = require; const hidden = load('./src/main.mjs');",
  "export const nativeModule = globalThis.module;",
  "export const nativeModule = module;",
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
  ["export const native = process.binding('contextify');", "process.binding"],
  ["const get = Reflect.get(process, 'getBuiltinModule'); const native = get('module');", "ambient-process"],
  ["export const nativeProcess = process;", "ambient-process"],
  ["const key = 'getBuiltinModule'; const native = process[key]('module');", "process.<computed>"],
  ["export const hidden = process.mainModule.require('./src/main.mjs');", "process.mainModule"],
  ["export const globals = globalThis;", "ambient-global"],
  ["const p = Reflect.get(globalThis, 'process'); const M = p.getBuiltinModule('module');", "ambient-global"],
  ["const M = globalThis.globalThis.process.getBuiltinModule('module');", "process.getBuiltinModule"],
  ["const M = globalThis.global.process.getBuiltinModule('module');", "process.getBuiltinModule"],
  ["const M = global.globalThis.process.getBuiltinModule('module');", "process.getBuiltinModule"],
  ["const M = global.global.process.getBuiltinModule('module');", "process.getBuiltinModule"],
  ["const g = globalThis['global']['globalThis']; const { getBuiltinModule: get } = g['process']; const M = get('module');", "process.getBuiltinModule"],
  ["const p = global['process']; const M = p.getBuiltinModule('module');", "process.getBuiltinModule"],
  ["const g = globalThis; const p = g['process']; const M = p.getBuiltinModule('module');", "process.getBuiltinModule"],
  ["const M = globalThis.process.getBuiltinModule('module'); const r = M.createRequire(import.meta.url);", "process.getBuiltinModule"],
  ["const p = globalThis['process']; const get = p['getBuiltinModule']; const M = get('module');", "process.getBuiltinModule"],
  ["const { getBuiltinModule: get } = globalThis.process; const M = get('module');", "process.getBuiltinModule"],
  ["const { process: p } = globalThis; const M = p.getBuiltinModule('module');", "process.getBuiltinModule"],
  ["const { default: p } = globalThis.process; const M = p.getBuiltinModule('module');", "process.getBuiltinModule"],
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
    "const globalThis = { process: { getBuiltinModule(value) { return value; } } }; export const ordinary = globalThis.process.getBuiltinModule(1);",
    "export function ordinary(globalThis) { return globalThis.process.getBuiltinModule(1); }",
    "const globalThis = { process: { getBuiltinModule(value) { return value; } } }; const { process: p } = globalThis; export const ordinary = p.getBuiltinModule(1);",
    "export const ordinary = globalThis.process.platform;",
    "const global = { process: { getBuiltinModule(value) { return value; } } }; export const ordinary = global.process.getBuiltinModule(1);",
    "export function ordinary(global) { return global.process.getBuiltinModule(1); }",
    "const globalThis = { global: { process: { getBuiltinModule(value) { return value; } } } }; export const ordinary = globalThis.global.process.getBuiltinModule(1);",
    "export function ordinary(global) { return global.globalThis.process.getBuiltinModule(1); }",
    "export const ordinary = globalThis.console;",
    "export const ordinary = process.env; export function cwd() { return process.cwd(); } export const args = process.argv;",
    "const process = { mainModule: { require(value) { return value; } } }; export const ordinary = process.mainModule.require(1);",
    "const process = { getBuiltinModule(value) { return value; } }; const get = Reflect.get(process, 'getBuiltinModule'); export const ordinary = get(1);",
    "export const streams = [process.stdout, process.stderr]; export const runtime = process.versions; export const executable = process.execPath; process.exitCode = 0; export function exit() { process.exit(0); }",
    "import { binding } from 'node:process'; export const unused = 1;",
    "const require = (value) => value; const load = require; export const ordinary = load(1);",
    "const module = { isBuiltin(value) { return value; } }; export const ordinary = module.isBuiltin(1);",
    "const globalThis = { require(value) { return value; } }; const load = globalThis.require; export const ordinary = load(1);",
    "const process = { binding(value) { return value; } }; export const ordinary = process.binding(1);",
  ]) expect(inspectJavaScriptSource("/fixture/main.mjs", source).reasons).toEqual([]);
});
test("type-only native bindings are inert and the compatibility predicate makes no opaque-member execution claim", () => {
  const typeOnly = ts.createSourceFile("/fixture/main.ts", "import type { _resolveFilename as Native } from 'node:module'; export type Alias = Native;", ts.ScriptTarget.Latest, true);
  expect(inspectNativeModuleBindings(typeOnly)).toEqual({ commonJsUnsupported: false, unmodeledMembers: [] });
  const processTypeOnly = ts.createSourceFile("/fixture/main.ts", "import type { default as p } from 'node:process'; export type Alias = typeof p.getBuiltinModule; export type { getBuiltinModule } from 'node:process';", ts.ScriptTarget.Latest, true);
  expect(inspectNativeModuleBindings(processTypeOnly)).toEqual({ commonJsUnsupported: false, unmodeledMembers: [] });
  const opaqueProcessTypeOnly = ts.createSourceFile("/fixture/main.ts", "import type { binding } from 'node:process'; export type Alias = typeof binding;", ts.ScriptTarget.Latest, true);
  expect(inspectNativeModuleBindings(opaqueProcessTypeOnly)).toEqual({ commonJsUnsupported: false, unmodeledMembers: [] });
  const globalProcessTypeOnly = ts.createSourceFile("/fixture/main.ts", "export type Getter = typeof globalThis.process.getBuiltinModule;", ts.ScriptTarget.Latest, true);
  expect(inspectNativeModuleBindings(globalProcessTypeOnly)).toEqual({ commonJsUnsupported: false, unmodeledMembers: [] });
  const unknown = ts.createSourceFile("/fixture/main.mjs", "import M from 'node:module'; const loader = M.prototype.require;", ts.ScriptTarget.Latest, true);
  expect(hasNodeCreateRequireUse(unknown)).toBe(false);
  expect(inspectNativeModuleBindings(unknown)).toEqual({ commonJsUnsupported: false, unmodeledMembers: ["prototype"] });
});
