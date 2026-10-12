import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { extractTypeScript, inspectJavaScriptSource, inspectModuleConfiguration } from "../src";

test("JavaScript producer rejects tagged invocation independently of qualified mode", () => {
  const result = inspectJavaScriptSource("/fixture/main.mjs", "export function tag(parts) { return parts[0]; } export function main() { return tag`value`; }");
  expect(result.reasons).toContain("JAVASCRIPT_TAGGED_TEMPLATE_UNSUPPORTED");
});
for (const extension of ["ts", "mjs"]) test(`retained ${extension} distinguishes plain templates from tagged invocations`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-tagged-template-"));
  try {
    const path = join(root, `main.${extension}`);
    const content = "export function helper() { return 1; } export function main() { return `value ${helper()}`; }";
    const inputs = new Map([[path, content]]);
    expect(inspectModuleConfiguration(path, root, inputs)).not.toContain("SOURCE_TAGGED_TEMPLATE_UNSUPPORTED");
    expect(extractTypeScript([path], root, inputs).calls).toContainEqual(expect.objectContaining({ callerSymbolPath: "main", calleeSymbolPath: "helper" }));
    const tagged = "export function tag(parts) { return parts[0]; } export function main() { return tag`value`; }";
    expect(inspectModuleConfiguration(path, root, new Map([[path, tagged]]))).toContain("SOURCE_TAGGED_TEMPLATE_UNSUPPORTED");
    expect(extractTypeScript([path], root, new Map([[path, tagged]])).calls).toEqual([]);
    if (extension === "ts") expect(inspectModuleConfiguration(path, root, undefined, ts.createSourceFile(path, tagged, ts.ScriptTarget.Latest, true))).not.toContain("SOURCE_TAGGED_TEMPLATE_UNSUPPORTED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
