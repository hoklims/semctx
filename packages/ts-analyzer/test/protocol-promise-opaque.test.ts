import { expect, test } from "bun:test";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";
const path = "/fixture/main.ts";
test("opaque data uses an actual dominating runtime primitive guard", () => {
  const content = "import { read, write } from 'opaque'; const source = read(); if (typeof source !== 'string') throw new TypeError('string required'); write(source); export function start() { return 1; }";
  const inputs = new Map([[path, content], ["/fixture/package.json", '{"dependencies":{"opaque":"1.0.0"}}']]);
  expect(inspectModuleConfiguration(path, "/fixture", inputs)).not.toContain("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED");
});
test("a guard outside the callback execution scope is not dominance proof", () => {
  const content = "import { read, write } from 'opaque'; const source = read(); start(); if (typeof source !== 'string') throw new TypeError('string required'); export function start() { write(source); }";
  const inputs = new Map([[path, content], ["/fixture/package.json", '{"dependencies":{"opaque":"1.0.0"}}']]);
  expect(inspectModuleConfiguration(path, "/fixture", inputs)).toContain("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED");
});
test("runtime primitive guards do not prove reassigned or differently bound data", () => {
  for (const body of [
    "export function start(source) { if (typeof source !== 'string') throw new TypeError(); source = read(); write(source); }",
    "export function start(source) { if (typeof source !== 'string') throw new TypeError(); [source] = [read()]; write(source); }",
    "function helper() {} export function start(source) { if (typeof source !== 'string') throw new TypeError(); ({ source } = { source: helper }); write(source); }",
    "const source = read(); { const source = 'text'; if (typeof source !== 'string') throw new TypeError(); } write(source); export function start() { return 1; }",
  ]) {
    const content = "import { read, write } from 'opaque'; " + body;
    const inputs = new Map([[path, content], ["/fixture/package.json", '{"dependencies":{"opaque":"1.0.0"}}']]);
    expect(inspectModuleConfiguration(path, "/fixture", inputs)).toContain("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED");
  }
});
for (const [name, body] of [
  ["annotation", "export function start(source: string) { return write(source); }"],
  ["assertion", "const source = read() as string; write(source); export function start() { return 1; }"],
] as const) test(`opaque primitive ${name} alone is not value provenance`, () => {
  const content = "import { read, write } from 'opaque'; " + body;
  const inputs = new Map([[path, content], ["/fixture/package.json", '{"dependencies":{"opaque":"1.0.0"}}']]);
  const reasons = inspectModuleConfiguration(path, "/fixture", inputs);
  console.info(JSON.stringify({ primitiveProof: name, reasons }));
  expect(reasons).toContain("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED");
});
for (const [body, allowed] of [
  ["function value() { return 1 + 1; }", true],
  ["function helper() {} function value() { return helper; }", false],
  ["function value(input: number) { return input; }", false],
  ["async function value() { return 1; }", false],
  ["function* value() { yield 1; return 1; }", false],
] as const) test(`opaque result proof inspects the actual return: ${body}`, () => {
  const content = "import { write } from 'opaque'; " + body + " export function start() { return write(value(1)); }";
  const inputs = new Map([[path, content], ["/fixture/package.json", '{"dependencies":{"opaque":"1.0.0"}}']]);
  expect(inspectModuleConfiguration(path, "/fixture", inputs).includes("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED")).toBe(!allowed);
});
test("a reassigned retained function is not primitive-return provenance", () => {
  const jsPath = "/fixture/main.js";
  const content = "import { expect } from 'opaque'; function helper() {} function value() { return 1; } value = () => helper; export function run() { return expect(value()); }";
  const inputs = new Map([[jsPath, content], ["/fixture/package.json", '{"dependencies":{"opaque":"1.0.0"}}']]);
  const reasons = inspectModuleConfiguration(jsPath, "/fixture", inputs);
  console.info(JSON.stringify({ reassignedCalleeReasons: reasons }));
  expect(reasons).toContain("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED");
});
test("Promise resolve helper dispatch retains the assimilation obligation", () => {
  const content = "const value = { then() { return 1; } }; export function start() { return Promise.resolve.call(Promise, value); }";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ promiseHelperReasons: reasons }));
  expect(reasons).toContain("SOURCE_PROMISE_ASSIMILATION_UNSUPPORTED");
});
test("ordinary SDK symbol-key data is not an iterable API input", () => {
  const content = "const box = {}; Object.defineProperty(box, Symbol.toStringTag, { value: 'box' }); export function run() { return box; }";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ ordinarySymbolData: reasons }));
  expect(reasons).not.toContain("SOURCE_SDK_ITERATION_UNSUPPORTED");
});
for (const [content, expected] of [
  ["function helper() { return true; } Object.defineProperty(Array, Symbol.hasInstance, { value: helper }); export function run(value) { return value instanceof Array; }", "PROTOCOL_DESCRIPTOR_UNSUPPORTED"],
  ["function* helper() { yield 1; } const values = [1]; Reflect.set(values, Symbol.iterator, helper); export function run() { return [...values]; }", "PROTOCOL_MUTATION_UNSUPPORTED"],
  ["function* helper() { yield 1; } const values = [1]; Reflect.defineProperty(values, Symbol.iterator, { value: helper }); export function run() { return [...values]; }", "PROTOCOL_DESCRIPTOR_UNSUPPORTED"],
  ["const value = { then() { return 1; } }; export function start() { return Promise.resolve(value); }", "PROMISE_ASSIMILATION_UNSUPPORTED"],
  ["import { register } from 'opaque'; function helper() { return 1; } export function start() { return register(helper); }", "OPAQUE_CALLBACK_UNSUPPORTED"],
] as const) test(`qualified implicit operation reports ${expected}`, () => {
  const metadata: [string,string] = ["/fixture/package.json", '{"dependencies":{"opaque":"1.0.0"}}'];
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content], metadata]));
  const js = inspectJavaScriptSource("/fixture/main.js", content, "/fixture", new Map([["/fixture/main.js", content], metadata])).reasons;
  console.info(JSON.stringify({ content, reasons, js }));
  expect(reasons).toContain(`SOURCE_${expected}`);
  expect(js).toContain(`JAVASCRIPT_${expected}`);
});
