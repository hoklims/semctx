import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BRIDGE, CONSUMER_VERSIONS, createConsumer, createEligibleConsumer, createPrimitiveSafeConsumer, createDataProvenConsumer, ENTRY, LEAF, LEAF_SOURCE, PRIMITIVE_SAFE_LEAF_SOURCE, WORKSPACES } from "./modelo-static-fixture";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "@semantic-context/app-services";
import { writeFileSync } from "node:fs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string { const root = mkdtempSync(join(tmpdir(), "public-consumer-")); roots.push(root); createConsumer(root); return root; }
test("round4 original declaration-bearing public consumer remains a visible BLOCK witness", () => {
  const root = fixture();
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]]) {
    const process = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (process.exitCode !== 0) throw new Error(new TextDecoder().decode(process.stderr));
  }
  initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["suite/**/*"], languages: { typescript: "on", javascript: "on" } });
  writeFileSync(join(root, LEAF), "export function value(input) { return input + 2; }\n");
  indexRepository(root, "2026-10-09T10:01:00.000Z");
  const admission = runVerify(root, { kind: "working-tree" }).report.analysisAdmission;
  expect(admission?.status).toBe("rejected");
  expect(admission?.reasons).toContain("DEPENDENCY_SCOPE_DECLARATION_UNSUPPORTED:suite/domains/sample/core/value.d.mts");
}, 60_000);

