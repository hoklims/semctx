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
