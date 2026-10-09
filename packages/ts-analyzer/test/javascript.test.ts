import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig, type SemctxConfig } from "@semantic-context/core";
import { analyzeRepository, analyzeRepositoryAsync, discoverRepository, extractTypeScript } from "../src";

const roots: string[] = [];
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
