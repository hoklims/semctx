import {expect,test} from "bun:test";
import {inspectModuleConfiguration} from "../src";
for(const extension of ["ts","mjs"])test(`SDK Math.max ${extension} requires primitive consumed values`,()=>{
 const path=`/fixture/main.${extension}`;const source="function helper(){return 1;}const value={valueOf:helper};export function run(){return Math.max(value as any,0);}";
 expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,extension==="mjs"?source.replace(" as any",""):source]]))).toContain("SOURCE_COERCION_UNSUPPORTED");
});
test("SDK numeric arguments, zero arity, ignored extras and local Math stay distinct",()=>{
 for(const source of [
  "export function run(){return Math.max(1,2,3);}","export function run(){return Math.abs(1);}","export function run(){return Math.random();}",
  "function helper(){return 1;}const value={valueOf:helper};export function run(){return Math.random(value as any);}",
  "function helper(){return 1;}const value={valueOf:helper};export function run(){return Math.abs(1,value as any);}",
  "const Math={max(_value:unknown,_other:number){return 1;}};function helper(){return 1;}export function run(){return Math.max({valueOf:helper},0);}",
 ]){const path="/fixture/main.ts";expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,source]]))).toEqual([]);}
});
test("fixed and rest Math signatures consume the actual numeric coordinates",()=>{
 for(const call of ["Math.max(0,value as any)","Math.abs(value as any)"]){
  const path="/fixture/main.ts";const source=`function helper(){return 1;}const value={valueOf:helper};export function run(){return ${call};}`;
  expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,source]]))).toContain("SOURCE_COERCION_UNSUPPORTED");
 }
});
