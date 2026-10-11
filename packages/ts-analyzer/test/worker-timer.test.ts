import { expect, test } from "bun:test";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";
const path = "/fixture/main.ts";
for (const [content, reason] of [
  ["export function start() { return new Worker('./worker.js', { type: 'module' }); }", "WORKER_LOADER_UNSUPPORTED"],
  ["export function start() { return setTimeout(\"import('./hidden.js')\", 0); }", "TIMER_EVALUATION_UNSUPPORTED"],
] as const) test(`direct SDK ${reason} refuses hidden dependency`, () => {
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  const js = inspectJavaScriptSource("/fixture/main.js", content).reasons;
  console.info(JSON.stringify({ content, reasons, js }));
  expect(reasons).toContain(`SOURCE_${reason}`);
  expect(js).toContain(`JAVASCRIPT_${reason}`);
});

for (const content of [
  "const Background = Worker; export function start() { return new Background('./worker.js'); }",
  "const Background = globalThis.SharedWorker; export function start() { return new Background(new URL('./worker.js', import.meta.url)); }",
]) test(`SDK worker transparent alias refuses ${content}`, () => {
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).toContain("SOURCE_WORKER_LOADER_UNSUPPORTED");
});

for (const content of [
  "const later = setTimeout; export function start() { return later('hidden()', 0); }",
  "const { setTimeout: later } = globalThis; export function start() { return later('hidden()', 0); }",
  "export function start(handler: string | (() => void)) { return window.setTimeout(handler, 0); }",
  "export function start(handler: unknown) { return setInterval(handler, 0); }",
  "export function start<T>(handler: T) { return setTimeout(handler, 0); }",
  "export function start() { return setTimeout.call(null, 'hidden()', 0); }",
  "export function start() { return globalThis.setInterval.apply(null, ['hidden()', 0]); }",
  "const later = setTimeout.bind(globalThis); export function start() { return later('hidden()', 0); }",
  "export function start() { return ({ later: setTimeout }).later('hidden()', 0); }",
  "const { setTimeout: schedule } = globalThis; const later = schedule; export function start() { return later.call(null, 'hidden()', 0); }",
]) test(`SDK timer evaluator or unproved escape refuses ${content}`, () => {
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).toContain("SOURCE_TIMER_EVALUATION_UNSUPPORTED");
});

test("known callbacks, ordinary names, Node timers and nonworker SDK constructors preserve their domain", () => {
  for (const content of [
    "export function start() { return setTimeout(() => 1, 0); }",
    "export function start() { return (setTimeout)(() => 1, 0); }",
    "const later = (setTimeout); export function start() { return later(() => 1, 0); }",
    "const later = globalThis.setTimeout; export function start(callback: () => void) { return later(callback, 0); }",
    "const setTimeout = (value: string) => value; export function start() { return setTimeout('ordinary'); }",
    "const own = { setTimeout(value: string) { return value; } }; export function start() { return own.setTimeout('ordinary'); }",
    "import { setTimeout } from 'node:timers'; export function start() { return setTimeout('ordinary', 0); }",
  ]) expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).not.toContain("SOURCE_TIMER_EVALUATION_UNSUPPORTED");
  const content = "const Worker = Map; export function start() { return [new Worker(), new Error('x'), new URL('https://example.invalid')]; }";
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).not.toContain("SOURCE_WORKER_LOADER_UNSUPPORTED");
  expect(inspectJavaScriptSource("/fixture/main.js", "export function start() { return setTimeout(() => 1, 0); }").reasons).not.toContain("JAVASCRIPT_TIMER_EVALUATION_UNSUPPORTED");
});
