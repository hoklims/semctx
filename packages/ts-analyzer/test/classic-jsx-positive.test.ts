import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTypeScript, inspectJavaScriptSource, inspectModuleConfiguration } from "../src";

test("preserve, JSX-free and ordinary classic JSX controls retain their boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-classic-controls-"));
  try {
    const path = join(root, "render.tsx"); const factory = join(root, "factory.ts"); const config = join(root, "tsconfig.json");
    const content = "import {h, Fragment} from './factory'; export function render(){return <><div/></>;}";
    const options = { jsx: "react", jsxFactory: "h", jsxFragmentFactory: "Fragment", module: "ESNext", moduleResolution: "Bundler" };
    const inputs = new Map([[path, content], [factory, "export function h(){return 1;} export const Fragment=1;"], [config, JSON.stringify({ compilerOptions: options })]]);
    for (const [file, text] of inputs) writeFileSync(file, text);
    const preserve = new Map(inputs); preserve.set(config, JSON.stringify({ compilerOptions: { ...options, jsx: "preserve" } }));
    expect(inspectModuleConfiguration(path, root, preserve)).not.toContain("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED");
    const plain = new Map(inputs); plain.set(path, "export function render(){return 1;}");
    expect(inspectModuleConfiguration(path, root, plain)).not.toContain("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED");
    expect(inspectModuleConfiguration(path, root)).not.toContain("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED");
    const jsPath = join(root, "render.jsx"); writeFileSync(jsPath, content);
    const ordinaryJs = inspectJavaScriptSource(jsPath, content, root).reasons;
    expect(ordinaryJs).not.toContain("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED");
    expect(extractTypeScript([path, factory], root).symbols.some(symbol => symbol.name === "render")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
