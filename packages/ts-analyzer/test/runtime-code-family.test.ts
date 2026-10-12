import { expect, test } from "bun:test";
import { inspectModuleConfiguration } from "../src";

const insertions = [
  "document.head.appendChild(script)",
  "document.head.insertBefore(script,null)",
  "document.head.replaceChild(script,document.head.firstChild)",
  "document.head.append(script)",
  "document.head.prepend(script)",
  "document.head.replaceChildren(script)",
  "document.body.before(script)",
  "document.body.after(script)",
  "document.body.replaceWith(script)",
  "document.body.insertAdjacentElement('beforeend',script)",
  "new Range().insertNode(script)",
] as const;

for (const extension of ["ts", "mjs"]) for (const [name, source, reason] of [
  ["streaming wasm start", "function helper(){}export function run(){return WebAssembly.instantiateStreaming(fetch('module.wasm'),{env:{hook:helper}});}", "SOURCE_WASM_INSTANTIATION_UNSUPPORTED"],
  ["nullable SDK callback", "function helper(){return 1;}const button=document.createElement('button');button.onclick=helper;export function run(){button.click();}", "SOURCE_SDK_CALLABLE_MUTATION_UNSUPPORTED"],
  ...insertions.map(insertion => [insertion, `export function run(){const script=document.createElement('script');script.src='./hidden.js';${insertion};}`, "SOURCE_SCRIPT_INSERTION_UNSUPPORTED"] as const),
] as const) test(`${name} ${extension} retains runtime family refusal`, () => {
  const path = `/fixture/main.${extension}`;
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toContain(reason);
});

test("SDK aliases retain actual instantiation and insertion provenance", () => {
  for (const [source, reason] of [
    ["const wasm:typeof WebAssembly=WebAssembly;export function run(){return wasm.instantiateStreaming(fetch('module.wasm'),{});}", "SOURCE_WASM_INSTANTIATION_UNSUPPORTED"],
    ["const dom:Document=document;export function run(){const script=dom.createElement('script');const alias=script;dom.head.appendChild(alias);}", "SOURCE_SCRIPT_INSERTION_UNSUPPORTED"],
  ] as const) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toContain(reason);
  }
});

test("an SDK-shaped local streaming method lacks a retained callee coordinate, not WASM runtime provenance", () => {
  const path = "/fixture/main.ts";
  const source = "const wasm:typeof WebAssembly={instantiateStreaming(){return 1;}} as unknown as typeof WebAssembly;export function run(){return wasm.instantiateStreaming(null as any,{});}";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]));
  expect(reasons).toEqual(["SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED"]);
  expect(reasons).not.toContain("SOURCE_WASM_INSTANTIATION_UNSUPPORTED");
});

test("inert SDK data and actual local values preserve their domain", () => {
  for (const source of [
    "const button=document.createElement('button');button.onclick=null;export function run(){return 1;}",
    "const button=document.createElement('button');button.onclick=1 as any;export function run(){return 1;}",
    "function helper(){return 1;}const button:{onclick:null|(()=>number)}={onclick:null};button.onclick=helper;export function run(){return button.onclick!();}",
    "export function run(){const script=document.createElement('script');script.src='./hidden.js';return 1;}",
    "export function run(){const div=document.createElement('div');document.head.appendChild(div);}",
    "export function run(){document.head.prepend('plain data');}",
    "export function run(){const script=document.createElement('script');const div=document.createElement('div');document.head.replaceChild(div,script);}",
    "export function run(){return WebAssembly.compileStreaming(fetch('module.wasm'));}",
  ]) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toEqual([]);
  }
});

test("a typed local DOM lookalike does not acquire SDK script insertion origin", () => {
  const path = "/fixture/main.ts";
  const source = "const dom:Document={createElement(){return {src:''};},head:{appendChild(){return 1;}}} as unknown as Document;export function run(){const script=dom.createElement('script');dom.head.appendChild(script);}";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]));
  expect(reasons).toEqual(["SOURCE_OPAQUE_CALLBACK_UNSUPPORTED", "SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED"]);
  expect(reasons).not.toContain("SOURCE_SCRIPT_INSERTION_UNSUPPORTED");
});

test("insertion coordinates distinguish inserted arguments from reference nodes", () => {
  for (const insertion of [
    "document.head.append(div,script)", "document.head.prepend(div,script)", "document.head.replaceChildren(div,script)",
    "document.body.before(div,script)", "document.body.after(div,script)", "document.body.replaceWith(div,script)",
  ]) {
    const path = "/fixture/main.ts";
    const source = `export function run(){const script=document.createElement('script');const div=document.createElement('div');${insertion};}`;
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toContain("SOURCE_SCRIPT_INSERTION_UNSUPPORTED");
  }
  for (const insertion of ["document.head.insertBefore(div,script)", "document.head.replaceChild(div,script)"]) {
    const path = "/fixture/main.ts";
    const source = `export function run(){const script=document.createElement('script');const div=document.createElement('div');${insertion};}`;
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toEqual([]);
  }
});