test("round20 original eligible-esm unknown coercion consumer remains a visible BLOCK witness", () => {
  const root = mkdtempSync(join(tmpdir(), "public-eligible-consumer-")); roots.push(root);
  createEligibleConsumer(root);
  expect(existsSync(join(root, "suite/domains/sample/core/value.d.mts"))).toBe(false);
  expect(existsSync(join(root, "suite/contracts/api/port.cts"))).toBe(false);
  expect(existsSync(join(root, "suite/contracts/api/port.ts"))).toBe(true);
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]]) {
    const process = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (process.exitCode !== 0) throw new Error(new TextDecoder().decode(process.stderr));
  }
  initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["suite/**/*"], languages: { typescript: "on", javascript: "on" } });
  writeFileSync(join(root, LEAF), "export function value(input) { return input + 2; }\n");
  indexRepository(root, "2026-10-09T10:01:00.000Z");
  const report = runVerify(root, { kind: "working-tree" }).report;
  expect(report.analysisAdmission?.status).toBe("rejected");
  expect(report.analysisAdmission?.reasons.some(reason => reason.includes("COERCION_UNSUPPORTED"))).toBe(true);
  expect(readFileSync(join(root, "suite/domains/sample/core/value.test.ts"), "utf8")).toContain("increments the input");
}, 60_000);
test("round27 original primitive-safe ESM consumer remains an opaque-data BLOCK witness", () => {
  const root = mkdtempSync(join(tmpdir(), "public-primitive-consumer-")); roots.push(root); createPrimitiveSafeConsumer(root);
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]]) expect(Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
  initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["suite/**/*"], languages: { typescript: "on", javascript: "on" } });
  writeFileSync(join(root, LEAF), PRIMITIVE_SAFE_LEAF_SOURCE.replace("+ 1", "+ 2"));
  indexRepository(root, "2026-10-09T10:01:00.000Z");
  const report = runVerify(root, { kind: "working-tree" }).report;
  expect(report.analysisAdmission?.status).toBe("rejected");
  expect(report.analysisAdmission?.reasons.some(reason => reason.includes("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"))).toBe(true);
}, 60_000);
test("fourth data-proven ESM consumer qualifies mixed static impact", () => {
  const root = mkdtempSync(join(tmpdir(), "public-data-consumer-")); roots.push(root); createDataProvenConsumer(root);
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]]) expect(Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
  initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["suite/**/*"], languages: { typescript: "on", javascript: "on" } });
  writeFileSync(join(root, LEAF), PRIMITIVE_SAFE_LEAF_SOURCE.replace("+ 1", "+ 2"));
  indexRepository(root, "2026-10-09T10:01:00.000Z");
  const report = runVerify(root, { kind: "working-tree" }).report;
  expect(report.analysisAdmission?.status).toBe("admitted");
  expect(report.analysisAdmission?.changeCoverage.analyzed).toContain(ENTRY);
}, 60_000);
test("fourth domain preserves historical primitive fixture bytes except two guarded Node helpers", () => {
  const oldRoot = mkdtempSync(join(tmpdir(), "public-third-")); const newRoot = mkdtempSync(join(tmpdir(), "public-fourth-")); roots.push(oldRoot, newRoot);
  createPrimitiveSafeConsumer(oldRoot); createDataProvenConsumer(newRoot);
  const inventory = (root: string, prefix = ""): string[] => readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? inventory(root, join(prefix, entry.name)) : [join(prefix, entry.name)]).sort();
  const files = inventory(oldRoot); expect(inventory(newRoot)).toEqual(files);
  expect(files.filter(path => !readFileSync(join(oldRoot, path)).equals(readFileSync(join(newRoot, path))))).toEqual(["suite/tooling/check/build.mjs", "suite/tooling/check/check.mjs"].map(path => path.replaceAll("/", process.platform === "win32" ? "\\" : "/")));
  expect(readFileSync(join(oldRoot, LEAF), "utf8")).toBe(PRIMITIVE_SAFE_LEAF_SOURCE);
  expect(readFileSync(join(newRoot, LEAF), "utf8")).toBe(PRIMITIVE_SAFE_LEAF_SOURCE);
});
test("new primitive domain preserves both original fixture outputs and changes only leaf semantics and test copy", () => {
  const oldRoot = mkdtempSync(join(tmpdir(), "public-original-esm-")); const newRoot = mkdtempSync(join(tmpdir(), "public-safe-esm-")); roots.push(oldRoot, newRoot);
  createEligibleConsumer(oldRoot); createPrimitiveSafeConsumer(newRoot);
  expect(readFileSync(join(oldRoot, LEAF), "utf8")).toBe(LEAF_SOURCE);
  const inventory = (root: string, prefix = ""): string[] => readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? inventory(root, join(prefix, entry.name)) : [join(prefix, entry.name)]).sort();
  const files = inventory(oldRoot); expect(inventory(newRoot)).toEqual(files);
  const changed = files.filter(path => !readFileSync(join(oldRoot, path)).equals(readFileSync(join(newRoot, path))));
  expect(changed).toEqual([LEAF.replaceAll("/", process.platform === "win32" ? "\\" : "/"), "suite/domains/sample/core/value.test.ts".replaceAll("/", process.platform === "win32" ? "\\" : "/")].sort());
  expect(readFileSync(join(newRoot, LEAF), "utf8")).toBe(PRIMITIVE_SAFE_LEAF_SOURCE);
  expect(readFileSync(join(newRoot, "suite/domains/sample/core/value.test.ts"), "utf8")).toContain("primitive fixture value");
});
test("preserves the nested consumer workspace selection", () => {
  const root = fixture();
  expect(JSON.parse(readFileSync(join(root, "suite/package.json"), "utf8")).workspaces).toEqual(WORKSPACES);
});
test("pins consumer TypeScript independently of the analyzer", () => {
  const root = fixture();
  expect(JSON.parse(readFileSync(join(root, "suite/package.json"), "utf8")).devDependencies.typescript).toBe(CONSUMER_VERSIONS.typescript);
});
test("creates a cross language transitive call chain", () => {
  const root = fixture();
  expect(readFileSync(join(root, LEAF), "utf8")).toContain("export function value");
  expect(readFileSync(join(root, BRIDGE), "utf8")).toContain("value.mjs");
  expect(readFileSync(join(root, ENTRY), "utf8")).toContain("@public/shared");
});
