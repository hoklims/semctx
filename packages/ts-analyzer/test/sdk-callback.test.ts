import { expect, test } from "bun:test";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";
const path = "/fixture/main.ts";
test("actual SDK callback helper route cannot erase its callback signature", () => {
  const content = "function helper(value) { return 1; } export function run() { return [1].map.call([1], helper); }";
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).toContain("SOURCE_SDK_CALLBACK_UNSUPPORTED");
  expect(inspectJavaScriptSource("/fixture/main.js", content).reasons).toContain("JAVASCRIPT_SDK_CALLBACK_UNSUPPORTED");
});
for (const content of [
  "function helper(value) { return value; } export function run() { return [1].map(helper); }",
  "function executor() {} export async function run() { await new Promise(executor); }",
]) test(`actual SDK callback cannot hide an invocation: ${content}`, () => {
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  const js = inspectJavaScriptSource("/fixture/main.js", content).reasons;
  console.info(JSON.stringify({ content, reasons, js }));
  expect(reasons).toContain("SOURCE_SDK_CALLBACK_UNSUPPORTED");
  expect(js).toContain("JAVASCRIPT_SDK_CALLBACK_UNSUPPORTED");
});

test("actual SDK opaque data and own callback APIs keep their boundaries", () => {
  for (const content of [
    "export function run() { return Math.max(1, 2); }",
    "export function run() { return Math.max.call(null, 1, 2); }",
    "const own = { call(callback) { return 1; } }; function helper() { return 1; } export function run() { return own.call(helper); }",
    "export function run() { return new Map(); }",
    "export async function run() { return await Promise.resolve(1); }",
    "function helper() { return 1; } const own = { map(callback) { return callback(); } }; export function run() { return own.map(helper); }",
    "function helper() { return 1; } const own = { map(callback) { return callback(); } }; export function run() { return (own.map as typeof Array.prototype.map)(helper); }",
  ]) expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).not.toContain("SOURCE_SDK_CALLBACK_UNSUPPORTED");
});

test("transparent SDK aliases retain callback refusal and ordinary no-snapshot diagnostics remain unchanged", () => {
  const content = "function executor() {} const Native = Promise; export function run() { return new Native(executor); }";
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).toContain("SOURCE_SDK_CALLBACK_UNSUPPORTED");
  expect(inspectModuleConfiguration(path, "/fixture")).not.toContain("SOURCE_SDK_CALLBACK_UNSUPPORTED");
});
