import { expect, test } from "bun:test";
import { inspectModuleConfiguration } from "../src";

const cases = [
  [
    "Number.call",
    "const value={valueOf:hidden};",
    "Number.call(null,value)"
  ],
  [
    "String.call",
    "const value={toString:hidden};",
    "String.call(null,value)"
  ],
  [
    "Math.max.call",
    "const value={valueOf:hidden};",
    "Math.max.call(null,value,0)"
  ],
  [
    "Array.join.call",
    "const value={toString:hidden};",
    "Array.prototype.join.call([value])"
  ],
  [
    "Number.apply",
    "const value={valueOf:hidden};",
    "Number.apply(null,[value])"
  ],
  [
    "String.bind",
    "const value={toString:hidden};const bound=String.bind(null,value);",
    "bound()"
  ],
  [
    "Math.max.apply",
    "const value={valueOf:hidden};",
    "Math.max.apply(null,[value,0])"
  ],
  [
    "Array.join.bind",
    "const value={toString:hidden};const bound=Array.prototype.join.bind([value]);",
    "bound()"
  ]
] as const;
for (const extension of ["ts", "mjs"]) for (const [name, setup, call] of cases) test(`${name} ${extension} refuses helper-dispatched coercion`, () => {
  const path = `/fixture/main.${extension}`;
  const source = `function hidden(){return 1;}${setup}export function run(){return ${call};}`;
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]));
  console.info(JSON.stringify({ name, extension, reasons }));
  expect(reasons).toContain("SOURCE_COERCION_UNSUPPORTED");
});

for (const extension of ["ts", "mjs"]) test(`pristine SDK helper primitive controls ${extension} remain supported`, () => {
  const path = `/fixture/main.${extension}`;
  for (const call of [
    "Number.call(null,1)", "String.call(null,'value')", "Math.max.call(null,1,0)", "Array.prototype.join.call([1,2])",
    "Number.apply(null,[1])", "Math.max.apply(null,[1,0])",
  ]) expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, `export function run(){return ${call};}`]]))).toEqual([]);
});

for (const extension of ["ts", "mjs"]) test(`pristine bound SDK primitive controls ${extension} remain supported`, () => {
  const path = `/fixture/main.${extension}`;
  for (const source of [
    "const bound=String.bind(null,'value');export function run(){return bound();}",
    "const bound=Array.prototype.join.bind([1,2]);export function run(){return bound();}",
  ]) expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toEqual([]);
});

test("native SDK call, apply and bound invocation reach hidden conversion hooks", () => {
  for (const [name, setup, call] of cases) {
    const source = `function hidden(){console.log('COERCION_CALLED');return 1;}${setup}const result=${call};if(result===undefined)throw Error('missing result');`;
    const child = Bun.spawnSync([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
    console.info(JSON.stringify({ name, exitCode: child.exitCode }));
    expect(child.exitCode).toBe(0); expect(new TextDecoder().decode(child.stdout)).toContain("COERCION_CALLED");
  }
});

for (const extension of ["ts", "mjs"]) test(`SDK helper coercion only consumes actual conversion coordinates ${extension}`, () => {
  const path = `/fixture/main.${extension}`;
  for (const source of [
    "function hidden(){return 1;}const value={valueOf:hidden};export function run(){return Math.random.call(null,value);}",
    "function hidden(){return 1;}const value={valueOf:hidden};export function run(){return Math.abs.call(null,1,value);}",
    "function hidden(){return 1;}const value={valueOf:hidden};export function run(){return Number.call(null,1,value);}",
    "function hidden(){return 1;}const value={toString:hidden};const bound=String.bind(null,value);export function run(){return 1;}",
    "const own={call(_receiver,_value){return 1;}};function hidden(){return 1;}export function run(){return own.call(null,{valueOf:hidden});}",
  ]) expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toEqual([]);
});
