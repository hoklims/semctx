import { expect, test } from "bun:test";
import { inspectModuleConfiguration } from "../src";

for (const extension of ["ts", "mjs"]) test(`SDK Location href ${extension} cannot hide JavaScript module execution`, () => {
  const path = `/fixture/main.${extension}`;
  const source = "export function run(){location.href=\"javascript:import('./hidden.js')\";}";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]));
  console.info(JSON.stringify({ extension, reasons }));
  expect(reasons).toContain("SOURCE_SCRIPT_NAVIGATION_UNSUPPORTED");
});

test("SDK navigation follows URL scheme case and control normalization", () => {
  for (const url of ["JaVaScRiPt:import('./hidden.js')", " \u0000 javascript:import('./hidden.js')", "java\tscri\npt:import('./hidden.js')"]) {
    const path = "/fixture/main.ts";
    const source = `export function run(){location.href=${JSON.stringify(url)};}`;
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toContain("SOURCE_SCRIPT_NAVIGATION_UNSUPPORTED");
  }
});

test("actual SDK navigation aliases and unknown targets require an inert proof", () => {
  for (const source of [
    "const target=location;export function run(){target.href='javascript:1';}",
    "const target=window.location;export function run(){target['href']='javascript:1';}",
    "const url='javascript:1';export function run(){location.href=url;}",
    "export function run(url:string){location.href=url;}",
  ]) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toContain("SOURCE_SCRIPT_NAVIGATION_UNSUPPORTED");
  }
});

test("inert SDK href strings and real local location homonyms remain distinct", () => {
  for (const source of [
    "export function run(){location.href='https://example.invalid/path';}",
    "export function run(){location.href='#section';}",
    "export function run(){location.href='./next.html';}",
    "const target=window.location;export function run(){target.href='/next.html';}",
    "const location={href:''};export function run(){location.href='javascript:1';}",
    "const location={href:''};export function run(url:string){location.href=url;}",
    "const inert='javascript:1';export function run(){return inert;}",
  ]) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, source]]))).toEqual([]);
  }
});
