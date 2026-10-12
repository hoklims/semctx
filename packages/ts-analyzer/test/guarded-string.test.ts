import { expect, test } from "bun:test";
import { inspectModuleConfiguration } from "../src";

for (const extension of ["ts", "mjs"]) test(`guarded opaque string ${extension} calls its actual SDK member`, () => {
  const path = `/fixture/main.${extension}`;
  const source = "import {read} from 'opaque';const source=read();if(typeof source!=='string')throw new TypeError();source.includes('needle');";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, source], ["/fixture/package.json", '{"dependencies":{"opaque":"1.0.0"}}']]));
  console.info(JSON.stringify({ name: "guarded string positive", extension, reasons }));
  expect(reasons).toEqual([]);
});

for (const extension of ["ts", "mjs"]) test(`string callee ${extension} requires matching runtime kind and binding dominance`, () => {
  const typed = extension === "ts" ? "const source=read() as string;" : "/** @type {string} */const source=read();";
  const global = extension === "ts" ? "const source=read() as unknown as typeof globalThis;" : "/** @type {typeof globalThis} */const source=read();";
  const castGuard = extension === "ts" ? "(source as unknown)" : "/** @type {unknown} */(source)";
  const cases = [
    ["annotation without guard", `${typed}source.includes('needle');`],
    ["late guard", `${typed}source.includes('needle');if(typeof source!=='string')throw new TypeError();`],
    ["shadowed guard", `${typed}{const source='text';if(typeof source!=='string')throw new TypeError();}source.includes('needle');`],
    ["different binding", `${typed}const other=read();if(typeof other!=='string')throw new TypeError();source.includes('needle');`],
    ["outer closure guard", `${typed}if(typeof source!=='string')throw new TypeError();export function run(){return source.includes('needle');}`],
    ["loop assignment", `${typed}if(typeof source!=='string')throw new TypeError();for(source of ['text']){}source.includes('needle');`],
    ["global SDK shape", `${global}if(typeof source!=='string')throw new TypeError();source.parseInt('1');`],
    ["wrong runtime kind behind cast", `${typed}if(typeof ${castGuard}!=='number')throw new TypeError();source.includes('needle');`],
  ];
  for (const [name, body] of cases) {
    const path = `/fixture/main.${extension}`;
    const source = `import {read} from 'opaque';${body}`;
    const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, source], ["/fixture/package.json", '{"dependencies":{"opaque":"1.0.0"}}']]));
    console.info(JSON.stringify({ name, extension, reasons }));
    expect(reasons).toEqual(["SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED"]);
  }
});

test("guarded primitive member does not erase callback refusal", () => {
  for (const extension of ["ts", "mjs"]) {
    const path = `/fixture/main.${extension}`;
    const source = "import {read} from 'opaque';function hidden(){return 'text';}const source=read();if(typeof source!=='string')throw new TypeError();source.replace('needle',hidden);";
    const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, source], ["/fixture/package.json", '{"dependencies":{"opaque":"1.0.0"}}']]));
    console.info(JSON.stringify({ name: "guarded string callback", extension, reasons }));
    expect(reasons).toContain("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED");
  }
});

test("guarded primitive member does not erase captured prototype mutation refusal", () => {
  for (const extension of ["ts", "mjs"]) {
    const path = `/fixture/main.${extension}`;
    const source = "import {read} from 'opaque';function hidden(){return true;}String.prototype.includes=hidden;const source=read();if(typeof source!=='string')throw new TypeError();source.includes('needle');";
    const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, source], ["/fixture/package.json", '{"dependencies":{"opaque":"1.0.0"}}']]));
    console.info(JSON.stringify({ name: "guarded string prototype override", extension, reasons }));
    expect(reasons).toContain("SOURCE_SDK_CALLABLE_MUTATION_UNSUPPORTED");
  }
});
