import { expect, test } from "bun:test";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";

for (const extension of ["ts", "js"]) test(`runtime launcher re-export is unsupported ${extension}`, () => {
  const path = `/fixture/launcher.${extension}`;
  const content = "export { fork } from 'node:child_process';";
  const snapshot = new Map([[path, content], [`/fixture/main.${extension}`, "import { fork } from './launcher'; export function run() { return fork('./child.js'); }"]]);
  const reasons = extension === "js" ? inspectJavaScriptSource(path, content, "/fixture", snapshot).reasons : inspectModuleConfiguration(path, "/fixture", snapshot);
  console.info(JSON.stringify({ extension, reasons }));
  expect(reasons).toContain(`${extension === "js" ? "JAVASCRIPT" : "SOURCE"}_PROCESS_LAUNCH_UNSUPPORTED`);
});

for (const extension of ["ts", "js"]) for (const module of ["cluster", "node:cluster"]) for (const [content, consumer] of [
  [`export { fork } from '${module}';`, "import { fork } from './launcher'; export function run() { return fork(); }"],
  [`export { setupPrimary as launch } from '${module}';`, "import { launch } from './launcher'; export function run() { return launch(); }"],
] as const) test(`runtime cluster re-export ${module} ${extension} ${content} retains process launch refusal`, () => {
  const path = `/fixture/launcher.${extension}`;
  const snapshot = new Map([[path, content], [`/fixture/main.${extension}`, consumer]]);
  const reasons = extension === "js" ? inspectJavaScriptSource(path, content, "/fixture", snapshot).reasons : inspectModuleConfiguration(path, "/fixture", snapshot);
  console.info(JSON.stringify({ extension, module, content, reasons }));
  expect(reasons).toContain(`${extension === "js" ? "JAVASCRIPT" : "SOURCE"}_PROCESS_LAUNCH_UNSUPPORTED`);
});

test("cluster type-only and ordinary data re-exports preserve their domain", () => {
  for (const module of ["cluster", "node:cluster"]) for (const content of [
    `export type { fork, setupPrimary } from '${module}';`,
    `export { type fork, type setupPrimary } from '${module}';`,
    `export { isPrimary } from '${module}';`,
    `export { isPrimary as primary } from '${module}';`,
  ]) {
    const path = "/fixture/launcher.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).not.toContain("SOURCE_PROCESS_LAUNCH_UNSUPPORTED");
  }
});

test("type-only, local and ordinary Node data re-exports are distinct", () => {
  for (const content of [
    "export type { fork } from 'node:child_process';",
    "export { type fork } from 'node:child_process';",
    "export { basename } from 'node:path';",
    "function fork() { return 1; } export { fork };",
  ]) {
    const path = "/fixture/launcher.ts";
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).not.toContain("SOURCE_PROCESS_LAUNCH_UNSUPPORTED");
  }
});

test("the same explicit builtin execution boundary covers VM re-exports", () => {
  const path = "/fixture/evaluation.ts";
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, "export { runInThisContext } from 'node:vm';"]]))).toContain("SOURCE_RUNTIME_EVALUATION_UNSUPPORTED");
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, "export type { runInThisContext } from 'node:vm';"]]))).not.toContain("SOURCE_RUNTIME_EVALUATION_UNSUPPORTED");
});
