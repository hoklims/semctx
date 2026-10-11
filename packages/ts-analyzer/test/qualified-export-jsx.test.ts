import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTypeScript, inspectModuleConfiguration } from "../src";

test("retained TS-only export clauses mark the actual imported declaration exported, preserving legacy extraction", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-export-clause-"));
  try {
    const leaf = join(root, "leaf.ts"); const caller = join(root, "caller.ts");
    const inputs = new Map([[leaf, "function helper() { return 1; } export { helper }"], [caller, "import { helper } from './leaf'; export function main() { return helper(); }"]]);
    for (const [path, content] of inputs) writeFileSync(path, content);
    expect(extractTypeScript([leaf, caller], root).symbols.find(symbol => symbol.name === "helper")?.exported).toBe(false);
    const result = extractTypeScript([leaf, caller], root, inputs);
    expect(result.symbols.find(symbol => symbol.name === "helper")?.exported).toBe(true);
    expect(result.calls).toContainEqual(expect.objectContaining({ callerRelPath: "caller.ts", calleeRelPath: "leaf.ts", calleeSymbolPath: "helper" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [mode, content, expected] of [
  ["react-jsx", "export const view = <div/>;", true],
  ["react-jsxdev", "export const view = <><div/></>;", true],
  ["preserve", "/** @jsxRuntime automatic */\nexport const view = <div/>;", true],
  ["react-jsx", "export function plain() { return 1; }", false],
  ["preserve", "export const view = <div/>;", false],
  ["react-jsx", "/** @jsxRuntime classic */\nexport const view = <div/>;", false],
  ["preserve", "/** @jsxImportSource @fixture/runtime */\nexport const view = <div/>;", true],
  ["preserve", "/** @jsxRuntime classic */\n/** @jsxRuntime automatic */\nexport const view = <div/>;", true],
] as const) test(`qualified JSX runtime mode ${mode} refuses only unmodeled automatic JSX: ${content}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-jsx-mode-"));
  try {
    const path = join(root, "view.tsx"); const config = join(root, "tsconfig.json");
    const inputs = new Map([[path, content], [config, JSON.stringify({ compilerOptions: { jsx: mode } })]]);
    expect(inspectModuleConfiguration(path, root, inputs).includes("SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED")).toBe(expected);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retained TS-only named default declarations retain canonical callee and import coordinates", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-ts-default-"));
  try {
    const leaf = join(root, "leaf.ts"); const caller = join(root, "caller.ts");
    const inputs = new Map([[leaf, "export default function namedFn() { return 1; }"], [caller, "import value from './leaf'; export function main() { return value(); }"]]);
    const result = extractTypeScript([leaf, caller], root, inputs);
    expect(result.calls).toContainEqual(expect.objectContaining({ calleeRelPath: "leaf.ts", calleeSymbolPath: "namedFn" }));
    expect(result.imports[0]?.bindingTargets).toEqual([{ relPath: "leaf.ts", symbolPath: "namedFn" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
