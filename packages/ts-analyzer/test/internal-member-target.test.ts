import { expect, test } from "bun:test";
import { inspectModuleConfiguration } from "../src";

for (const extension of ["ts","mjs"]) test(`internal erased member ${extension} cannot prove a call target`, () => {
  const path=`/fixture/main.${extension}`;
  const source="function helper(){return 1;}const holder:any={};holder.invoke=helper;export function run(){return holder.invoke();}";
  expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,extension==="mjs"?source.replace(":any",""):source]])).length).toBeGreaterThan(0);
});

test("actual internal methods, SDK primitive calls and explicit external bindings remain distinct",()=>{
  for(const source of [
    "function helper(){return 1;}const holder={invoke:helper};export function run(){return holder.invoke();}",
    "const holder={invoke(){return 1;}};export function run(){return holder.invoke();}",
    "class Holder{invoke(){return 1;}};export function run(holder:Holder){return holder.invoke();}",
    "export function run(){return JSON.stringify({value:1});}",
    "import {receiver} from 'opaque';export function run(){return receiver.invoke('data');}",
  ]) {
    const path="/fixture/main.ts";
    expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,source],["/fixture/package.json",'{"dependencies":{"opaque":"1.0.0"}}']]))).toEqual([]);
  }
});
