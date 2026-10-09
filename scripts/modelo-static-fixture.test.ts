import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BRIDGE, CONSUMER_VERSIONS, createConsumer, ENTRY, LEAF, WORKSPACES } from "./modelo-static-fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string { const root = mkdtempSync(join(tmpdir(), "public-consumer-")); roots.push(root); createConsumer(root); return root; }
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
