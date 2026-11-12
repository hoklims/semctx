import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { analyzeRepository, inspectModuleConfiguration, registerOpaqueCallbackOwnership } from "../src";

for (const [body, allowed] of [["register(() => helper())", true], ["register(() => helper)", false],
  ["helper(); register(() => helper)", false], ["register(() => unknown)", false], ["register(() => 1)", false]] as const) test(`opaque inline ownership ${body}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-inline-facts-"));
  try {
    const path = join(root, "main.ts"); const content = `import { register } from 'opaque'; function helper() { return 1; } export function main() { return ${body}; }`;
    const snapshot = new Map([[path, content], [join(root, "package.json"), '{"dependencies":{"opaque":"1.0.0"}}']]);
    for (const [file, text] of snapshot) writeFileSync(file, text);
    const config = { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1" as const, analysisProfile: "modelo-suite-static-v1" as const };
    expect(inspectModuleConfiguration(path, root, snapshot)).toContain("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED");
    const analysis = analyzeRepository(config, [{ absPath: path, relPath: "main.ts", role: "source", language: "typescript", content }], snapshot);
    expect(inspectModuleConfiguration(path, root, snapshot).includes("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED")).toBe(!allowed);
    if (allowed) {
      const caller = analysis.graph.nodes.find(node => node.name === "main")!; const helper = analysis.graph.nodes.find(node => node.name === "helper")!;
      expect(analysis.graph.edges).toContainEqual(expect.objectContaining({ kind: "calls", from: caller.id, to: helper.id }));
      registerOpaqueCallbackOwnership(snapshot, { ...analysis.graph, edges: [] }, root);
      expect(inspectModuleConfiguration(path, root, snapshot)).toContain("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actual test binding ownership preserves the unchanged public Vitest callback", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-inline-test-binding-"));
  try {
    const path = join(root, "value.test.ts"); const leaf = join(root, "value.mjs");
    const content = 'import { test, expect } from "vitest";\nimport { value } from "./value.mjs";\ntest("returns the primitive fixture value", () => { expect(value(1)).toBe(2); });\n';
    const target = "export function value(input) { return 1 + 1; }\n";
    const snapshot = new Map([[path, content], [leaf, target], [join(root, "package.json"), '{"devDependencies":{"vitest":"4.0.0"}}']]);
    for (const [file, text] of snapshot) writeFileSync(file, text);
    const config = { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1" as const, analysisProfile: "modelo-suite-static-v1" as const, languages: { typescript: "on" as const, javascript: "on" as const } };
    const analysis = analyzeRepository(config, [{ absPath: path, relPath: "value.test.ts", role: "test", language: "typescript", content },
      { absPath: leaf, relPath: "value.mjs", role: "source", language: "javascript", content: target }], snapshot);
    const testNode = analysis.graph.nodes.find(node => node.kind === "test")!; const value = analysis.graph.nodes.find(node => node.name === "value")!;
    expect(analysis.graph.edges).toContainEqual(expect.objectContaining({ kind: "covers", from: testNode.id, to: value.id }));
    expect(analysis.graph.edges).toContainEqual(expect.objectContaining({ kind: "tested_by", from: value.id, to: testNode.id }));
    expect(inspectModuleConfiguration(path, root, snapshot)).not.toContain("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("anonymous default declaration owns its already modeled inline call", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-inline-default-"));
  try {
    const path = join(root, "main.ts");
    const content = "import { register } from 'opaque'; function helper() { return 1; } export default function() { return register(() => helper()); }";
    const snapshot = new Map([[path, content], [join(root, "package.json"), '{"dependencies":{"opaque":"1.0.0"}}']]);
    for (const [file, text] of snapshot) writeFileSync(file, text);
    const config = { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1" as const, analysisProfile: "modelo-suite-static-v1" as const };
    const analysis = analyzeRepository(config, [{ absPath: path, relPath: "main.ts", role: "source", language: "typescript", content }], snapshot);
    const caller = analysis.graph.nodes.find(node => node.name === "default")!; const helper = analysis.graph.nodes.find(node => node.name === "helper")!;
    expect(analysis.graph.edges).toContainEqual(expect.objectContaining({ kind: "calls", from: caller.id, to: helper.id }));
    const reasons = inspectModuleConfiguration(path, root, snapshot);
    console.info(JSON.stringify({ defaultInlineReasons: reasons, caller: caller.name }));
    expect(reasons).not.toContain("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
