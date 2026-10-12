import { expect, test } from "bun:test";
import { inspectModuleConfiguration } from "../src";

const wasmBytes = "new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,2,12,1,3,101,110,118,4,104,111,111,107,0,0,8,1,0])";
for (const [name, source, reason] of [
  ["wasm start", `function helper(){} const bytes=${wasmBytes};export function run(){return WebAssembly.instantiate(bytes,{env:{hook:helper}});}`, "SOURCE_WASM_INSTANTIATION_UNSUPPORTED"],
  ["script insertion", "export function run(){const script=document.createElement('script');script.src='./hidden.js';document.head.append(script);}", "SOURCE_SCRIPT_INSERTION_UNSUPPORTED"],
] as const) for (const extension of ["ts", "mjs"]) test(`${name} ${extension} refuses runtime code`, () => {
  const path = `/fixture/main.${extension}`;
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toContain(reason);
});

test("native wasm instantiation invokes an imported helper through its start function", async () => {
  let calls = 0;
  const bytes = new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,2,12,1,3,101,110,118,4,104,111,111,107,0,0,8,1,0]);
  await WebAssembly.instantiate(bytes, { env: { hook() { calls++; } } });
  expect(calls).toBe(1);
});

test("inert SDK operations and ordinary local lookalikes retain admission", () => {
  for (const source of [
    "export function run(){const script=document.createElement('script');script.src='./hidden.js';return 1;}",
    "export function run(){const div=document.createElement('div');document.head.append(div);}",
    "export function run(){document.head.append('plain data');}",
    `const bytes=${wasmBytes};export function run(){return WebAssembly.validate(bytes);}`,
    `const bytes=${wasmBytes};export function run(){return WebAssembly.compile(bytes);}`,
    "const WebAssembly={instantiate(_bytes:unknown,_imports:unknown){return 1;}};export function run(){return WebAssembly.instantiate(1,{env:{hook(){}}});}",
    "const document={createElement(_tag:string){return {src:''};},head:{append(_value:unknown){}}};export function run(){const script=document.createElement('script');script.src='./hidden.js';document.head.append(script);}",
  ]) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toEqual([]);
  }
});

test("a local value annotated as the WASM SDK does not acquire runtime provenance", () => {
  const path = "/fixture/main.ts";
  const source = "const wasm:typeof WebAssembly={instantiate(){return 1;}} as unknown as typeof WebAssembly;export function run(){return wasm.instantiate(null as unknown as BufferSource,{});}";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]));
  expect(reasons).toEqual(["SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED"]);
  expect(reasons).not.toContain("SOURCE_WASM_INSTANTIATION_UNSUPPORTED");
});

test("typed SDK aliases preserve the actual runtime boundary", () => {
  for (const [source, reason] of [
    [`const wasm:typeof WebAssembly=WebAssembly;const bytes=${wasmBytes};export function run(){return wasm.instantiate(bytes,{});}`, "SOURCE_WASM_INSTANTIATION_UNSUPPORTED"],
    ["const dom:Document=document;export function run(){const script=dom.createElement('script');dom.head.append(script);}", "SOURCE_SCRIPT_INSERTION_UNSUPPORTED"],
  ] as const) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toContain(reason);
  }
});
