import { expect, test } from "bun:test";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";

for (const extension of ["ts", "js"]) test(`builtin fork is an unmodeled code launcher ${extension}`, () => {
  const content = "import { fork } from 'node:child_process'; export function run() { return fork('./hidden.js'); }";
  const path = `/fixture/main.${extension}`; const snapshot = new Map([[path, content]]);
  const reasons = extension === "js" ? inspectJavaScriptSource(path, content, "/fixture", snapshot).reasons : inspectModuleConfiguration(path, "/fixture", snapshot);
  console.info(JSON.stringify({ extension, reasons }));
  expect(reasons).toContain(`${extension === "js" ? "JAVASCRIPT" : "SOURCE"}_PROCESS_LAUNCH_UNSUPPORTED`);
});
test("ordinary local fork and unrelated primitive Node helpers are distinct", () => {
  for (const content of [
    "function fork(path) { return path; } export function run() { return fork('value'); }",
    "import { basename } from 'node:path'; export function run() { return basename('src/value.ts'); }",
    "import { fork } from 'node:child_process'; export function run(fork) { return fork('value'); }",
    "import { fork } from 'node:child_process'; export function run() { return 1; }",
    "import type { fork } from 'node:child_process'; export type Launch = typeof fork; export function run() { return 1; }",
  ]) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).not.toContain("SOURCE_PROCESS_LAUNCH_UNSUPPORTED");
  }
});
test("builtin namespace aliases and helper dispatch preserve the launcher boundary", () => {
  for (const content of [
    "import * as cp from 'node:child_process'; const processes = cp; export function run() { return processes.fork('./hidden.js'); }",
    "import { fork as launch } from 'child_process'; const start = launch; export function run() { return start.call(null, './hidden.js'); }",
    "import * as cp from 'node:child_process'; const { fork: start } = cp; export function run() { return start('./hidden.js'); }",
  ]) {
    const path = "/fixture/main.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).toContain("SOURCE_PROCESS_LAUNCH_UNSUPPORTED");
  }
});
test("return-only builtin launcher escape cannot skip semantic inspection", () => {
  const path = "/fixture/main.ts";
  const content = "import { fork } from 'node:child_process'; export function run() { return fork; }";
  const reasons = inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));
  console.info(JSON.stringify({ returnOnlyEscape: reasons }));
  expect(reasons).toContain("SOURCE_PROCESS_LAUNCH_UNSUPPORTED");
});
