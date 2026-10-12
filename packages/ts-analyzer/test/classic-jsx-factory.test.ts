import { expect, test } from "bun:test";
import ts from "typescript";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTypeScript, inspectJavaScriptSource, inspectModuleConfiguration } from "../src";

test("actual retained classic JSX factory emits a call missing from extraction", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-classic-factory-"));
  try {
    const path = join(root, "render.tsx"); const factory = join(root, "factory.ts"); const config = join(root, "tsconfig.json");
    const content = "import {h} from './factory'; export function render(){return <div/>;}";
    const inputs = new Map([[path, content], [factory, "export function h(){return 1;}"], [config, '{"compilerOptions":{"jsx":"react","jsxFactory":"h","module":"ESNext","moduleResolution":"Bundler"}}']]);
    for (const [file, text] of inputs) writeFileSync(file, text);
    const facts = extractTypeScript([path, factory], root, inputs);
    const emittedCalls: { originalKind: string; pos: number; end: number; synthesized: boolean }[] = [];
    const output = ts.transpileModule(content, { fileName: path, compilerOptions: { jsx: ts.JsxEmit.React, jsxFactory: "h", module: ts.ModuleKind.ESNext }, transformers: { after: [() => node => {
      const visit = (value: ts.Node): void => { if (ts.isCallExpression(value)) emittedCalls.push({ originalKind: ts.SyntaxKind[ts.getOriginalNode(value).kind], pos: value.pos, end: value.end, synthesized: (value.flags & ts.NodeFlags.Synthesized) !== 0 }); ts.forEachChild(value, visit); };
      visit(node); return node;
    }] } });
    const reasons = inspectModuleConfiguration(path, root, inputs);
    console.info(JSON.stringify({ output: output.outputText, emittedCalls, calls: facts.calls, reasons }));
    expect(output.outputText).toContain('h("div", null)');
    expect(facts.calls.some(call => call.callerSymbolPath === "render" && call.calleeSymbolPath === "h")).toBe(false);
    expect(reasons).toContain("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("classic fragment emission is refused while preserve, JSX-free and ordinary paths retain their boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-classic-controls-"));
  try {
    const path = join(root, "render.tsx"); const factory = join(root, "factory.ts"); const config = join(root, "tsconfig.json");
    const content = "import {h, Fragment} from './factory'; export function render(){return <><div/></>;}";
    const options = { jsx: "react", jsxFactory: "h", jsxFragmentFactory: "Fragment", module: "ESNext", moduleResolution: "Bundler" };
    const inputs = new Map([[path, content], [factory, "export function h(){return 1;} export const Fragment=1;"], [config, JSON.stringify({ compilerOptions: options })]]);
    for (const [file, text] of inputs) writeFileSync(file, text);
    expect(inspectModuleConfiguration(path, root, inputs)).toContain("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED");
    const preserve = new Map(inputs); preserve.set(config, JSON.stringify({ compilerOptions: { ...options, jsx: "preserve" } }));
    expect(inspectModuleConfiguration(path, root, preserve)).not.toContain("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED");
    const plain = new Map(inputs); plain.set(path, "export function render(){return 1;}");
    expect(inspectModuleConfiguration(path, root, plain)).not.toContain("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED");
    expect(inspectModuleConfiguration(path, root)).not.toContain("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED");
    const jsPath = join(root, "render.jsx"); writeFileSync(jsPath, content);
    const ordinaryJs = inspectJavaScriptSource(jsPath, content, root).reasons;
    expect(ordinaryJs).not.toContain("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED");
    const retainedJs = new Map(inputs); retainedJs.set(jsPath, content);
    const retainedJsReasons = inspectJavaScriptSource(jsPath, content, root, retainedJs).reasons;
    console.info(JSON.stringify({ ordinaryJs, retainedJsReasons }));
    expect(retainedJsReasons).toContain("SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED");
    expect(extractTypeScript([path, factory], root).symbols.some(symbol => symbol.name === "render")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
