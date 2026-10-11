import { expect, test } from "bun:test";
import ts from "typescript";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src/javascript-diagnostics";

for (const expression of ["() => 1", "(function () { return 1; })", "((() => 1))", "(function named() { return 1; })", "true ? (() => 1) : (() => 2)", "(class {})", "({ run() {} })", "1", "build()"]) {
  test(`JavaScript unmodeled function default expression stays partial: ${expression}`, () => {
    expect(inspectJavaScriptSource("/fixture/module.mjs", `export default ${expression};`).reasons).toContain("JAVASCRIPT_DEFAULT_EXPRESSION_UNSUPPORTED");
  });
}
for (const content of ["const impl = () => 1; const alias = impl; export default alias;", "const run = () => 1; export default run;"]) test("default identifier assignments remain explicitly outside the closed profile", () => {
  expect(inspectJavaScriptSource("/fixture/module.mjs", content).reasons).toContain("JAVASCRIPT_DEFAULT_EXPRESSION_UNSUPPORTED");
});
for (const expression of ["(() => 1) as () => number", "(() => 1) satisfies () => number", "(() => 1)!"]) {
  test(`TypeScript transparent wrappers cannot admit an unmodeled function default: ${expression}`, () => {
    const path = "/fixture/module.ts";
    const content = `export default ${expression};`;
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
    expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]), source)).toContain("SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED");
  });
}
for (const expression of ["(impl)", "impl as () => number", "impl satisfies () => number", "impl!"]) test(`wrapped bound identifier remains an unsupported assignment: ${expression}`, () => {
  const path = "/fixture/module.ts";
  const content = `const impl = () => 1; export default ${expression};`;
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, content]]), ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true))).toContain("SOURCE_DEFAULT_EXPRESSION_UNSUPPORTED");
});
for (const content of ["export default function () { return 1; }", "export default class {}"]) {
  test(`modeled declaration or ordinary default value remains eligible: ${content}`, () => {
    expect(inspectJavaScriptSource("/fixture/module.mjs", content).reasons).not.toContain("JAVASCRIPT_DEFAULT_EXPRESSION_UNSUPPORTED");
  });
}
