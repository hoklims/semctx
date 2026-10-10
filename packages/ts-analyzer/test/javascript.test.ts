import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig, type SemctxConfig } from "@semantic-context/core";
import { analyzeRepository, analyzeRepositoryAsync, discoverRepository, extractTypeScript } from "../src";

const roots: string[] = [];
for (const extension of ["mjs", "ts"]) it(`direct bound default identifier retains its actual ${extension} call coordinate`, () => {
  const { root } = fixture();
  const leaf = `alias.${extension}`;
  writeFileSync(join(root, leaf), "const implementation = value => value + 1; export default implementation;");
  writeFileSync(join(root, "caller.mjs"), `import run from './${leaf}'; export function caller() { return run(1); }`);
  const extraction = extractTypeScript([join(root, leaf), join(root, "caller.mjs")], root);
  expect(extraction.symbols.find(symbol => symbol.relPath === leaf && symbol.name === "implementation")).toMatchObject({ exported: true });
  expect(extraction.calls.find(call => call.callerSymbolPath === "caller")).toMatchObject({ calleeRelPath: leaf, calleeSymbolPath: "implementation" });
});
for (const kind of ["function", "class"] as const) it(`represents anonymous default ${kind} declarations and their call coordinates`, () => {
  const { root } = fixture();
  writeFileSync(join(root, "default.mjs"), kind === "function"
    ? "export default function () { function nested() { return 1; } return nested(); }"
    : "export default class { method() { function nested() { return 1; } return nested(); } }");
  writeFileSync(join(root, "caller.mjs"), kind === "function"
    ? "import value from './default.mjs'; export function caller() { return value(); }"
    : "import Value from './default.mjs'; export function caller() { return new Value().method(); }");
  const extraction = extractTypeScript([join(root, "default.mjs"), join(root, "caller.mjs")], root);
  expect(extraction.symbols.find(symbol => symbol.relPath === "default.mjs" && symbol.name === "default")).toMatchObject({ kind, exported: true });
  expect(extraction.symbols.find(symbol => symbol.name === "nested")?.scope).toEqual(kind === "function" ? ["default"] : ["default", "method"]);
  if (kind === "function") expect(extraction.calls.find(call => call.callerSymbolPath === "caller")).toMatchObject({ calleeRelPath: "default.mjs", calleeSymbolPath: "default" });
});
it("uses configured NodeNext require conditions for CommonJS module resolution", () => {
  const { root } = fixture();
  mkdirSync(join(root, "node_modules/conditional"), { recursive: true });
  writeFileSync(join(root, "node_modules/conditional/package.json"), JSON.stringify({ name: "conditional", exports: { import: "./esm.js", require: "./cjs.js" } }));
  writeFileSync(join(root, "node_modules/conditional/esm.js"), "export function value() { return 1; }");
  writeFileSync(join(root, "node_modules/conditional/cjs.js"), "export function value() { return 2; }");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }));
  writeFileSync(join(root, "consumer.cjs"), "import { value } from 'conditional'; export function consumer() { return value(); } export function load() { return import('conditional'); }");
  const extraction = extractTypeScript([join(root, "consumer.cjs")], root);
  expect(extraction.imports[0]?.resolvedRelPath).toBe("node_modules/conditional/cjs.js");
  expect(extraction.imports[1]?.resolvedRelPath).toBe("node_modules/conditional/esm.js");
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "semctx-js-")); roots.push(root);
  const sources = {
    "leaf.mjs": "export function leaf() { return 1; }",
    "bridge.js": "export { leaf } from './leaf.mjs';",
    "main.ts": "import { leaf } from './bridge.js'; export function main() { return leaf(); }",
    "view.jsx": "export function View() { return <div/>; }",
    "legacy.cjs": "module.exports = require('./leaf.mjs');",
  };
  for (const [path, content] of Object.entries(sources)) writeFileSync(join(root, path), content);
  const config: SemctxConfig = { ...createDefaultConfig(root), version: 2, selectionMode: "globs-v1", include: ["**/*"], exclude: [], languages: { typescript: "on", javascript: "on" } };
  return { root, config };
}
it("extracts opt-in JS symbols and TS to JS reexport dependency paths", () => {
  const { root, config } = fixture();
  const discovery = discoverRepository(config);
  expect(discovery.files.map(f => f.relPath)).toEqual(["bridge.js", "leaf.mjs", "legacy.cjs", "main.ts", "view.jsx"]);
  const extraction = extractTypeScript(discovery.files.map(f => f.absPath), root);
  expect(extraction.symbols.find(s => s.name === "leaf")).toMatchObject({ relPath: "leaf.mjs", exported: true });
  expect(extraction.symbols.find(s => s.name === "View")).toMatchObject({ relPath: "view.jsx", exported: true });
  expect(extraction.calls.find(c => c.callerSymbolPath === "main")).toMatchObject({ calleeRelPath: "leaf.mjs", calleeSymbolPath: "leaf" });
  const graph = analyzeRepository(config, discovery.files).graph;
  const dependencies = graph.edges.filter(e => e.kind === "imports");
  expect(dependencies).toHaveLength(2);
  expect(dependencies.some(e => e.from.includes("bridge.js") && e.to.includes("leaf.mjs"))).toBe(true);
});
it("keeps JS outside legacy v1 selected files", () => {
  const { root } = fixture();
  expect(discoverRepository({ ...createDefaultConfig(root), exclude: [] }).files.map(f => f.relPath)).toEqual(["main.ts"]);
});
it("keeps mixed extraction in one semantic Program when workers are requested", async () => {
  const { config } = fixture();
  const discovery = discoverRepository(config);
  const synchronous = analyzeRepository(config, discovery.files);
  const asynchronous = await analyzeRepositoryAsync(config, discovery.files, 2);
  expect(asynchronous.analysis).toEqual(synchronous);
  expect(asynchronous.parallelism).toMatchObject({ requested: 2, used: 1, mode: "preflight-fallback" });
});
