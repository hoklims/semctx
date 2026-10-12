import { expect, test } from "bun:test";
import ts from "typescript";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";

const path = "/fixture/main.ts";
for (const content of [
  "export const settings = { get value() { return 1; } };",
  "export class Settings { get value() { return 1; } }",
  "export const settings = { set value(next: number) {} };",
  "export class Settings { set value(next: number) {} }",
]) test(`unmodeled accessor declarations are not complete: ${content}`, () => {
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).toContain("SOURCE_ACCESSOR_UNSUPPORTED");
  expect(inspectModuleConfiguration(path, "/fixture", undefined, ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true))).not.toContain("SOURCE_ACCESSOR_UNSUPPORTED");
});
test("JS producer refuses accessors while ordinary data and SDK properties remain unchanged", () => {
  expect(inspectJavaScriptSource("/fixture/main.js", "export const settings = { get value() { return 1; } };").reasons).toContain("JAVASCRIPT_ACCESSOR_UNSUPPORTED");
  const content = "export const settings = { value: 1 }; export class Plain { read() { return settings.value; } } export function consume() { return new Map().size; }";
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]))).not.toContain("SOURCE_ACCESSOR_UNSUPPORTED");
  expect(inspectJavaScriptSource("/fixture/main.js", content).reasons).not.toContain("JAVASCRIPT_ACCESSOR_UNSUPPORTED");
});
