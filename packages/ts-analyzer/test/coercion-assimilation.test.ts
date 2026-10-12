import { expect, test } from "bun:test";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";
const path = "/fixture/main.ts";
test("quoted SDK receiver register helper cannot hide loading behind any", () => {
  const content = "export function start() { return (navigator.serviceWorker as any)['register'].call(navigator.serviceWorker, './sw.js'); }";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ content, reasons }));
  expect(reasons).toContain("SOURCE_SERVICE_WORKER_LOADER_UNSUPPORTED");
});
test("quoted SDK receiver revocable helper cannot hide traps behind any", () => {
  const content = "export function start() { return (Proxy as any)['revocable'].call(Proxy, {}, { get: () => 1 }); }";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ content, reasons }));
  expect(reasons).toContain("SOURCE_PROXY_UNSUPPORTED");
});
test("follow-up return await preserves a proven native promise", () => {
  const content = "export async function start() { return await Promise.resolve(1); }";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ content, reasons }));
  expect(reasons).not.toContain("SOURCE_ASYNC_RETURN_UNSUPPORTED");
});
test("follow-up SDK revocable proxy cannot hide a trap invocation", () => {
  const content = "const trap = () => 1; export function start() { return Proxy.revocable({}, { get: trap }).proxy.key; }";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ content, reasons }));
  expect(reasons).toContain("SOURCE_PROXY_UNSUPPORTED");
});
test("follow-up assertion cannot hide a real SDK service worker receiver", () => {
  const content = "export function start() { return (navigator.serviceWorker as any).register('./sw.js'); }";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ content, reasons }));
  expect(reasons).toContain("SOURCE_SERVICE_WORKER_LOADER_UNSUPPORTED");
});
for (const [content, reason] of [
  ["const value = { [Symbol.toPrimitive]() { return 1; } }; export function start() { return '' + value; }", "COERCION_UNSUPPORTED"],
  ["const value = { then() { return 1; } }; export async function start() { return value; }", "ASYNC_RETURN_UNSUPPORTED"],
  ["const trap = () => 1; const value = new Proxy({}, { get: trap }); export function start() { return value.key; }", "PROXY_UNSUPPORTED"],
  ["export function start() { return navigator.serviceWorker.register('./sw.js', { type: 'module' }); }", "SERVICE_WORKER_LOADER_UNSUPPORTED"],
] as const) test(`direct ${reason} refuses hidden invocation`, () => {
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  const js = inspectJavaScriptSource("/fixture/main.js", content).reasons;
  console.info(JSON.stringify({ content, reasons, js }));
  expect(reasons).toContain(`SOURCE_${reason}`);
  expect(js).toContain(`JAVASCRIPT_${reason}`);
});
for (const [content, reason] of [
  ["const value = { [Symbol.toPrimitive]() { return 1; } }; export function start() { return `${value}`; }", "COERCION_UNSUPPORTED"],
  ["export function start(input: number) { return input + 1; }", "COERCION_UNSUPPORTED"],
  ["import { base } from './dep.mjs'; export function bridge() { return base() + 1; }", "COERCION_UNSUPPORTED"],
  ["const value = { then() { return 1; } }; export const start = async () => value;", "ASYNC_RETURN_UNSUPPORTED"],
  ["const Factory = Proxy; export function start() { return new Factory({}, {}); }", "PROXY_UNSUPPORTED"],
  ["const register = navigator.serviceWorker.register; export function start() { return register.call(navigator.serviceWorker, './sw.js'); }", "SERVICE_WORKER_LOADER_UNSUPPORTED"],
  ["const { register } = navigator.serviceWorker; export function start() { return register('./sw.js'); }", "SERVICE_WORKER_LOADER_UNSUPPORTED"],
] as const) test(`unmodeled family refuses ${content}`, () => {
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).toContain(`SOURCE_${reason}`);
});
test("proven primitives, native promises, plain returns and own names preserve their domain", () => {
  for (const content of [
    "const value = 1; export function start() { return value + value; }",
    "export function start(value) { return `${typeof value}:${!!value}`; }",
    "export async function start() { return 1 + 1; }",
    "export async function start() { return Promise.resolve(1); }",
    "export async function start() { return await Promise.resolve(1); }",
    "export async function start() { return await 1; }",
    "export async function start() { return import('./dep.mjs'); }",
    "const value = { then() { return 1; } }; export function start() { return value; }",
    "const value = { then() { return 1; } }; export async function start() { function inner() { return value; } return 1; }",
    "const Proxy = Map; export function start() { return new Proxy(); }",
    "const Proxy = { revocable() { return {proxy: {key: 1}}; } }; export function start() { return Proxy.revocable().proxy.key; }",
    "const Proxy = { revocable() { return {proxy: {key: 1}}; } }; export function start() { return (Proxy as any)['revocable'].call(Proxy).proxy.key; }",
    "const navigator = { serviceWorker: { register(value) { return value; } } }; export function start() { return (navigator.serviceWorker as any)['register'].call(navigator.serviceWorker, 'ordinary'); }",
    "const navigator = { serviceWorker: { register(value) { return value; } } }; export function start() { return navigator.serviceWorker.register('ordinary'); }",
  ]) {
    const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content], ["/fixture/dep.mjs", "export function dep() { return 1; }"]]));
    expect(reasons.filter(reason => /SOURCE_(COERCION|ASYNC_RETURN|PROXY|SERVICE_WORKER_LOADER)_UNSUPPORTED/.test(reason))).toEqual([]);
  }
});
