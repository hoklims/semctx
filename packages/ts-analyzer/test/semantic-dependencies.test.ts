import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src";
import { extractionContext } from "../src/ts-symbols";

for (const invocation of ["helper.call(null)", "helper.apply(null, [])", "helper.bind(null)", "(helper as any).call(null)", "alias.call(null)"]) test(`SDK invocation helper on retained function refuses ${invocation}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-helper-origin-"));
  try {
    const path = join(root, "main.ts"); const content = `export function helper() { return 1; } const alias = helper; export function caller() { return ${invocation}; }`;
    expect(inspectModuleConfiguration(path, root, new Map([[path, content]]))).toContain("SOURCE_FUNCTION_HELPER_UNSUPPORTED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("real JS producer refuses a bind/alias helper without treating ordinary own methods as prototypes", () => {
  expect(inspectJavaScriptSource("/fixture/main.js", "export function helper() { return 1; } const invoke = helper.call; export function caller() { return invoke(null); }").reasons).toContain("JAVASCRIPT_FUNCTION_HELPER_UNSUPPORTED");
  const own = inspectJavaScriptSource("/fixture/main.js", "export class Own { call() { return 1; } apply() { return 2; } } export function caller() { const own = new Own(); return own.call() + own.apply(); }");
  expect(own.reasons.some(reason => reason.includes("FUNCTION_HELPER_UNSUPPORTED"))).toBe(false);
  expect(own.reasons).toContain("JAVASCRIPT_CONSTRUCTION_UNSUPPORTED");
});
test("intrinsic JSX, plain classes and SDK base aliases preserve their existing semantic domain", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-semantic-positive-"));
  try {
    const path = join(root, "main.tsx"); const content = "const Alias = Error; export class ExternalBoundary extends Alias {} export class Plain {} export const View = () => <><div/><my-widget/></>;";
    const reasons = inspectModuleConfiguration(path, root, new Map([[path, content]]));
    expect(reasons).not.toContain("SOURCE_INTERNAL_HERITAGE_UNSUPPORTED"); expect(reasons).not.toContain("SOURCE_JSX_COMPONENT_UNSUPPORTED");
    expect(inspectModuleConfiguration(path, root, undefined, ts.createSourceFile(path, "export class Base {} export class Derived extends Base {}", ts.ScriptTarget.Latest, true))).not.toContain("SOURCE_INTERNAL_HERITAGE_UNSUPPORTED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("semantic Program is shared within the exact retained snapshot and rebuilt for a new boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-context-cache-"));
  const first = join(root, "first.ts"); const second = join(root, "second.ts");
  const inputs = new Map([[first, "export class Base {} export class Own { call() {} } export function own() { return new Own().call(); }"], [second, "import { Base } from './first'; export class Derived extends Base {}"]]);
  const creation = spyOn(extractionContext, "createProgram");
  try {
    expect(inspectModuleConfiguration(first, root, inputs)).toContain("SOURCE_CONSTRUCTION_UNSUPPORTED");
    expect(inspectModuleConfiguration(second, root, inputs)).toContain("SOURCE_INTERNAL_HERITAGE_UNSUPPORTED");
    expect(creation).toHaveBeenCalledTimes(1);
    inspectModuleConfiguration(first, root, new Map(inputs)); expect(creation).toHaveBeenCalledTimes(2);
  } finally { creation.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
