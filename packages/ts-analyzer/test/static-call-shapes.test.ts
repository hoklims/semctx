import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { extractTypeScript, inspectModuleConfiguration } from "../src";

test("retained unmodeled TS call has no extracted callee and a refusal; ordinary no-snapshot diagnostics stay unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-static-call-"));
  try {
    const path = join(root, "main.ts"); const content = "export function helper() { return 1; } export function fallback() { return 2; } export function main(flag: boolean) { return (flag ? helper : fallback)(); }";
    writeFileSync(path, content); const inputs = new Map([[path, content]]);
    expect(extractTypeScript([path], root, inputs).calls).toEqual([]);
    expect(inspectModuleConfiguration(path, root, inputs)).toContain("SOURCE_DYNAMIC_CALL_UNSUPPORTED");
    expect(inspectModuleConfiguration(path, root, undefined, ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true))).not.toContain("SOURCE_DYNAMIC_CALL_UNSUPPORTED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
for (const expression of ["(helper)", "(helper as () => number)", "(<() => number>helper)", "helper!", "(helper satisfies () => number)"]) test(`retained transparent identifier call ${expression} has its actual coordinate`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-static-call-"));
  try {
    const path = join(root, "main.ts"); const content = `export function helper() { return 1; } export function main() { return ${expression}(); }`;
    const inputs = new Map([[path, content]]);
    expect(inspectModuleConfiguration(path, root, inputs)).not.toContain("SOURCE_DYNAMIC_CALL_UNSUPPORTED");
    expect(extractTypeScript([path], root, inputs).calls).toContainEqual(expect.objectContaining({ callerSymbolPath: "main", calleeSymbolPath: "helper" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("retained transparent namespace property call and existing class construction retain their domain", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-static-call-"));
  try {
    const path = join(root, "main.ts"); const leaf = join(root, "leaf.ts");
    const content = "import * as leaf from './leaf'; export class Model {} export function main() { const model = new Model(); return ((leaf.helper) as () => number)(); }";
    const inputs = new Map([[path, content], [leaf, "export function helper() { return 1; }"]]);
    expect(inspectModuleConfiguration(path, root, inputs)).not.toContain("SOURCE_DYNAMIC_CALL_UNSUPPORTED");
    const result = extractTypeScript([path, leaf], root, inputs);
    expect(result.calls).toContainEqual(expect.objectContaining({ callerSymbolPath: "main", calleeRelPath: "leaf.ts", calleeSymbolPath: "helper" }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: "Model", kind: "class" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
