import { expect, test } from "bun:test";
import { inspectModuleConfiguration } from "../src";

for (const extension of ["ts", "mjs"]) for (const [name, source] of [
  ["unresolved host launcher", "export function run(){return Bun.spawnSync(['bun','./src/hidden.ts']);}"],
  ["prototype setter", "function helper(){return 1;}const value={__proto__:{toString:helper}};export function run(){return value.toString();}"],
  ["import meta callable", "const pages=import.meta.glob('./pages/*.mjs',{eager:true});export function run(){return pages['./pages/hidden.mjs'];}"],
] as const) test(`${name} ${extension} cannot establish admission`, () => {
  const path = `/fixture/main.${extension}`;
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]])).length).toBeGreaterThan(0);
});

test("captured lexical and SDK callees and metadata reads remain distinct", () => {
  for (const source of [
    "const Bun={spawnSync(_args:string[]){return 1;}};export function run(){return Bun.spawnSync(['plain','data']);}",
    "function helper(){return 1;}const value={['__proto__']:{toString:helper}};export function run(){return 1;}",
    "export function run(){return import.meta.url;}",
    "export function run(){return Math.abs(1);}",
    "export function run(){return JSON.stringify({value:1});}",
    "export function run(){return console.log('ordinary SDK data');}",
  ]) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toEqual([]);
  }
});

test("ordinary native process members, metadata aliases and closed prototypes retain their domain", () => {
  for (const source of [
    "export function run(){return process.cwd();}",
    "export function run(){process.stdout.write('ordinary data');return 1;}",
    "export function run(){return globalThis.process.cwd();}",
    "export function run(){return global.process.cwd();}",
    "const url=import.meta.url;export function run(){return url;}",
    "const meta=import.meta;const {url}=meta;export function run(){return url;}",
    "const value={__proto__:null};export function run(){return 1;}",
    "const value={__proto__:{value:1}};export function run(){return 1;}",
    "const value={__proto__(){return 1;}};export function run(){return value.__proto__();}",
    "const __proto__=1;const value={__proto__};export function run(){return 1;}",
    "import { receiver } from 'opaque';export function run(){return receiver.operation('ordinary data');}",
  ]) {
    const path = "/fixture/main.ts";
    const snapshot = new Map([[path,source],["/fixture/package.json",'{"dependencies":{"opaque":"1.0.0"}}']]);
    expect(inspectModuleConfiguration(path,"/fixture",snapshot)).toEqual([]);
  }
});

test("unproven ambient member roots and escaped metadata do not gain data proof", () => {
  for (const source of [
    "const host=Bun;export function run(){return host.spawnSync(['plain','data']);}",
    "const {spawnSync}=Bun;export function run(){return spawnSync.call(null,['plain','data']);}",
    "const load=import.meta.glob;export function run(){return load;}",
    "const meta=import.meta;const {glob:load}=meta;export function run(){return load('literal data');}",
  ]) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path,"/fixture",new Map([[path,source]])).length).toBeGreaterThan(0);
  }
});
