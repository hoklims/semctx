import { expect, test } from "bun:test";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";

const source = (api: string): string => `function* helper() { console.log('ITERATOR_CALLED'); yield 7; } const values = [1]; ${api}.setPrototypeOf(values, { [Symbol.iterator]: helper }); export function run() { return [...values]; }`;
for (const [api, extension] of [["Object", "ts"], ["Object", "js"], ["Reflect", "ts"]] as const) test(`actual ${api} prototype replacement refuses ${extension}`, () => {
  const path = `/fixture/main.${extension}`; const content = source(api); const snapshot = new Map([[path, content]]);
  const reasons = extension === "js" ? inspectJavaScriptSource(path, content, "/fixture", snapshot).reasons : inspectModuleConfiguration(path, "/fixture", snapshot);
  console.info(JSON.stringify({ api, extension, reasons }));
  expect(reasons).toContain(`${extension === "js" ? "JAVASCRIPT" : "SOURCE"}_PROTOTYPE_MUTATION_UNSUPPORTED`);
});
test("native prototype replacement actually invokes the retained iterator", () => {
  for (const api of ["Object", "Reflect"]) {
    const result = Bun.spawnSync([process.execPath, "-e", source(api) + "if (run()[0] !== 7) throw new Error('iterator output mismatch');"], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0); expect(new TextDecoder().decode(result.stdout)).toContain("ITERATOR_CALLED");
  }
});
test("ordinary own mutators, type-only SDK use and unmodified arrays remain distinct", () => {
  for (const content of [
    "const Object = { setPrototypeOf(value, prototype) { return value; } }; export function run() { return Object.setPrototypeOf(1, null); }",
    "const Reflect = { setPrototypeOf(value, prototype) { return value; } }; export function run() { return Reflect.setPrototypeOf(1, null); }",
    "export type Mutator = typeof Object.setPrototypeOf; export function run() { return 1; }",
    "const values = [1]; export function run() { return [...values]; }",
  ]) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).not.toContain("SOURCE_PROTOTYPE_MUTATION_UNSUPPORTED");
  }
});
