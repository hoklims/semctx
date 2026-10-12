import { expect, test } from "bun:test";
import { inspectModuleConfiguration } from "../src";

for (const extension of ["ts", "mjs"]) for (const [name, source, reason] of [
  ["Date valueOf", "function helper(){return 1;}const value={valueOf:helper};export function run(){return new Date(value as any);}", "SOURCE_COERCION_UNSUPPORTED"],
  ["cluster executable", "import cluster from 'node:cluster';export function run(){cluster.setupPrimary({exec:'./src/hidden.mjs'});return cluster.fork();}", "SOURCE_PROCESS_LAUNCH_UNSUPPORTED"],
  ["document.write", "export function run(){document.write('<script src=\"./hidden.js\"></script>');}", "SOURCE_DOCUMENT_WRITE_UNSUPPORTED"],
  ["document.writeln", "export function run(){document.writeln('<script src=\"./hidden.js\"></script>');}", "SOURCE_DOCUMENT_WRITE_UNSUPPORTED"],
] as const) test(`${name} ${extension} refuses hidden runtime dependency`, () => {
  const path = `/fixture/main.${extension}`;
  const content = extension === "mjs" ? source.replace(" as any", "") : source;
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).toContain(reason);
});

test("primitive Date arguments, intrinsic copies, ordinary calls and local names remain distinct", () => {
  for (const source of [
    "export function run(){return new Date();}",
    "export function run(){return new Date(1);}",
    "const value=1;const C=Date;export function run(){return new C(value);}",
    "export function run(){return new Date('2020-01-01');}",
    "export function run(){return new Date(2020,1,2,3,4,5,6);}",
    "const value=new Date(1);export function run(){return new Date(value);}",
    "function helper(){return 1;}const value={valueOf:helper};export function run(){return Date(value as any);}",
    "function helper(){return 1;}const value={valueOf:helper};export function run(){return new Date(2020,1,2,3,4,5,6,value as any);}",
  ]) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toEqual([]);
  }
  const path = "/fixture/main.ts";
  const local = "class Date {constructor(_value:unknown){}}function helper(){return 1;}const value={valueOf:helper};export function run(){return new Date(value);}";
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, local]]))).toEqual(["SOURCE_CONSTRUCTION_UNSUPPORTED"]);
});

test("ordinary cluster bindings, unused imports and SDK data reads remain distinct", () => {
  for (const source of [
    "const cluster={setupPrimary(_options:unknown){},fork(){return 1;}};export function run(){cluster.setupPrimary({exec:'plain-data'});return cluster.fork();}",
    "import cluster from 'node:cluster';export function run(){return 1;}",
    "import cluster from 'node:cluster';export function run(){return cluster.isPrimary;}",
    "import type cluster from 'node:cluster';export type Cluster=typeof cluster;export function run(){return 1;}",
  ]) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).not.toContain("SOURCE_PROCESS_LAUNCH_UNSUPPORTED");
  }
});

test("ordinary local Document lookalikes and unrelated SDK data calls remain distinct", () => {
  for (const source of [
    "const document={write(_value:string){},writeln(_value:string){}};export function run(){document.write('<script src=\"hidden.js\"></script>');document.writeln('text');}",
    "export function run(){document.createTextNode('<script src=\"hidden.js\"></script>');}",
  ]) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toEqual([]);
  }
});

test("a typed local constructor does not acquire SDK Date runtime origin", () => {
  const path = "/fixture/main.ts";
  const source = "const env:typeof globalThis={Date:class{constructor(_value:unknown){}}} as unknown as typeof globalThis;function helper(){return 1;}const value={valueOf:helper};export function run(){return new env.Date(value as any);}";
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).not.toContain("SOURCE_COERCION_UNSUPPORTED");
});

test("a typed local Date lookalike cannot confer intrinsic copy slots", () => {
  const path = "/fixture/main.ts";
  const source = "function helper(){return 1;}const env:typeof globalThis={Date:class{valueOf(){return helper();}}} as unknown as typeof globalThis;const value=new env.Date();export function run(){return new Date(value as any);}";
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toContain("SOURCE_COERCION_UNSUPPORTED");
});

for (let index = 0; index < 7; index++) test(`Date numeric argument ${index} requires primitive runtime provenance`, () => {
  const path = "/fixture/main.ts";
  const args = ["2020", "0", "1", "0", "0", "0", "0"];
  args[index] = "value as any";
  const source = `function helper(){return 1;}const value={valueOf:helper};export function run(){return new Date(${args.join(",")});}`;
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toContain("SOURCE_COERCION_UNSUPPORTED");
});

test("captured Date and Document aliases preserve their actual SDK boundary", () => {
  for (const [source, reason] of [
    ["const C=Date;function helper(){return 1;}const value={valueOf:helper};export function run(){return new C(value as any);}", "SOURCE_COERCION_UNSUPPORTED"],
    ["const doc:Document=document;export function run(){doc.write('ordinary HTML/text');}", "SOURCE_DOCUMENT_WRITE_UNSUPPORTED"],
  ] as const) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toContain(reason);
  }
  const path = "/fixture/main.ts";
  const source = "const doc:Document={write(_value:string){}} as unknown as Document;export function run(){doc.write('ordinary HTML/text');}";
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toEqual([]);
});

test("cluster module origin survives only the existing captured binding aliases", () => {
  for (const source of [
    "import {fork as launch} from 'node:cluster';const start=launch;export function run(){return start();}",
    "import * as cluster from 'cluster';const worker=cluster;export function run(){worker.setupPrimary({exec:'hidden.mjs'});return worker.fork();}",
    "import cluster from 'node:cluster';const {fork:start}=cluster;export function run(){return start();}",
    "import cluster from 'node:cluster';export function run(){cluster.setupPrimary({exec:'hidden.mjs'});return 1;}",
  ]) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toContain("SOURCE_PROCESS_LAUNCH_UNSUPPORTED");
  }
});
