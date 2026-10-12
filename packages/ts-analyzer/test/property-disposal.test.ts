import { expect, test } from "bun:test";
import ts from "typescript";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";
const path = "/fixture/main.ts";
test("erased interface computed names do not imply runtime property coercion", () => {
  for (const content of [
    "declare const key: unique symbol; export interface Box { [key]: number; }",
    "declare const key: unique symbol; export type Box = { [key]: number; };",
    "declare const key: unique symbol; export declare class Box { [key]: number; }",
  ]) {
    const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
    expect(reasons).not.toContain("SOURCE_PROPERTY_KEY_UNSUPPORTED");
  }
  const content = "const key = { toString() { return 'value'; } }; export class Box { [key] = 1; }";
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).toContain("SOURCE_PROPERTY_KEY_UNSUPPORTED");
});
test("native promise then override through a constant key cannot preserve async return admission", () => {
  const content = "function helper() {} const p = Promise.resolve(1); const key = 'then'; (p as any)[key] = helper; export async function start() { return p; }";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ content, reasons }));
  expect(reasons).toContain("SOURCE_THENABLE_MUTATION_UNSUPPORTED");
});
for (const content of [
  "const resource = { [Symbol.asyncDispose]() {} }; export async function start() { await using owned = resource; return 1; }",
  "const key = { toString() { return 'value'; } }; export function start() { return { [key]: 1 }; }",
  "const key = { [Symbol.toPrimitive]() { return 'value'; } }; const target = { value: 1 }; export function start() { const { [key]: value } = target; return value; }",
  "function helper() {} const p = Promise.resolve(1); p.then = helper; export async function start() { return p; }",
]) test(`unmodeled property or disposal protocol refuses ${content}`, () => {
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  expect(reasons.some(reason => /SOURCE_(PROPERTY_KEY|DISPOSAL|THENABLE_MUTATION)_UNSUPPORTED/.test(reason))).toBe(true);
});
test("proven primitive keys, actual SDK symbols and unmodified native promises preserve their boundaries", () => {
  for (const content of [
    "const key = 'value'; const target = { value: 1 }; export function start() { return target[key]; }",
    "const target = [1]; export function start() { return target[0]; }",
    "const key = Symbol.iterator; const target = { [key]() { return 1; } }; export function start() { return target[key]; }",
    "export async function start() { return await Promise.resolve(1); }",
    "export async function start() { return import('./dep.mjs'); }",
    "export function start() { const using = 1; return using; }",
  ]) {
    const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content], ["/fixture/dep.mjs", "export function dep() { return 1; }"]]));
    expect(reasons.filter(reason => /SOURCE_(PROPERTY_KEY|DISPOSAL|THENABLE_MUTATION|AWAIT|ASYNC_RETURN)_UNSUPPORTED/.test(reason))).toEqual([]);
  }
});
for (const member of ["iterator", "hasInstance", "toPrimitive"]) test(`actual SDK Symbol.${member} is a proven property key`, () => {
  const content = `const key = Symbol.${member}; const target = { [key]: 1 }; export function start() { return target[key]; }`;
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  expect(reasons).not.toContain("SOURCE_PROPERTY_KEY_UNSUPPORTED");
});
for (const member of ["dispose", "asyncDispose"]) test(`Symbol.${member} outside the loaded SDK declarations is an unknown property key`, () => {
  const content = `const key = Symbol.${member}; const target = { [key]: 1 }; export function start() { return target[key]; }`;
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  expect(reasons).toContain("SOURCE_PROPERTY_KEY_UNSUPPORTED");
});
for (const [content, reason] of [
  ["function helper() {} const value: any = []; value.then = helper; export async function start() { await value; }", "AWAIT_UNSUPPORTED"],
  ["const key = { [Symbol.toPrimitive]() { return 'value'; } }; const target = { value: 1 }; export function start() { return target[key]; }", "PROPERTY_KEY_UNSUPPORTED"],
  ["const disposable = { [Symbol.dispose]() {} }; export function start() { using resource = disposable; return 1; }", "DISPOSAL_UNSUPPORTED"],
] as const) test(`direct ${reason} refuses omitted implicit invocation`, () => {
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ content, reasons }));
  expect(reasons).toContain(`SOURCE_${reason}`);
});
test("retained CommonJS JavaScript format is unsupported even with ESM syntax", () => {
  const file = "/fixture/main.cjs"; const content = "export function run() { return 1; }";
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const reasons = inspectModuleConfiguration(file, "/fixture", new Map([[file, content]]), source);
  console.info(JSON.stringify({ reasons, js: inspectJavaScriptSource(file, content).reasons }));
  expect(reasons).toContain("SOURCE_COMMONJS_EXTENSION_UNSUPPORTED");
});
