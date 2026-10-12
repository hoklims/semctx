import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTypeScript } from "../src";
import { analyzeRepository } from "../src";
import { createGlobSelectionConfig } from "@semantic-context/core";

test("namespace constant runtime reference must retain its actual missing-target coordinate", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-namespace-value-"));
  try {
    const dep = join(root, "dep.ts"); const file = join(root, "dep.test.ts");
    const inputs = new Map([[dep, "export const FLAG=true;"], [file, "import * as dep from './dep';export const observed=dep.FLAG;"]]);
    for (const [path, text] of inputs) writeFileSync(path, text);
    const result = extractTypeScript([...inputs.keys()], root, inputs);
    console.info(JSON.stringify({ imports: result.imports, symbols: result.symbols }));
    expect(result.imports[0]?.bindingTargets?.some(target => target.relPath === "dep.ts" && target.symbolPath === "FLAG")).toBe(true);
    expect(result.symbols.some(symbol => symbol.name === "FLAG")).toBe(false);
    expect(result.imports[0]?.bindingTargets?.[0]?.unmodeledReason).toBe("VALUE_DECLARATION");
    expect(extractTypeScript([...inputs.keys()], root).imports[0]?.bindingTargets).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unused, erased and shadowed import occurrences do not prove runtime use", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-import-use-"));
  try {
    const dep = join(root, "dep.ts"); const file = join(root, "consumer.ts");
    for (const content of [
      "import {FLAG} from './dep';export function run(){return 1;}",
      "import {FLAG} from './dep';export type Mode=typeof FLAG;export function run(){return 1;}",
      "import {FLAG} from './dep';export function run(FLAG:boolean){return FLAG;}",
    ]) {
      const inputs = new Map([[dep, "export const FLAG=true;"], [file, content]]);
      for (const [path, text] of inputs) writeFileSync(path, text);
      expect(extractTypeScript([...inputs.keys()], root, inputs).imports[0]?.bindingTargets?.[0]?.runtimeUsed).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("enum namespace value cannot reuse a global-function homonym as test coverage", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-enum-origin-"));
  try {
    const dep = join(root, "dep.ts"); const file = join(root, "dep.test.ts");
    const inputs = new Map([[dep, "export enum Mode { FLAG } export function FLAG(){return 1;}"], [file, "import * as dep from './dep';export const observed=dep.Mode.FLAG;"]]);
    for (const [path, text] of inputs) writeFileSync(path, text);
    const result = analyzeRepository({ ...createGlobSelectionConfig(root), include: ["**/*.ts"] }, undefined, inputs);
    const target = result.graph.nodes.find(node => node.name === "FLAG" && node.kind === "function");
    expect(target).toBeDefined();
    expect(result.graph.edges.some(edge => edge.kind === "tested_by" && edge.from === target?.id)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
