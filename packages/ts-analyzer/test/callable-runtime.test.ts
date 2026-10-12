import { expect, test } from "bun:test";
import ts from "typescript";
import { inspectJavaScriptSource, inspectModuleConfiguration, inspectNativeModuleBindings, extractTypeScript } from "../src";

const path = "/fixture/main.ts";
const inspect = (content: string) => inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
for (const initializer of ["class {}", "true ? (() => 1) : (() => 2)", "(() => 1)", "original", "make()"])
  test(`callable identifier initializer lacks extraction coordinate: ${initializer}`, () => {
    const content = `const original = () => 1; function make() { return original; } export const helper = ${initializer};`;
    expect(extractTypeScript([path], "/fixture", new Map([[path, content]])).symbols.some(symbol => symbol.name === "helper")).toBe(false);
    expect(inspect(content)).toContain("SOURCE_CALLABLE_EXPORT_UNSUPPORTED");
  });
for (const access of ["(() => {}).constructor", "helper.constructor", "alias.constructor", "(() => {}).constructor.call(null, 'return 1').call(null)"])
  test(`intrinsic callable constructor route refuses ${access}`, () => {
    const content = `function helper() {} const alias = helper; export function read() { return ${access}; }`;
    expect(inspect(content)).toContain("SOURCE_DYNAMIC_EVALUATION_UNSUPPORTED");
    expect(inspectJavaScriptSource("/fixture/main.js", content).reasons).toContain("JAVASCRIPT_DYNAMIC_EVALUATION_UNSUPPORTED");
  });
for (const body of ["import.meta.require('./hidden.js')", "(() => { const meta = import.meta; return meta.require('./hidden.js'); })()", "(() => { const { require: loader } = import.meta; return loader('./hidden.js'); })()"])
  test(`Bun metadata loader is not a complete static module link: ${body}`, () => {
    const content = `export function read() { return ${body}; }`;
    expect(inspectNativeModuleBindings(ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true)).commonJsUnsupported).toBe(true);
    expect(inspectJavaScriptSource("/fixture/main.js", content).reasons).toContain("JAVASCRIPT_COMMONJS_UNSUPPORTED");
  });
test("modeled identifier exports, own properties and ordinary metadata remain eligible", () => {
  const content = "export const helper = () => 1; export const fn = function () { return 2; }; export const value = 1; const own = { constructor() { return 1; }, call() { return 2; } }; export function read() { return own.constructor() + own.call() + import.meta.url.length; }";
  const reasons = inspect(content);
  expect(reasons).not.toContain("SOURCE_CALLABLE_EXPORT_UNSUPPORTED");
  expect(reasons).not.toContain("SOURCE_DYNAMIC_EVALUATION_UNSUPPORTED");
  expect(inspectNativeModuleBindings(ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true)).commonJsUnsupported).toBe(false);
  const object = "export function read() { return ({}).constructor; }";
  expect(inspect(object)).not.toContain("SOURCE_DYNAMIC_EVALUATION_UNSUPPORTED");
  const metadata = "const meta = import.meta; const { url } = meta; export function read() { return meta.url + url; }";
  expect(inspectNativeModuleBindings(ts.createSourceFile(path, metadata, ts.ScriptTarget.Latest, true)).commonJsUnsupported).toBe(false);
  expect(inspect(metadata)).not.toContain("SOURCE_COMMONJS_UNSUPPORTED");
  expect(inspectModuleConfiguration(path, "/fixture", undefined, ts.createSourceFile(path, "export const C = class {};", ts.ScriptTarget.Latest, true))).not.toContain("SOURCE_CALLABLE_EXPORT_UNSUPPORTED");
});

for (const content of [
  "const key = 'require'; export function read() { return import.meta[key].call(null, './hidden.js'); }",
  "export function read() { return ({ meta: import.meta }).meta.require('./hidden.js'); }",
]) test(`Bun metadata computed/container escape is explicitly refused: ${content}`, () => {
  expect(inspectNativeModuleBindings(ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true)).commonJsUnsupported).toBe(true);
  expect(inspectJavaScriptSource("/fixture/main.js", content).reasons).toContain("JAVASCRIPT_COMMONJS_UNSUPPORTED");
  expect(inspect(content)).toContain("SOURCE_COMMONJS_UNSUPPORTED");
});
