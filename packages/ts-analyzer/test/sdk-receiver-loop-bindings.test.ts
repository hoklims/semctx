import { expect, test } from "bun:test";
import { extractTypeScript, inspectModuleConfiguration } from "../src";

test("an SDK-shaped annotation cannot prove a locally initialized callable member", () => {
  const path = "/fixture/main.ts";
  const source = "function hidden(){return 1;}const env:typeof globalThis={parseInt:hidden} as unknown as typeof globalThis;export function run(){return env.parseInt('1');}";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]));
  console.info(JSON.stringify({ name: "SDK-shaped local member", reasons }));
  expect(reasons).toContain("SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED");
});

test("actual SDK and retained own callable members keep distinct origins", () => {
  const path = "/fixture/main.ts";
  for (const source of [
    "export function run(){return globalThis.parseInt('1');}",
    "class Env{static parseInt(_value){return 1;}}export function run(){return Env.parseInt('1');}",
  ]) expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toEqual([]);
});

const loopWrites = [
  ["for-of identifier", "for(load of [()=>({then:hidden})]){}"],
  ["for-of array target", "for([load] of [[()=>({then:hidden})]]){}"],
  ["for-of object target", "for({load} of [{load:()=>({then:hidden})}]){}"],
  ["for-in identifier", "for(load in {replacement:1}){}"],
] as const;
for (const extension of ["ts", "mjs"]) for (const [name, loop] of loopWrites) test(`${name} ${extension} invalidates async callee authority`, () => {
  const path = `/fixture/main.${extension}`;
  const source = `function hidden(){return 1;}async function load(){return 1;}export async function run(){${loop}await load();return 1;}`;
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]));
  console.info(JSON.stringify({ name, extension, reasons }));
  expect(reasons).toContain("SOURCE_AWAIT_UNSUPPORTED");
});

for (const extension of ["ts", "mjs"]) for (const [name, loop] of [
  ["identifier for-of", "for(value of [()=>hidden]){}"],
  ["array for-of", "for([value] of [[()=>hidden]]){}"],
  ["identifier for-in", "for(value in {replacement:1}){}"],
] as const) test(`${name} ${extension} invalidates primitive-return authority for opaque data`, () => {
  const path = `/fixture/main.${extension}`;
  const source = `import {write} from 'opaque';function hidden(){return 1;}function value(){return 1;}export function run(){${loop}return write(value());}`;
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, source], ["/fixture/package.json", '{"dependencies":{"opaque":"1.0.0"}}']]));
  console.info(JSON.stringify({ name: "loop primitive-return", extension, loop, reasons }));
  expect(reasons).toContain("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED");
});

for (const extension of ["ts", "mjs"]) test(`ordinary iteration and separate loop bindings ${extension} do not revoke unwritten callees`, () => {
  const path = `/fixture/main.${extension}`;
  for (const source of [
    "async function load(){return 1;}export async function run(){for(const load of [1]){}await load();return 1;}",
    "async function load(){return 1;}export async function run(){for(const key in {replacement:1}){}await load();return 1;}",
    "async function load(){return 1;}export async function run(){for(const item of [1]){}await load();return 1;}",
    "import {write} from 'opaque';function value(){return 1;}export function run(){for(const value of [1]){}return write(value());}",
  ]) expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source], ["/fixture/package.json", '{"dependencies":{"opaque":"1.0.0"}}']]))).toEqual([]);
});

test("SDK-shaped local member refusal does not invent a run-to-hidden call endpoint", () => {
  const path = "/fixture/main.ts"; const hidden = "/fixture/hidden.ts";
  const source = "import {hidden} from './hidden';const env:typeof globalThis={parseInt:hidden} as unknown as typeof globalThis;export function run(){return env.parseInt('1');}";
  const snapshot = new Map([[path, source], [hidden, "export function hidden(){return 1;}"]]);
  const facts = extractTypeScript([path, hidden], "/fixture", snapshot);
  console.info(JSON.stringify({ name: "no invented local member edge", calls: facts.calls }));
  expect(facts.calls.some(call => call.callerSymbolPath === "run" && call.calleeRelPath === "hidden.ts" && call.calleeSymbolPath === "hidden")).toBe(false);
});
