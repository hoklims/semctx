import {expect,test} from "bun:test";
import {inspectModuleConfiguration} from "../src";
for(const extension of ["ts","mjs"])for(const [name,source] of [
 ["Number","function helper(){return 1;}const value={valueOf:helper};export function run(){return Number(value);}"],
 ["array locale","function helper(){return 'one';}const value={toLocaleString:helper};export function run(){return [value].toLocaleString();}"],
]as const)test(`${name} ${extension} requires primitive coercion provenance`,()=>{
 const path=`/fixture/main.${extension}`;expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,source]]))).toContain("SOURCE_COERCION_UNSUPPORTED");
});
test("SDK primitives and ordinary local homonyms stay distinct",()=>{
 for(const source of [
  "export function run(){return Number();}","export function run(){return Number(1);}","export function run(){return Number(true);}","export function run(){return Number('2');}","export function run(){return Number(2n);}",
  "function helper(){return 1;}export function run(){return Boolean({valueOf:helper});}",
  "export function run(){return [1,'one',true,null,undefined].toLocaleString();}","export function run(){return [].toLocaleString();}",
  "export function run(){return [1].toLocaleString('en-US',{maximumFractionDigits:0});}",
  "function Number(_value:unknown){return 1;}function helper(){return 1;}export function run(){return Number({valueOf:helper});}",
  "const value={toLocaleString(){return 'local';}};export function run(){return value.toLocaleString();}",
 ]){const path="/fixture/main.ts";expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,source]]))).toEqual([]);}
});
test("locale arguments with hooks cannot prove primitive option values",()=>{
 for(const source of [
  "function helper(){return 'en-US';}export function run(){return [1].toLocaleString([{toString:helper}] as any);}",
  "function helper(){return 1;}export function run(){return [1].toLocaleString('en-US',{minimumFractionDigits:{valueOf:helper}} as any);}",
 ]){const path="/fixture/main.ts";expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,source]]))).toContain("SOURCE_COERCION_UNSUPPORTED");}
});
