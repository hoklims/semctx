import { expect, test } from "bun:test";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";
import { extractionContext } from "../src/ts-symbols";
import ts from "typescript";
const path = "/fixture/main.ts";
test("SDK callable logical assignment reaches the same mutation guard", () => {
  const content = "function helper() { return 1; } Math.random &&= helper; export function run() { return Math.random(); }";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ content, reasons }));
  expect(reasons).toContain("SOURCE_SDK_CALLABLE_MUTATION_UNSUPPORTED");
});
test("SDK boundaries preserve ordinary data, owned methods, executed shadows and type queries", () => {
  for (const content of [
    "const box = {}; Object.defineProperty(box, 'value', { value: 1 }); export function start() { return box.value; }",
    "function helper() { return 1; } const Math = { random() { return 2; } }; Math.random = helper; export function start() { return Math.random(); }",
    "function importScripts(value) { return value; } export function start() { return importScripts('ordinary'); }",
    "const own = { importScripts(value) { return value; } }; export function start() { return own.importScripts('ordinary'); }",
    "export type Loader = typeof importScripts; export type Method = typeof Math.random;",
  ]) expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]])).filter(reason => /SOURCE_(PROTOCOL_DESCRIPTOR|SDK_CALLABLE_MUTATION|WORKER_LOADER)_UNSUPPORTED/.test(reason))).toEqual([]);
});
for (const [content, reason] of [
  ["function helper() { return { next() { return { done: true }; } }; } const key = Symbol.iterator; const values = [1]; Object.defineProperty(values, key, { value: helper }); export function start() { const [value] = values; return value; }", "PROTOCOL_DESCRIPTOR_UNSUPPORTED"],
  ["const load = importScripts; export function start() { load('./hidden.js'); }", "WORKER_LOADER_UNSUPPORTED"],
  ["function helper() { return 1; } const math = Math; const key = 'random'; math[key] = helper; export function start() { return math.random(); }", "SDK_CALLABLE_MUTATION_UNSUPPORTED"],
] as const) test(`same SDK alias origin refuses ${reason}`, () => {
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).toContain(`SOURCE_${reason}`);
  expect(inspectJavaScriptSource("/fixture/main.js", content).reasons).toContain(`JAVASCRIPT_${reason}`);
});
test("SDK callable descriptor route cannot preserve native call authority", () => {
  const content = "function helper() { return 1; } Object.defineProperty(Math, 'random', { value: helper }); export function run() { return Math.random(); }";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ content, reasons }));
  expect(reasons).toContain("SOURCE_SDK_CALLABLE_MUTATION_UNSUPPORTED");
});
for (const [content, reason] of [
  ["function helper() { return { next() { return { done: true, value: 1 }; } }; } const values = [1]; Object.defineProperty(values, Symbol.iterator, { value: helper }); export function start() { return [...values]; }", "PROTOCOL_DESCRIPTOR_UNSUPPORTED"],
  ["export function load() { importScripts('./hidden.js'); }", "WORKER_LOADER_UNSUPPORTED"],
  ["function helper() { return 1; } Math.random = helper; export function run() { return Math.random(); }", "SDK_CALLABLE_MUTATION_UNSUPPORTED"],
] as const) test(`unmodeled SDK boundary ${reason} refuses`, () => {
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ content, reasons }));
  expect(reasons).toContain(`SOURCE_${reason}`);
});
test("actual loaded Program proves importScripts through its partial worker SDK library", () => {
  const program = extractionContext.createProgram([path], new Map([[path, "export function load() { importScripts('./hidden.js'); }"]]));
  const source = program.getSourceFile(path)!; const checker = program.getTypeChecker();
  let expression: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => { if (ts.isIdentifier(node) && node.text === "importScripts") expression = node; ts.forEachChild(node, visit); };
  visit(source);
  const declarations = checker.getSymbolAtLocation(expression!)?.getDeclarations() ?? [];
  console.info(JSON.stringify({ declarations: declarations.map(node => node.getSourceFile().fileName), libs: program.getSourceFiles().filter(file => program.isSourceFileDefaultLibrary(file)).map(file => file.fileName) }));
  expect(declarations.some(node => program.isSourceFileDefaultLibrary(node.getSourceFile()) && node.getSourceFile().fileName.endsWith("/lib.webworker.importscripts.d.ts"))).toBe(true);
});
