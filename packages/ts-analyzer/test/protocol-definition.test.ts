import { expect, test } from "bun:test";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";

for (const [name, definition] of [
  ["object", "const matcher = { [Symbol.match]: helper };"],
  ["class", "class Matcher { static [Symbol.match] = helper; } const matcher = Matcher;"],
] as const) for (const extension of ["ts", "js"]) test(`callable protocol ${name} definition ${extension}`, () => {
  const content = `function helper() { return 1; } ${definition} export function run() { return 'x'.match(matcher${extension === "ts" ? " as any" : ""}); }`;
  const path = `/fixture/main.${extension}`; const inputs = new Map([[path, content]]);
  const reasons = extension === "js" ? inspectJavaScriptSource(path, content, "/fixture", inputs).reasons : inspectModuleConfiguration(path, "/fixture", inputs);
  console.info(JSON.stringify({ name, extension, reasons }));
  expect(reasons).toContain(`${extension === "js" ? "JAVASCRIPT" : "SOURCE"}_PROTOCOL_DEFINITION_UNSUPPORTED`);
});

test("native literal protocol definition invokes the owned helper", () => {
  const result = Bun.spawnSync([process.execPath, "-e", "function helper(){console.log('PROTOCOL_DEFINED_CALLED');return 7}const matcher={[Symbol.match]:helper};if('x'.match(matcher)!==7)throw Error('hook result');"], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0); expect(new TextDecoder().decode(result.stdout)).toContain("PROTOCOL_DEFINED_CALLED");
});

test("erased protocol members and actual ordinary data keys remain distinct", () => {
  for (const content of [
    "export interface Matcher { [Symbol.match](value: string): number; }",
    "declare class Matcher { static [Symbol.match](value: string): number; } export {};",
    "const matcher = { [Symbol.match]: 1 }; export function run() { return 1; }",
    "function helper(){return 1;} const matcher={match:helper}; export function run(){return matcher.match();}",
    "const Symbol={match:'match'}; function helper(){return 1;} const matcher={[Symbol.match]:helper}; export function run(){return matcher.match();}",
  ]) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).not.toContain("SOURCE_PROTOCOL_DEFINITION_UNSUPPORTED");
  }
});
