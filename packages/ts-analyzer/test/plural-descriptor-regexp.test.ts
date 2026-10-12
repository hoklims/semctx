import { expect, test } from "bun:test";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";

const descriptorCases = [
  "function* helper() { yield 7; } const values = [1]; Object.defineProperties(values, { [Symbol.iterator]: { value: helper } }); export function run() { return [...values]; }",
  "function helper() { return 7; } const box = Object.create({}, { value: { get: helper } }); export function run() { return box.value; }",
] as const;
for (const [index, content] of descriptorCases.entries()) for (const extension of ["ts", "js"]) test(`descriptor route ${index} refuses ${extension}`, () => {
  const path = `/fixture/main.${extension}`; const snapshot = new Map([[path, content]]);
  const reasons = extension === "js" ? inspectJavaScriptSource(path, content, "/fixture", snapshot).reasons : inspectModuleConfiguration(path, "/fixture", snapshot);
  console.info(JSON.stringify({ index, extension, reasons }));
  expect(reasons.some(reason => reason.includes("DESCRIPTOR_UNSUPPORTED"))).toBe(true);
});
for (const [key, operation] of [["match", "'x'.match(matcher)"], ["matchAll", "'x'.matchAll(matcher)"], ["replace", "'x'.replace(matcher, 'y')"], ["search", "'x'.search(matcher)"], ["split", "'x'.split(matcher)"]] as const) test(`actual SDK Symbol.${key} mutation refuses`, () => {
  const path = "/fixture/main.ts";
  const content = `function helper() { return 7; } const matcher = {}; matcher[Symbol.${key}] = helper; export function run() { return ${operation}; }`;
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ key, reasons }));
  expect(reasons).toContain("SOURCE_PROTOCOL_MUTATION_UNSUPPORTED");
});
test("native descriptor getter and match hook invoke the actual retained helper", () => {
  for (const content of [
    "function helper() { console.log('HOOK_CALLED'); return 7; } const box = Object.create({}, { value: { get: helper } }); if(box.value!==7)throw Error('getter mismatch');",
    "function helper() { console.log('HOOK_CALLED'); return 7; } const matcher={}; matcher[Symbol.match]=helper; if('x'.match(matcher)!==7)throw Error('match mismatch');",
    "function* helper() { console.log('HOOK_CALLED'); yield 7; } const values=[1]; Object.defineProperties(values,{[Symbol.iterator]:{value:helper}}); if([...values][0]!==7)throw Error('iterator mismatch');",
  ]) {
    const result = Bun.spawnSync([process.execPath, "-e", content], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0); expect(new TextDecoder().decode(result.stdout)).toContain("HOOK_CALLED");
  }
});
test("ordinary SDK data descriptors and string properties are separate from protocol hooks", () => {
  for (const content of [
    "const box = {}; Object.defineProperties(box, { value: { value: 1 } }); export function run() { return box.value; }",
    "const box = Object.create({}, { value: { value: 1 } }); export function run() { return box.value; }",
    "function helper() { return 1; } const matcher = {}; matcher['match'] = helper; export function run() { return 1; }",
  ]) {
    const path = "/fixture/main.ts"; const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
    expect(reasons.some(reason => reason.includes("DESCRIPTOR_UNSUPPORTED") || reason.includes("PROTOCOL_MUTATION_UNSUPPORTED"))).toBe(false);
  }
});
test("known SDK aliases and helper escapes retain the same mutation obligations", () => {
  for (const [content, reason] of [
    ["function* helper() { yield 1; } const values = [1]; const change = Object.setPrototypeOf; change.call(Object, values, { [Symbol.iterator]: helper }); export function run() { return [...values]; }", "PROTOTYPE_MUTATION_UNSUPPORTED"],
    ["function* helper() { yield 1; } const values = [1]; const { defineProperties: define } = Object; define.call(Object, values, { [Symbol.iterator]: { value: helper } }); export function run() { return [...values]; }", "DESCRIPTOR_UNSUPPORTED"],
    ["function helper() { return 1; } const matcher = {}; const { match: key } = Symbol; matcher[key] = helper; export function run() { return 'x'.match(matcher); }", "PROTOCOL_MUTATION_UNSUPPORTED"],
  ] as const) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).toContain(`SOURCE_${reason}`);
  }
});
