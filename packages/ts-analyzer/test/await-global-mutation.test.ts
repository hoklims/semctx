import { expect, test } from "bun:test";
import { inspectModuleConfiguration } from "../src";

const cases = [
  [
    "reassigned async",
    "SOURCE_AWAIT_UNSUPPORTED",
    "async function load(){return 1;}load=()=>({then:hidden});export async function run(){await load();return 1;}"
  ],
  [
    "for await thenable",
    "SOURCE_AWAIT_UNSUPPORTED",
    "export async function run(){for await(const item of [{then:hidden}]){}return 1;}"
  ],
  [
    "plural global descriptor",
    "SOURCE_SDK_GLOBAL_MUTATION_UNSUPPORTED",
    "Object.defineProperties(globalThis,{Math:{value:{random:hidden}}});export function run(){return Math.random();}"
  ],
  [
    "reflect global set",
    "SOURCE_SDK_GLOBAL_MUTATION_UNSUPPORTED",
    "Reflect.set(globalThis,'Math',{random:hidden});export function run(){return Math.random();}"
  ],
  [
    "assign global namespace",
    "SOURCE_SDK_GLOBAL_MUTATION_UNSUPPORTED",
    "Object.assign(globalThis,{Math:{random:hidden}});export function run(){return Math.random();}"
  ]
] as const;

for (const extension of ["ts", "mjs"]) for (const [name, reason, body] of cases) {
  test(`${name} ${extension} refuses hidden invocation with its specific reason`, () => {
    const path = `/fixture/main.${extension}`;
    const source = `function hidden(){return 1;}${body}`;
    const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]));
    console.info(JSON.stringify({ name, extension, reasons }));
    expect(reasons).toContain(reason);
  });
}

for (const extension of ["ts", "mjs"]) test(`unaltered async, primitive for-await and local/data mutation ${extension} stay supported`, () => {
  const path = `/fixture/main.${extension}`;
  for (const source of [
    "async function load(){return 1;}export async function run(){await load();return 1;}",
    "export async function run(){for await(const item of [1,2]){}return 1;}",
    "export async function run(){for await(const item of [1,,2]){}return 1;}",
    "export async function run(){for await(const item of 'text'){}return 1;}",
    "export async function run(){for await(const item of [Promise.resolve(1)]){}return 1;}",
    "const load=async()=>1;export async function run(){await load();return 1;}",
    "const obj={async load(){return 1;}};export async function run(){await obj.load();return 1;}",
    "export async function run(){for(const item of [{then:()=>1}]){}return 1;}",
    "const globalThis={Math:{random:()=>1}};Object.defineProperties(globalThis,{Math:{value:{random:()=>2}}});export function run(){return 1;}",
    "const globalThis={Math:{random:()=>1}};Reflect.set(globalThis,'Math',{random:()=>2});export function run(){return 1;}",
    "const globalThis={Math:{random:()=>1}};Object.assign(globalThis,{Math:{random:()=>2}});export function run(){return 1;}",
    "const data={value:1};Object.assign(data,{value:2});Reflect.set(data,'value',3);Object.defineProperties(data,{value:{value:4}});export function run(){return 1;}",
  ]) expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toEqual([]);
});

for (const [name, source, expected] of [
  ["reassigned async", "function hidden(resolve){console.log('REASSIGNED_CALLED');resolve(1);} async function load(){return 1;}load=()=>({then:hidden});await load();", "REASSIGNED_CALLED"],
  ["for-await thenable", "function hidden(resolve){console.log('FOR_AWAIT_CALLED');resolve(1);}for await(const item of [{then:hidden}]){}", "FOR_AWAIT_CALLED"],
  ["plural descriptor", "function hidden(){console.log('DEFINE_PROPERTIES_CALLED');return 7;}Object.defineProperties(globalThis,{Math:{value:{random:hidden}}});if(Math.random()!==7)throw Error('replacement failed');", "DEFINE_PROPERTIES_CALLED"],
  ["reflect set", "function hidden(){console.log('REFLECT_SET_CALLED');return 7;}Reflect.set(globalThis,'Math',{random:hidden});if(Math.random()!==7)throw Error('replacement failed');", "REFLECT_SET_CALLED"],
  ["assign", "function hidden(){console.log('ASSIGN_CALLED');return 7;}Object.assign(globalThis,{Math:{random:hidden}});if(Math.random()!==7)throw Error('replacement failed');", "ASSIGN_CALLED"],
] as const) test(`native ${name} invokes the retained helper`, () => {
  const child = Bun.spawnSync([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(new TextDecoder().decode(child.stdout)).toContain(expected);
});

for (const extension of ["ts", "mjs"]) test(`async provenance follows replacement through aliases and destructuring ${extension}`, () => {
  const path = `/fixture/main.${extension}`;
  for (const body of [
    "async function load(){return 1;}load=()=>({then:hidden});const alias=load;export async function run(){await alias();return 1;}",
    "async function load(){return 1;}[load]=[()=>({then:hidden})];export async function run(){await load();return 1;}",
    "const obj={async load(){return 1;}};obj.load=()=>({then:hidden});export async function run(){await obj.load();return 1;}",
  ]) expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, `function hidden(){return 1;}${body}`]]))).toContain("SOURCE_AWAIT_UNSUPPORTED");
});

for (const extension of ["ts", "mjs"]) test(`for-await mutable container and spread origins do not prove element assimilation ${extension}`, () => {
  const path = `/fixture/main.${extension}`;
  for (const source of [
    "const values=[{then:()=>1}];export async function run(){for await(const item of values){}return 1;}",
    "const values=[1];values[0]={then:()=>1};export async function run(){for await(const item of values){}return 1;}",
    "const values=[{then:()=>1}];export async function run(){for await(const item of [...values]){}return 1;}",
  ]) expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toContain("SOURCE_AWAIT_UNSUPPORTED");
});
