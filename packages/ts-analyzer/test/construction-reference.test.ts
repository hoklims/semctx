import { expect, test } from "bun:test";
import ts from "typescript";
import { extractTypeScript, inspectJavaScriptSource, inspectModuleConfiguration } from "../src";

const path = "/fixture/main.ts";
const inspect = (content: string) => inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
test("constructor-body coordinates do not create the missing make-to-Helper invocation", () => {
  const content = "function touch() { return 1; } export class Helper { constructor() { touch(); } } export function make() { return new Helper(); }";
  const extraction = extractTypeScript([path], "/fixture", new Map([[path, content]]));
  expect(extraction.calls).toContainEqual(expect.objectContaining({ callerSymbolPath: "Helper", calleeSymbolPath: "touch" }));
  expect(extraction.calls.some(call => call.callerSymbolPath === "make" && call.calleeSymbolPath === "Helper")).toBe(false);
  expect(inspect(content)).toContain("SOURCE_CONSTRUCTION_UNSUPPORTED");
});
for (const content of [
  "export class Helper {} export function make() { return new Helper(); }",
  "declare const Constructor: MapConstructor; export function make() { return new Constructor(); }",
  "function choose(): MapConstructor { return Map; } export function make() { return new (choose())(); }",
  "export class Helper {} export function make() { return new (Helper as unknown as typeof Error)(); }",
  "let Constructor = Map; export function make() { return new Constructor(); }",
]) test(`unmodeled or uncertain constructor origin refuses ${content}`, () => {
  expect(inspect(content)).toContain("SOURCE_CONSTRUCTION_UNSUPPORTED");
});
test("known SDK constructors, plain class declarations and ordinary facts retain their domain", () => {
  expect(inspect("const Alias = Map; export class Plain {} export function make() { return new Alias(); }")).not.toContain("SOURCE_CONSTRUCTION_UNSUPPORTED");
  expect(inspect("export function make() { return new Map(); }")).not.toContain("SOURCE_CONSTRUCTION_UNSUPPORTED");
  const content = "export class Helper {} export function make() { return new Helper(); }";
  expect(inspectModuleConfiguration(path, "/fixture", undefined, ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true))).not.toContain("SOURCE_CONSTRUCTION_UNSUPPORTED");
  expect(extractTypeScript([path], "/fixture", new Map([[path, content]])).symbols.some(symbol => symbol.kind === "class" && symbol.name === "Helper")).toBe(true);
});
test("retained module-to-module path reference has no extracted runtime import and must refuse", () => {
  const reference = "/fixture/reader.ts"; const core = "/fixture/core.ts";
  const content = "/// <reference path='./core.ts' />\nexport {};";
  const snapshot = new Map([[reference, content], [core, "export function core() { return 1; }"]]);
  expect(extractTypeScript([reference, core], "/fixture", snapshot).imports).toEqual([]);
  expect(inspectModuleConfiguration(reference, "/fixture", snapshot)).toContain("SOURCE_REFERENCE_PATH_UNSUPPORTED");
  expect(inspectModuleConfiguration(reference, "/fixture", undefined, ts.createSourceFile(reference, content, ts.ScriptTarget.Latest, true))).not.toContain("SOURCE_REFERENCE_PATH_UNSUPPORTED");
  const javascript = "/fixture/reader.js";
  expect(inspectJavaScriptSource(javascript, content, "/fixture", new Map([[javascript, content], [core, "export function core() { return 1; }"]])).reasons).toContain("JAVASCRIPT_REFERENCE_PATH_UNSUPPORTED");
});

for (const extension of ["ts", "mjs"]) for (const route of ["property", "element", "alias"] as const) test(`SDK-shaped local receiver cannot qualify ${route} construction in ${extension}`, () => {
  const path = `/fixture/main.${extension}`;
  const receiver = extension === "ts"
    ? "const env:typeof globalThis={Date:LocalDate} as unknown as typeof globalThis;"
    : "/** @type {typeof globalThis} */\nconst env=/** @type {any} */ ({Date:LocalDate});";
  const callee = route === "property" ? "env.Date" : route === "element" ? "env['Date']" : "C";
  const content = `class LocalDate { constructor(value) {} }\n${receiver}\n${route === "alias" ? "const C=env.Date;" : ""}export function make() { return new ${callee}(1); }`;
  const inputs = new Map([[path, content]]);
  expect(inspectModuleConfiguration(path, "/fixture", inputs)).toContain("SOURCE_CONSTRUCTION_UNSUPPORTED");
  if (extension === "mjs") expect(inspectJavaScriptSource(path, content, "/fixture", inputs).reasons).toContain("JAVASCRIPT_CONSTRUCTION_UNSUPPORTED");
});
test("SDK-shaped caller receiver cannot qualify construction", () => {
  expect(inspect("export function make(env:typeof globalThis) { return new env.Date(1); }")).toContain("SOURCE_CONSTRUCTION_UNSUPPORTED");
});
test("true SDK constructor aliases and namespace destructuring retain their boundary", () => {
  for (const content of [
    "const C=Date;export function make() { return new C(1); }",
    "const env=globalThis;export function make() { return new env.Date(1); }",
    "const C=globalThis.Date;export function make() { return new C(1); }",
    "const {Module:C}=WebAssembly;export function make() { return new C(new Uint8Array()); }",
  ]) expect(inspect(content)).toEqual([]);
});

test("an SDK-shaped imported-helper constructor is still an internal invocation", () => {
  const content = "import { hidden } from './hidden';const env:typeof globalThis={Date:class {constructor(){hidden();}}} as unknown as typeof globalThis;export function make(){return new env.Date(1);}";
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content], ["/fixture/hidden.ts", "export function hidden(){return 1;}"]]))).toContain("SOURCE_CONSTRUCTION_UNSUPPORTED");
});
test("intrinsic instance data cannot become an SDK constructor namespace through a cast", () => {
  for (const value of ["[1]", "'native data'", "new Date(1)"]) {
    expect(inspect(`const env=${value} as unknown as typeof globalThis;export function make(){return new env.Date(1);}`)).toContain("SOURCE_CONSTRUCTION_UNSUPPORTED");
  }
});
test("SDK-shaped constructor receiver cannot qualify instanceof or native instance origins", () => {
  const content = "class LocalMap {} const env:typeof globalThis={Map:LocalMap} as unknown as typeof globalThis;export function make(){const value=new env.Map();return value instanceof env.Map;}";
  const reasons = inspect(content);
  expect(reasons).toContain("SOURCE_CONSTRUCTION_UNSUPPORTED");
  expect(reasons).toContain("SOURCE_INSTANCEOF_UNSUPPORTED");
});

test("SDK-shaped construction does not confer native promise or collection origin", () => {
  const promise = "const env:typeof globalThis={Promise:class {}} as unknown as typeof globalThis;export async function make(){await new env.Promise(undefined as any);}";
  expect(inspect(promise)).toContain("SOURCE_AWAIT_UNSUPPORTED");
  const collection = "const env:typeof globalThis={Map:class {}} as unknown as typeof globalThis;export function make(){for(const item of new env.Map()){} }";
  expect(inspect(collection)).toContain("SOURCE_ITERATION_UNSUPPORTED");
});

test("proven SDK namespace constructor aliases still require Date argument provenance", () => {
  expect(inspect("const {Date:C}=window;export function make(){return new C(1);}")).toEqual([]);
  const content = "const {Date:C}=window;function helper(){return 1;}const value={valueOf:helper};export function make(){return new C(value as any);}";
  expect(inspect(content)).toContain("SOURCE_COERCION_UNSUPPORTED");
});
