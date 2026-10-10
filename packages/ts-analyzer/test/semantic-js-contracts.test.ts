import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { analyzeRepository, discoverRepository, extractTypeScript, inspectJavaScriptSource, inspectModuleConfiguration } from "../src";
import ts from "typescript";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function graph(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "semctx-js-contract-")); roots.push(root);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  const config = { ...createGlobSelectionConfig(root), include: ["**/*"], exclude: [], languages: { typescript: "on" as const, javascript: "on" as const } };
  return analyzeRepository(config, discoverRepository(config).files).graph;
}
test("semantic parenthesized call retains its actual owner edge", () => {
  const result = graph({ "lib.mjs": "export function helper() { return 1; } export function caller() { return (helper)(); }" });
  const helper = result.nodes.find(node => node.name === "helper")!;
  const caller = result.nodes.find(node => node.name === "caller")!;
  expect(result.edges).toContainEqual(expect.objectContaining({ kind: "calls", from: caller.id, to: helper.id }));
});
for (const extension of ["js", "ts"]) test(`namespace member calls create canonical test coverage in ${extension}`, () => {
  const result = graph({ "lib.mjs": "export function helper() { return 1; } export function unused() { return 2; }", [`lib.test.${extension}`]: "import * as lib from './lib.mjs'; lib.helper();" });
  const helper = result.nodes.find(node => node.name === "helper")!;
  const unused = result.nodes.find(node => node.name === "unused")!;
  const tester = result.nodes.find(node => node.kind === "test")!;
  expect(result.edges).toContainEqual(expect.objectContaining({ kind: "tested_by", from: helper.id, to: tester.id }));
  expect(result.edges).toContainEqual(expect.objectContaining({ kind: "covers", from: tester.id, to: helper.id }));
  expect(result.edges.some(edge => edge.kind === "tested_by" && edge.from === unused.id)).toBe(false);
});
test("namespace test coverage follows actual leaf aliases and excludes a shadowed namespace", () => {
  const result = graph({ "leaf.mjs": "export function helper() { return 1; }", "barrel.mjs": "export { helper as facade } from './leaf.mjs';", "leaf.test.js": "import * as lib from './barrel.mjs'; lib.facade();" });
  const helper = result.nodes.find(node => node.name === "helper")!; const tester = result.nodes.find(node => node.kind === "test")!;
  expect(result.edges).toContainEqual(expect.objectContaining({ kind: "tested_by", from: helper.id, to: tester.id }));
  const shadow = graph({ "lib.mjs": "export function helper() { return 1; }", "lib.test.js": "import * as lib from './lib.mjs'; function ordinary(lib) { lib.helper(); } ordinary({ helper() {} });" });
  expect(shadow.edges.some(edge => edge.kind === "tested_by")).toBe(false);
});
test("namespace default calls retain declaration coordinates while dynamic whole reads do not claim coverage", () => {
  const result = graph({ "lib.mjs": "export default function namedFn() { return 1; }", "lib.test.js": "import * as lib from './lib.mjs'; lib.default();" });
  const helper = result.nodes.find(node => node.name === "namedFn")!; const tester = result.nodes.find(node => node.kind === "test")!;
  expect(result.edges).toContainEqual(expect.objectContaining({ kind: "tested_by", from: helper.id, to: tester.id }));
  const dynamic = graph({ "lib.mjs": "export function helper() { return 1; }", "lib.test.js": "import * as lib from './lib.mjs'; Object.keys(lib);" });
  expect(dynamic.edges.some(edge => edge.kind === "tested_by")).toBe(false);
});
test("unmodeled object members cannot claim namespace test coverage of a global homonym", () => {
  const result = graph({ "lib.mjs": "export function helper() { return 1; } export const obj = { helper() { return 2; } };", "lib.test.js": "import * as lib from './lib.mjs'; lib.obj.helper();" });
  expect(result.edges.some(edge => edge.kind === "tested_by" || edge.kind === "covers")).toBe(false);
});
test("namespace construction associates the actual modeled class declaration", () => {
  const result = graph({ "lib.mjs": "export class Model {}", "lib.test.js": "import * as lib from './lib.mjs'; new lib.Model();" });
  const model = result.nodes.find(node => node.name === "Model")!; const tester = result.nodes.find(node => node.kind === "test")!;
  expect(result.edges).toContainEqual(expect.objectContaining({ kind: "tested_by", from: model.id, to: tester.id }));
});
test("retained TypeScript transparent calls use the owner while v1 no-snapshot stays unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-js-contract-")); roots.push(root);
  const path = join(root, "lib.ts");
  const content = "export function helper() { return 1; } export function caller() { return ((helper as () => number))(); }";
  writeFileSync(path, content);
  expect(extractTypeScript([path], root).calls).toEqual([]);
  expect(extractTypeScript([path], root, new Map([[path, content]])).calls).toContainEqual(expect.objectContaining({ callerSymbolPath: "caller", calleeSymbolPath: "helper" }));
});
test("parentheses cannot conceal an unmodeled conditional callee", () => {
  expect(inspectJavaScriptSource("/fixture/module.mjs", "export function caller(flag, a, b) { return (flag ? a : b)(); }").reasons).toContain("JAVASCRIPT_DYNAMIC_CALL_UNSUPPORTED");
});
for (const [source, name, imported] of [
  ["export function helper() { return 1; }", "helper", "{ helper as renamed }"],
  ["export default function namedFn() { return 1; }", "namedFn", "renamed"],
  ["export default function () { return 1; }", "default", "renamed"],
  ["export default class NamedClass {}", "NamedClass", "renamed"],
] as const) test(`semantic test import associates canonical ${name}`, () => {
  const result = graph({ "lib.mjs": source, "lib.test.js": `import ${imported} from './lib.mjs';` });
  const helper = result.nodes.find(node => node.filePath === "lib.mjs" && node.name === name)!;
  const tester = result.nodes.find(node => node.filePath === "lib.test.js" && node.kind === "test")!;
  expect(result.edges).toContainEqual(expect.objectContaining({ kind: "tested_by", from: helper.id, to: tester.id }));
  expect(result.edges).toContainEqual(expect.objectContaining({ kind: "covers", from: tester.id, to: helper.id }));
});
test("reexport test bindings retain leaf coverage and the actual barrel import", () => {
  const result = graph({ "leaf.mjs": "export function helper() { return 1; }", "barrel.js": "export { helper as facade } from './leaf.mjs';", "leaf.test.js": "import { facade as renamed } from './barrel.js';" });
  const helper = result.nodes.find(node => node.name === "helper")!;
  const tester = result.nodes.find(node => node.kind === "test")!;
  const barrel = result.nodes.find(node => node.filePath === "barrel.js" && node.kind === "module")!;
  expect(result.edges).toContainEqual(expect.objectContaining({ kind: "tested_by", from: helper.id, to: tester.id }));
  expect(result.edges).toContainEqual(expect.objectContaining({ kind: "imports", from: tester.id, to: barrel.id }));
});
for (const doc of ["/** @type {import('./types.mjs').Foo} */", "/** @typedef {import('./types.mjs').Foo} Foo */", "/** @import { Foo } from './types.mjs' */"]) test(`semantic JSDoc imports stay unsupported: ${doc}`, () => {
  expect(inspectJavaScriptSource("/fixture/module.mjs", `${doc}\nexport const value = 1;`).reasons).toContain("JAVASCRIPT_JSDOC_IMPORT_UNSUPPORTED");
});
test("ordinary JSDoc prose does not fabricate a JavaScript import dependency", () => {
  expect(inspectJavaScriptSource("/fixture/module.mjs", "/** Documentation discusses import('./types.mjs'). */ export const value = 1;").reasons).not.toContain("JAVASCRIPT_JSDOC_IMPORT_UNSUPPORTED");
});
test("nonsemantic TypeScript JSDoc types remain documentation", () => {
  const path = "/fixture/module.ts";
  const content = "/** @type {import('./types.mjs').Foo} */ export const value = 1;";
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]), ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true))).not.toContain("SOURCE_JSDOC_IMPORT_UNSUPPORTED");
});
