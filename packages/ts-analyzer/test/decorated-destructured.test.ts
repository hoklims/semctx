import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import ts from "typescript";
import { analyzeRepository, discoverRepository, inspectJavaScriptSource, inspectModuleConfiguration } from "../src";
import { extractTypeScript } from "../src/ts-symbols";

const path = "/fixture/main.ts";
const inspect = (content: string) => inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]));

for (const decorator of ["@logged", "@decorators.logged", "@(logged)", "@factory()"])
  test(`runtime decorator invocation is unsupported: ${decorator}`, () => {
    expect(inspect(`function logged(value: unknown) { return value; } const decorators = { logged }; function factory() { return logged; } ${decorator} export class View {}`)).toContain("SOURCE_DECORATOR_UNSUPPORTED");
  });

for (const content of [
  "const [helper] = [() => 1]; export { helper };",
  "const { helper } = { helper: () => 1 }; export { helper as publicHelper };",
  "export const [helper] = [() => 1];",
  "const [helper] = [() => 1]; const alias = helper; export { alias };",
]) test(`destructured callable export has no modeled symbol: ${content}`, () => {
  const snapshot = new Map([[path, content]]);
  const extraction = extractTypeScript([path], "/fixture", snapshot);
  expect(extraction.symbols.some(symbol => symbol.name === "helper" || symbol.name === "alias")).toBe(false);
  expect(inspect(content)).toContain("SOURCE_DESTRUCTURED_CALLABLE_EXPORT_UNSUPPORTED");
});

for (const content of [
  "declare const source: { helper: any }; const { helper } = source; export { helper };",
  "declare const source: { helper: unknown }; const { helper } = source; export { helper };",
  "declare const source: { helper: (() => number) | number }; const { helper } = source; export { helper };",
  "const { Constructor } = { Constructor: class {} }; export { Constructor };",
]) test(`uncertain or constructible destructured exports stay unsupported: ${content}`, () => {
  expect(inspect(content)).toContain("SOURCE_DESTRUCTURED_CALLABLE_EXPORT_UNSUPPORTED");
});

test("JS producer refuses destructured local callable exports and decorators", () => {
  expect(inspectJavaScriptSource("/fixture/main.js", "const [helper] = [() => 1]; export { helper };").reasons).toContain("JAVASCRIPT_DESTRUCTURED_CALLABLE_EXPORT_UNSUPPORTED");
  expect(inspectJavaScriptSource("/fixture/main.js", "function logged(value) { return value; } @logged export class View {}").reasons).toContain("JAVASCRIPT_DECORATOR_UNSUPPORTED");
});

test("import-only tests cannot acquire invented coverage for destructured callable coordinates", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-destructured-coverage-"));
  try {
    writeFileSync(join(root, "lib.mjs"), "const [helper] = [() => 1]; export { helper };");
    writeFileSync(join(root, "lib.test.js"), "import { helper } from './lib.mjs';");
    const config = { ...createGlobSelectionConfig(root), include: ["**/*"], exclude: [], languages: { typescript: "on" as const, javascript: "on" as const } };
    const result = analyzeRepository(config, discoverRepository(config).files).graph;
    expect(result.nodes.some(node => node.name === "helper")).toBe(false);
    expect(result.edges.some(edge => edge.kind === "tested_by" || edge.kind === "covers")).toBe(false);
    expect(inspectJavaScriptSource(join(root, "lib.mjs"), "const [helper] = [() => 1]; export { helper };").reasons).toContain("JAVASCRIPT_DESTRUCTURED_CALLABLE_EXPORT_UNSUPPORTED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("modeled identifier exports, noncallable destructuring and ordinary TS legacy remain unchanged", () => {
  expect(inspect("const helper = () => 1; export { helper as publicHelper };")).not.toContain("SOURCE_DESTRUCTURED_CALLABLE_EXPORT_UNSUPPORTED");
  expect(inspect("const [value] = [1]; export { value };")).not.toContain("SOURCE_DESTRUCTURED_CALLABLE_EXPORT_UNSUPPORTED");
  expect(inspect("const [helper] = [() => 1]; export function own() { const helper = () => 2; return helper(); }")).not.toContain("SOURCE_DESTRUCTURED_CALLABLE_EXPORT_UNSUPPORTED");
  const content = "function logged(value: unknown) { return value; } @logged export class View {} const [helper] = [() => 1]; export { helper };";
  expect(inspectModuleConfiguration(path, "/fixture", undefined, ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true))).not.toContain("SOURCE_DECORATOR_UNSUPPORTED");
  expect(inspectModuleConfiguration(path, "/fixture", undefined, ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true))).not.toContain("SOURCE_DESTRUCTURED_CALLABLE_EXPORT_UNSUPPORTED");
});
