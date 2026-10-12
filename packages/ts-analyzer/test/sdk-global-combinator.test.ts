import { expect, test } from "bun:test";
import { inspectModuleConfiguration } from "../src";

for (const [name, content, reason] of [
  ["global replacement", "function helper() { return 1; } Math = { ...Math, random: helper }; export function run() { return Math.random(); }", "SDK_GLOBAL_MUTATION_UNSUPPORTED"],
  ["explicit primitive hook", "function helper() { return 'value'; } const value = {}; value[Symbol.toPrimitive] = helper; export function run() { return String(value); }", "PROTOCOL_MUTATION_UNSUPPORTED"],
  ["combinator thenable", "function helper() {} export function run() { return Promise.all([{ then: helper }]); }", "PROMISE_ASSIMILATION_UNSUPPORTED"],
] as const) test(name, () => {
  const path = "/fixture/main.ts"; const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ name, reasons }));
  expect(reasons).toContain(`SOURCE_${reason}`);
});
test("native global replacement and nested thenable invoke retained code", () => {
  for (const content of [
    "function helper(){console.log('GLOBAL_CALLED');return 7} Math={...Math,random:helper};if(Math.random()!==7)throw Error('math mismatch');",
    "function helper(){console.log('THEN_CALLED')} Promise.all([{then:helper}]);",
  ]) {
    const result = Bun.spawnSync([process.execPath, "-e", content], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0); expect(new TextDecoder().decode(result.stdout)).toContain("_CALLED");
  }
});
test("ordinary local bindings, primitive Promise values and unmodified SDK values remain distinct", () => {
  for (const content of [
    "let Math = { random() { return 1; } }; Math = { random() { return 2; } }; export function run() { return Math.random(); }",
    "export function run() { return Promise.all([1, Promise.resolve(2)]); }",
    "export function run() { return Math.random(); }",
  ]) {
    const path = "/fixture/main.ts"; expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).toEqual([]);
  }
});
test("combinator aliases and mutable container inputs retain assimilation refusal", () => {
  for (const content of [
    "const values = [1]; export function run() { return Promise.all(values); }",
    "function helper() {} const { all: gather } = Promise; export function run() { return gather.call(Promise, [{ then: helper }]); }",
  ]) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).toContain("SOURCE_PROMISE_ASSIMILATION_UNSUPPORTED");
  }
});

test("SDK binding writes follow assignment targets while local homonyms stay ordinary", () => {
  for (const content of [
    "function helper(){return 1;} [Math]=[{random:helper}]; export function run(){return Math.random();}",
    "function helper(){return 1;} ({Math}={Math:{random:helper}}); export function run(){return Math.random();}",
  ]) {
    const path="/fixture/main.ts";
    expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,content]]))).toContain("SOURCE_SDK_GLOBAL_MUTATION_UNSUPPORTED");
  }
  const path="/fixture/main.ts";
  expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,"let Math={random(){return 1;}}; [Math]=[{random(){return 2;}}]; export function run(){return Math.random();}"]]))).toEqual([]);
});
