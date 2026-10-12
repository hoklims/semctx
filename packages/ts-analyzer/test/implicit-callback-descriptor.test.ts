import { expect, test } from "bun:test";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";
import ts from "typescript";
const path = "/fixture/main.ts";
for (const content of [
  "const { defineProperty } = Object; function helper() { return 1; } const box = {}; export function start() { defineProperty.call(Object, box, 'value', { get: helper }); return box.value; }",
  "function helper() { return 1; } const box = {}; Object.defineProperty(box, 'value', { __proto__: { get: helper } }); export function read() { return box.value; }",
]) test(`descriptor follow-up refuses ${content}`, () => {
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ content, reasons }));
  expect(reasons).toContain("SOURCE_DESCRIPTOR_ACCESSOR_UNSUPPORTED");
  expect(inspectJavaScriptSource("/fixture/main.js", content).reasons).toContain("JAVASCRIPT_DESCRIPTOR_ACCESSOR_UNSUPPORTED");
});
for (const [content, reason] of [
  ["function helper() { return 1; } export function start() { return setTimeout(helper, 0); }", "TIMER_CALLBACK_UNSUPPORTED"],
  ["function helper() { return 1; } const box = {}; Object.defineProperty(box, 'value', { get: helper }); export function read() { return box.value; }", "DESCRIPTOR_ACCESSOR_UNSUPPORTED"],
  ["declare function eval(source: string): unknown; export function run() { return eval(\"import('./hidden.js')\"); }", "AMBIENT_FUNCTION_UNSUPPORTED"],
] as const) test(`unmodeled runtime ${reason} refuses`, () => {
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ content, reasons }));
  expect(reasons).toContain(`SOURCE_${reason}`);
});
for (const content of [
  "function helper() { return 1; } const make = Object.defineProperty; const box = {}; make(box, 'value', { set: helper }); export function read() { return box.value; }",
  "function helper() { return 1; } const { defineProperty: make } = Object; const box = {}; make(box, 'value', { get: helper }); export function read() { return box.value; }",
  "function helper() { return 1; } const box = {}; Object.defineProperty.call(null, box, 'value', { get: helper }); export function read() { return box.value; }",
  "function helper() { return 1; } const descriptor = { value: 1 }; descriptor.get = helper; const box = {}; Object.defineProperty(box, 'value', descriptor); export function read() { return box.value; }",
]) test(`actual descriptor SDK origin refuses accessor or unproved escape: ${content}`, () => {
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).toContain("SOURCE_DESCRIPTOR_ACCESSOR_UNSUPPORTED");
  expect(inspectJavaScriptSource("/fixture/main.js", content).reasons).toContain("JAVASCRIPT_DESCRIPTOR_ACCESSOR_UNSUPPORTED");
});
test("descriptor data literals, own homonyms and type queries preserve their boundary", () => {
  for (const content of [
    "const box = {}; Object.defineProperty(box, 'value', { value: 1 }); export function read() { return box.value; }",
    "const own = { defineProperty(box, key, descriptor) { return box; } }; export function read() { return own.defineProperty({}, 'value', { get: () => 1 }); }",
    "const Object = { defineProperty(box, key, descriptor) { return box; } }; const { defineProperty } = Object; export function read() { return defineProperty({}, 'value', { get: () => 1 }); }",
    "export type Factory = typeof Object.defineProperty;",
  ]) expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).not.toContain("SOURCE_DESCRIPTOR_ACCESSOR_UNSUPPORTED");
});
test("real overload implementation and no-snapshot declaration facts remain distinct", () => {
  const implemented = "function eval(source: string): unknown; function eval(source: string) { return 1; } export function run() { return eval('ordinary'); }";
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, implemented]]))).not.toContain("SOURCE_AMBIENT_FUNCTION_UNSUPPORTED");
  const bodyless = "declare function eval(source: string): unknown; export function run() { return eval('ordinary'); }";
  expect(inspectModuleConfiguration(path, "/fixture", undefined, ts.createSourceFile(path, bodyless, ts.ScriptTarget.Latest, true))).not.toContain("SOURCE_AMBIENT_FUNCTION_UNSUPPORTED");
});
