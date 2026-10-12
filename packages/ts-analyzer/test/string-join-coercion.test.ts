import {expect,test} from "bun:test";
import {inspectModuleConfiguration} from "../src";
for(const extension of ["ts","mjs"])for(const [name,source] of [
  ["SDK String hook","function helper(){return 'one';}const value={toString:helper};export function run(){return String(value);}"],
  ["SDK join hook","function helper(){return 'one';}const value={toString:helper};export function run(){return [value].join();}"],
]as const)test(`${name} ${extension} requires primitive coercion provenance`,()=>{
  const path=`/fixture/main.${extension}`;expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,source]]))).toContain("SOURCE_COERCION_UNSUPPORTED");
});
test("primitive values and real local homonyms remain distinct",()=>{
  for(const source of [
    "export function run(){return String(1);}","export function run(){return String(true);}","export function run(){return Number(1);}","export function run(){return Boolean(true);}",
    "const value='one';export function run(){return [value,2,true,null,undefined].join();}",
    "function String(_value:unknown){return 'local';}function helper(){return 'one';}export function run(){return String({toString:helper});}",
    "const value={join(){return 'local';}};export function run(){return value.join();}",
  ]){const path="/fixture/main.ts";expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,source]]))).toEqual([]);}
});
