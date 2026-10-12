import { expect, test } from "bun:test";
import ts from "typescript";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";
const path = "/fixture/main.ts";
for (const [content, reason] of [
  ["const input = { valueOf() { return 1; } }; export function run() { return +input; }", "COERCION_UNSUPPORTED"],
  ["const audio = new AudioContext(); export function run() { return audio.audioWorklet.addModule('./processor.js'); }", "WORKLET_LOADER_UNSUPPORTED"],
] as const) test(`new implicit SDK operation refuses ${reason}`, () => {
  const inputs = new Map([[path, content]]);
  const reasons = inspectModuleConfiguration(path, "/fixture", inputs);
  const js = inspectJavaScriptSource("/fixture/main.js", content).reasons;
  console.info(JSON.stringify({ content, reasons, js }));
  expect(reasons).toContain(`SOURCE_${reason}`);
  expect(js).toContain(`JAVASCRIPT_${reason}`);
});
test("actual retained ES5 helper emission has an unmodeled tslib dependency", () => {
  const content = "export async function run() { return 1; }";
  const options = { target: ts.ScriptTarget.ES5, module: ts.ModuleKind.ESNext, importHelpers: true };
  const emitted = ts.transpileModule(content, { compilerOptions: options }).outputText;
  expect(emitted).toContain('from "tslib"');
  expect(emitted).toContain("__awaiter");
  expect(emitted).toContain("__generator");
  const inputs = new Map([[path, content], ["/fixture/tsconfig.json", '{"compilerOptions":{"target":"ES5","module":"ESNext","importHelpers":true}}']]);
  const reasons = inspectModuleConfiguration(path, "/fixture", inputs);
  console.info(JSON.stringify({ emitted, reasons }));
  expect(reasons).toContain("SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED");
});

test("known primitive operators, ordinary loader methods and non-emitting helper configurations remain distinct", () => {
  for (const content of [
    "export function run() { return +1; }",
    "export function run() { return 4 - 1; }",
    "export function run(value) { return !value; }",
    "export function run(value) { return typeof value; }",
    "export function run(value) { return value === null; }",
    "const own = { addModule(path) { return 1; } }; export function run() { return own.addModule('./file.js'); }",
  ]) {
    const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
    expect(reasons).not.toContain("SOURCE_COERCION_UNSUPPORTED");
    expect(reasons).not.toContain("SOURCE_WORKLET_LOADER_UNSUPPORTED");
  }
  const content = "export async function run() { return 1; }";
  const modern = new Map([[path, content], ["/fixture/tsconfig.json", '{"compilerOptions":{"target":"ES2022","module":"ESNext","importHelpers":true}}']]);
  expect(inspectModuleConfiguration(path, "/fixture", modern)).not.toContain("SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED");
  const inherited = new Map([[path, content], ["/fixture/tsconfig.json", '{"extends":"./tsconfig.base.json"}'],
    ["/fixture/tsconfig.base.json", '{"compilerOptions":{"target":"ES5","module":"ESNext","importHelpers":true}}']]);
  expect(inspectModuleConfiguration(path, "/fixture", inherited)).toContain("SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED");
  expect(inspectModuleConfiguration(path, "/fixture")).not.toContain("SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED");
});
