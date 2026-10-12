import { expect, test } from "bun:test";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";

export const cases = [
  ["species", "function helper() {} Object.defineProperty(Array, Symbol.species, { value: helper }); export function run() { return [1, 2].slice(); }", "PROTOCOL_DESCRIPTOR_UNSUPPORTED"],
  ["sort", "const values = [{ toString() { return 'b'; } }, { toString() { return 'a'; } }]; export function run() { return values.sort(); }", "SORT_COERCION_UNSUPPORTED"],
  ["vm", "import { runInThisContext } from 'node:vm'; export function run() { return runInThisContext('7'); }", "RUNTIME_EVALUATION_UNSUPPORTED"],
] as const;
for (const [name, content, reason] of cases) for (const extension of ["ts", "js"]) test(`${name} implicit invocation refuses ${extension}`, () => {
  const path = `/fixture/main.${extension}`; const snapshot = new Map([[path, content]]);
  const reasons = extension === "js" ? inspectJavaScriptSource(path, content, "/fixture", snapshot).reasons : inspectModuleConfiguration(path, "/fixture", snapshot);
  console.info(JSON.stringify({ name, extension, reasons }));
  expect(reasons).toContain(`${extension === "js" ? "JAVASCRIPT" : "SOURCE"}_${reason}`);
});
test("native isolated cases observe the species, coercion and evaluated-code hooks", () => {
  for (const content of [
    "function helper() { console.log('SPECIES_CALLED'); } Object.defineProperty(Array,Symbol.species,{value:helper}); const result=[1,2].slice();if(result[0]!==1)throw Error('slice mismatch');",
    "const values=[{toString(){console.log('COERCION_CALLED');return 'b'}},{toString(){return 'a'}}];values.sort();",
    "import { runInThisContext } from 'node:vm';const result=runInThisContext('console.log(\"EVAL_CALLED\");7');if(result!==7)throw Error('eval mismatch');",
  ]) {
    const result = Bun.spawnSync([process.execPath, "-e", content], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0); expect(new TextDecoder().decode(result.stdout)).toContain("_CALLED");
  }
});
test("fresh primitive sort, own methods and ordinary Node data keep their distinct boundary", () => {
  for (const content of [
    "export function run() { return [2, 1].sort(); }",
    "const own = { sort() { return 1; } }; export function run() { return own.sort(); }",
    "function runInThisContext(value) { return value; } export function run() { return runInThisContext(1); }",
    "import { basename } from 'node:path'; export function run() { return basename('src/value.ts'); }",
  ]) {
    const path = "/fixture/main.ts"; const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
    expect(reasons).toEqual([]);
  }
});
test("aliases do not fabricate immutable sort elements or erase VM/species origins", () => {
  for (const [content, reason] of [
    ["const values = [2, 1]; export function run() { return values.sort(); }", "SORT_COERCION_UNSUPPORTED"],
    ["import * as vm from 'node:vm'; const { runInThisContext: evaluate } = vm; export function run() { return evaluate.call(vm, '7'); }", "RUNTIME_EVALUATION_UNSUPPORTED"],
    ["function helper() {} const { species: key } = Symbol; Object.defineProperty(Array, key, { value: helper }); export function run() { return [1].slice(); }", "PROTOCOL_DESCRIPTOR_UNSUPPORTED"],
  ] as const) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).toContain(`SOURCE_${reason}`);
  }
});

test("default comparator value proof unwraps assertions without trusting their type", () => {
  const path="/fixture/main.ts";
  expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,"const values=[{toString(){return 'b'}},{toString(){return 'a'}}]; export function run(){return values.sort(undefined as any);}"]]))).toContain("SOURCE_SORT_COERCION_UNSUPPORTED");
  expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,"export function run(){return [2,1].sort(undefined as any);}"]]))).toEqual([]);
});
