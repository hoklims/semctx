import { expect, test } from "bun:test";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";
const path = "/fixture/main.ts";
test("outer literal array does not prove a nested iterable item", () => {
  const content = "const values = { *[Symbol.iterator]() { yield 1; } }; export function start() { const [[value]] = [values]; return value; }";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  const js = inspectJavaScriptSource("/fixture/main.js", content).reasons;
  console.info(JSON.stringify({ content, reasons, js }));
  expect(reasons).toContain("SOURCE_ITERATION_UNSUPPORTED");
  expect(js).toContain("JAVASCRIPT_ITERATION_UNSUPPORTED");
});
test("asserted async signature does not prove the actual callee returns a native promise", () => {
  const content = "const thenable = { then() { return 1; } }; function load() { return thenable; } async function native() { return 1; } export async function start() { return await (load as typeof native)(); }";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ content, reasons }));
  expect(reasons).toContain("SOURCE_AWAIT_UNSUPPORTED");
});
for (const [content, reason] of [
  ["const values = { *[Symbol.iterator]() { yield 1; } }; export function start() { const [value] = values; return value; }", "ITERATION_UNSUPPORTED"],
  ["const value = { then(resolve) { resolve(1); } }; export async function start() { return await value; }", "AWAIT_UNSUPPORTED"],
  ["const matcher = { [Symbol.hasInstance](value) { return !!value; } }; export function start(value) { return value instanceof matcher; }", "INSTANCEOF_UNSUPPORTED"],
] as const) test(`direct ${reason} refuses implicit invocation`, () => {
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  const js = inspectJavaScriptSource("/fixture/main.js", content).reasons;
  console.info(JSON.stringify({ content, reasons, js }));
  expect(reasons).toContain(`SOURCE_${reason}`);
  expect(js).toContain(`JAVASCRIPT_${reason}`);
});
for (const content of [
  "const values = { *[Symbol.iterator]() { yield 1; } }; export function* start() { yield* values; }",
  "export function start([value]: number[]) { return value; }",
  "const values = { *[Symbol.iterator]() { yield 1; } }; export function start() { let value; [value] = values; return value; }",
  "export async function start(value: unknown) { return await value; }",
  "const value = { then(resolve) { resolve(1); } }; const promise: Promise<number> = value as unknown as Promise<number>; export async function start() { return await promise; }",
  "const matcher = { [Symbol.hasInstance](value) { return !!value; } }; const typed: typeof Error = matcher as unknown as typeof Error; export function start(value) { return value instanceof typed; }",
]) test(`unproven protocol origin refuses ${content}`, () => {
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  expect(reasons.some(reason => /SOURCE_(ITERATION|AWAIT|INSTANCEOF)_UNSUPPORTED/.test(reason))).toBe(true);
});
test("real intrinsic values and native promise origins preserve their boundaries", () => {
  for (const content of [
    "export function start() { const [value] = [1]; return value; }",
    "const values = [[1]]; export function start() { const [[value]] = values; return value; }",
    "export function* start() { yield* 'abc'; }",
    "export async function start() { return await 1; }",
    "const ready = Promise.resolve(1); export async function start() { return await ready; }",
    "export async function start() { return await new Promise(resolve => resolve(1)); }",
    "async function load() { return 1; } export async function start() { return await load(); }",
    "export async function start() { return await import('./dep.mjs'); }",
    "const Kind = Error; export function start(value) { return value instanceof Kind; }",
  ]) {
    const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content], ["/fixture/dep.mjs", "export function dep() { return 1; }"]]));
    expect(reasons).not.toContain("SOURCE_ITERATION_UNSUPPORTED");
    expect(reasons).not.toContain("SOURCE_AWAIT_UNSUPPORTED");
    expect(reasons).not.toContain("SOURCE_INSTANCEOF_UNSUPPORTED");
  }
});
test("named extends is consumed globally but project references do not read compiler options", () => {
  const content = "export function main() { return 1; }";
  const snapshot = new Map([[path, content], ["/fixture/other/main.ts", content],
    ["/fixture/tsconfig.json", '{"extends":"./tsconfig.base.json"}'], ["/fixture/tsconfig.base.json", '{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler"}}'],
    ["/fixture/other/tsconfig.json", '{"compilerOptions":{"module":"ESNext"}}']]);
  expect(inspectModuleConfiguration("/fixture/other/main.ts", "/fixture", snapshot)).not.toContain("SOURCE_NAMED_CONFIGURATION_UNSUPPORTED");
  const referenced = new Map([[path, content], ["/fixture/tsconfig.json", '{"references":[{"path":"./tsconfig.app.json"}]}'], ["/fixture/tsconfig.app.json", '{"compilerOptions":{"jsx":"react-jsx"}}']]);
  expect(inspectModuleConfiguration(path, "/fixture", referenced)).toContain("SOURCE_NAMED_CONFIGURATION_UNSUPPORTED");
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content], ["/fixture/tsconfig.json", '{}']]))).not.toContain("SOURCE_NAMED_CONFIGURATION_UNSUPPORTED");
});
test("retained unconsumed named config cannot silently select default semantics", () => {
  const view = "/fixture/view.tsx"; const content = "export function view() { return <div />; }";
  const snapshot = new Map([[view, content], ["/fixture/tsconfig.app.json", '{"compilerOptions":{"jsx":"react-jsx"}}']]);
  const reasons = inspectModuleConfiguration(view, "/fixture", snapshot);
  console.info(JSON.stringify({ reasons }));
  expect(reasons).toContain("SOURCE_NAMED_CONFIGURATION_UNSUPPORTED");
});
