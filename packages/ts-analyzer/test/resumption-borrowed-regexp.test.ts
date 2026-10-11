import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { analyzeRepository, extractTypeScript, inspectModuleConfiguration } from "../src";
import { getQualifiedCallIntegrityReasons } from "../src/analyze";

const initializeGit = (root: string): void => {
  const result = Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
};

test("generator extraction keeps initialization but has no consumer resumption edge", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-generator-facts-"));
  try {
    const dep = join(root, "dep.ts"); const consumer = join(root, "consumer.ts");
    const inputs = new Map([[dep, "export function* values(){yield 1;}"], [consumer, "import {values} from './dep';const iterator=values();export function run(){return iterator.next().value;}"]]);
    for (const [path, content] of inputs) writeFileSync(path, content);
    const facts = extractTypeScript([...inputs.keys()], root, inputs);
    console.info(JSON.stringify({ calls: facts.calls }));
    expect(facts.calls.some(call => call.calleeSymbolPath === "values" && call.callerSymbolPath === undefined)).toBe(true);
    expect(facts.calls.some(call => call.callerSymbolPath === "run" && call.calleeSymbolPath === "values")).toBe(false);
    expect(inspectModuleConfiguration(dep, root, inputs)).toContain("SOURCE_ITERATION_UNSUPPORTED");
    expect(extractTypeScript([...inputs.keys()], root).symbols.some(symbol => symbol.name === "values" && symbol.exported)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("known ordinary functions and direct intrinsic RegExp calls remain distinct", () => {
  const path = "/fixture/main.ts";
  expect(inspectModuleConfiguration(path, "/fixture", new Map([[path, "export function values(){return 1;} export function run(){return /x/.test('x');}"]]))).toEqual([]);
});

test("the original intrinsic delegated generator retains ordinary extraction facts", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-ordinary-delegation-"));
  try {
    const path = join(root, "main.ts");
    writeFileSync(path, "export function* start() { yield* 'abc'; }");
    expect(extractTypeScript([path], root).symbols).toContainEqual(expect.objectContaining({ name: "start", exported: true }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("borrowed SDK RegExp protocol helper has no modeled invocation of the ordinary exec member", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-borrowed-regexp-"));
  try {
    const dep = join(root, "dep.ts"); const consumer = join(root, "consumer.ts");
    const inputs = new Map([[dep, "export const matcher={exec(){return null;}};"], [consumer, "import {matcher} from './dep';export function run(){return RegExp.prototype[Symbol.match].call(matcher as RegExp,'x');}"]]);
    for (const [path, content] of inputs) writeFileSync(path, content);
    const facts = extractTypeScript([...inputs.keys()], root, inputs);
    console.info(JSON.stringify({ calls: facts.calls, reasons: inspectModuleConfiguration(consumer, root, inputs) }));
    expect(facts.calls.some(call => call.callerSymbolPath === "run" && call.calleeRelPath === "dep.ts")).toBe(false);
    expect(inspectModuleConfiguration(consumer, root, inputs)).toContain("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native borrowed RegExp hook invokes ordinary exec without a Symbol.match definition", () => {
  const result = Bun.spawnSync([process.execPath, "-e", "const matcher={exec(){console.log('ORDINARY_EXEC_CALLED');return null;}};RegExp.prototype[Symbol.match].call(matcher,'x');"], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0); expect(new TextDecoder().decode(result.stdout)).toContain("ORDINARY_EXEC_CALLED");
});

test("test binding coordinate for an exported primitive exists while its symbol is deliberately unmodeled", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-constant-binding-"));
  try {
    const dep = join(root, "dep.ts"); const testFile = join(root, "dep.test.ts");
    const inputs = new Map([[dep, "export const SECURITY_MODE=true;"], [testFile, "import {SECURITY_MODE} from './dep';export const observed=SECURITY_MODE;"]]);
    for (const [path, content] of inputs) writeFileSync(path, content);
    const facts = extractTypeScript([...inputs.keys()], root, inputs);
    console.info(JSON.stringify({ imports: facts.imports, symbols: facts.symbols }));
    expect(facts.imports[0]?.bindingTargets).toContainEqual({ relPath: "dep.ts", symbolPath: "SECURITY_MODE", unmodeledReason: "VALUE_DECLARATION" });
    expect(facts.symbols.some(symbol => symbol.name === "SECURITY_MODE")).toBe(false);
    initializeGit(root);
    const base = { ...createGlobSelectionConfig(root), include: ["**/*.ts"] };
    const ordinary = analyzeRepository(base, undefined, inputs);
    expect(getQualifiedCallIntegrityReasons(ordinary).size).toBe(0);
    const qualified = analyzeRepository({ ...base, selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1" }, undefined, inputs);
    expect(getQualifiedCallIntegrityReasons(qualified).get("dep.test.ts")).toContain("QUALIFIED_TEST_BINDING_MISSING:dep.ts:SECURITY_MODE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("modeled function test targets preserve their canonical association", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-modeled-binding-"));
  try {
    const dep = join(root, "dep.ts"); const file = join(root, "dep.test.ts");
    const inputs = new Map([[dep, "export function value(){return 1;}"], [file, "import {value} from './dep'; export function check(){return value();}"]]);
    for (const [path, content] of inputs) writeFileSync(path, content);
    initializeGit(root);
    const result = analyzeRepository({ ...createGlobSelectionConfig(root), include: ["**/*.ts"], selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1" }, undefined, inputs);
    expect(getQualifiedCallIntegrityReasons(result).size).toBe(0);
    expect(result.graph.edges.some(edge => edge.kind === "tested_by")).toBe(true);
    expect(result.graph.edges.some(edge => edge.kind === "covers")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
