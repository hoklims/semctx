import { expect, test } from "bun:test";
import { inspectModuleConfiguration } from "../src";

const cases = [
  ["in key", "function helper(){return 'x';} const key={toString:helper}; const target={x:1}; export function run(){return (key as any) in target;}", "SOURCE_COERCION_UNSUPPORTED"],
  ["global descriptor", "function helper(){return 1;} Object.defineProperty(globalThis,'Math',{value:{random:helper}}); export function run(){return Math.random();}", "SOURCE_SDK_GLOBAL_MUTATION_UNSUPPORTED"],
] as const;
for (const [name, source, reason] of cases) for (const extension of ["ts", "mjs"]) test(`${name} ${extension} refuses hidden invocation`, () => {
  const path=`/fixture/main.${extension}`;
  const content=extension === "mjs" ? source.replace(" as any", "") : source;
  const reasons=inspectModuleConfiguration(path,"/fixture",new Map([[path,content]]));
  console.info(JSON.stringify({name,extension,reasons})); expect(reasons).toContain(reason);
});
test("native in coercion and descriptor replacement invoke the hidden helper", () => {
  for (const source of [
    "function helper(){console.log('IN_CALLED');return 'x'};const key={toString:helper};if(!(key in {x:1}))throw Error('key mismatch');",
    "function helper(){console.log('GLOBAL_CALLED');return 7};Object.defineProperty(globalThis,'Math',{value:{random:helper}});if(Math.random()!==7)throw Error('global mismatch');",
  ]) {
    const result=Bun.spawnSync([process.execPath,"-e",source],{stdout:"pipe",stderr:"pipe"});
    expect(result.exitCode).toBe(0); expect(new TextDecoder().decode(result.stdout)).toContain("_CALLED");
  }
});
test("primitive keys and ordinary local descriptor targets stay distinct", () => {
  for (const source of [
    "export function run(){return 'x' in {x:1};}",
    "const key='x';export function run(){return key in {x:1};}",
    "const globalThis={Math:{random(){return 1;}}};Object.defineProperty(globalThis,'Math',{value:{random(){return 2;}}});export function run(){return globalThis.Math.random();}",
    "const target={};Object.defineProperty(target,'value',{value:1});export function run(){return 1;}",
  ]) for (const extension of ["ts","mjs"]) {
    const path=`/fixture/main.${extension}`; expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,source]]))).toEqual([]);
  }
});
