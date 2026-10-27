import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { compareAssembly } from "./t00-lot2-assembly";

test("assembly comparison rejects empty receiver evidence", () => {
  const success = { kind: "success", exit_code: 0 };
  const execution = { index: success, verification: success };
  expect(compareAssembly({}, {}, execution).pass).toBe(false);
  const empty = { graph: { nodes: [], edges: [] }, integrityReasons: {}, imports: [], admission: { status: "admitted", reasons: [], changeCoverage: { files: [{ path: "src/main.ts", status: "analyzed" }] } } };
  expect(compareAssembly(empty, empty, execution).pass).toBe(false);
});

test("assembly comparison detects an omitted public dynamic-import refusal", () => {
  const source = { graph: { nodes: [{ id: "test:test/main.test.ts" }], edges: [] }, integrityReasons: { "test/main.test.ts": ["QUALIFIED_TEST_DYNAMIC_IMPORT_BINDING_UNPROVEN:src/main.ts"] }, imports: [{ fromRelPath: "test/main.test.ts", moduleSpecifier: "../src/main", line: 1 }], admission: { status: "rejected", reasons: ["ANALYSIS_SCOPE_INCOMPLETE:test/main.test.ts:failed"], changeCoverage: { files: [{ path: "test/main.test.ts", status: "failed", reasons: ["QUALIFIED_TEST_DYNAMIC_IMPORT_BINDING_UNPROVEN:src/main.ts"] }] } } };
  const native = { ...source, integrityReasons: {}, admission: { status: "admitted", reasons: [], changeCoverage: { files: [{ path: "test/main.test.ts", status: "analyzed" }] } } };
  expect(compareAssembly(source, native, { index: { kind: "success", exit_code: 0 }, verification: { kind: "success", exit_code: 0 } }).pass).toBe(false);
  expect(compareAssembly(source, source, { index: { kind: "success", exit_code: 0 }, verification: { kind: "success", exit_code: 0 } }).pass).toBe(true);
});

test("assembly comparison rejects populated graphs without executed admission or imports", () => {
  const incomplete = { graph: { nodes: [{ id: "test:test/main.test.ts" }], edges: [] } };
  const success = { kind: "success", exit_code: 0 };
  expect(compareAssembly(incomplete, incomplete, { index: success, verification: success }).pass).toBe(false);
});

test("assembly comparison rejects a timeout even when complete JSON was captured", () => {
  const observed = { graph: { nodes: [{ id: "mod:src/main.ts" }], edges: [] }, integrityReasons: {}, imports: [], admission: { status: "admitted", reasons: [], changeCoverage: { files: [{ path: "src/main.ts", status: "analyzed" }] } } };
  const success = { kind: "success", exit_code: 0 };
  const timeout = { kind: "success", exit_code: null, error: "ETIMEDOUT", stdout: JSON.stringify(observed) };
  expect(compareAssembly(observed, observed, { index: timeout, verification: success }).pass).toBe(false);
  expect(compareAssembly(observed, observed, { index: success, verification: timeout }).pass).toBe(false);
  expect(compareAssembly(observed, observed, { index: success, verification: success }).pass).toBe(true);
});

test("oracle refuses a foreign compiler even when it advertises TypeScript 5.9.3", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "semctx-lot2-compiler-"));
  try {
    const root = resolve(import.meta.dir, "..");
    const shim = resolve(directory, "foreign.ts"), config = resolve(directory, "tsconfig.json");
    writeFileSync(shim, 'export default { version: "5.9.3" };\n');
    writeFileSync(config, JSON.stringify({ extends: resolve(root, "tsconfig.json"), compilerOptions: { paths: { typescript: [shim] } } }));
    const result = spawnSync(process.execPath, ["--tsconfig-override", config, resolve(import.meta.dir, "t00-lot2-assembly.ts"), "oracle", root, resolve(directory, "absent-input.json"), resolve(directory, "output.json")], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Oracle compiler binding differs from canonical TypeScript 5.9.3");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("assembly compares graph sets independently of JSON object key order", () => {
  const source = { graph: { nodes: [{ id: "mod:src/main.ts", kind: "module" }, { id: "sym:function:src/main.ts:main", kind: "function" }], edges: [] }, integrityReasons: {}, imports: [], admission: { status: "admitted", reasons: [], changeCoverage: { files: [{ path: "src/main.ts", status: "analyzed" }] } } };
  const native = { ...source, graph: { nodes: [{ kind: "module", id: "mod:src/main.ts" }, { kind: "function", id: "sym:function:src/main.ts:main" }], edges: [] } };
  const success = { kind: "success", exit_code: 0 };
  expect(compareAssembly(source, native, { index: success, verification: success }).pass).toBe(true);
});
