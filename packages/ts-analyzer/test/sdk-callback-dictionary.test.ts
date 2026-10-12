import {expect,test} from "bun:test";
import {inspectModuleConfiguration} from "../src";
for(const extension of ["ts","mjs"])test(`SDK callback dictionary ${extension} refuses hidden invocation`,()=>{
 const path=`/fixture/main.${extension}`;const source="function helper(){return 1;}export function run(){return new ReadableStream({start:helper});}";
 expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,source]]))).toContain("SOURCE_SDK_CALLBACK_UNSUPPORTED");
});
test("actual SDK closed data and local function homonyms stay distinct",()=>{
 for(const source of [
  "export function run(){return new ReadableStream();}","export function run(){return new ReadableStream({});}",
  "export function run(){return new ReadableStream({}, {highWaterMark:1});}",
  "export function run(){return new ReadableStream({start:undefined});}",
  "function ReadableStream(_source:unknown){return 1;}function helper(){return 1;}export function run(){return ReadableStream({start:helper});}",
  "const api={create(_source:unknown){return 1;}};function helper(){return 1;}export function run(){return api.create({start:helper});}",
 ]){const path="/fixture/main.ts";expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,source]]))).toEqual([]);}
});
test("ordinary SDK primitive and object methods are not callback dictionary slots",()=>{
 const path="/fixture/main.ts";const source="export function run(){return new URL('./x',import.meta.url);}";
 expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,source]]))).toEqual([]);
});
