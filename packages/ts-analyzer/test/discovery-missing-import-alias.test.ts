import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { discoverRepository, inspectJavaScriptSource } from "../src";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(content: string) {
  const parent = mkdtempSync(join(tmpdir(), "semctx-missing-import-alias-")); roots.push(parent);
  const physical = join(parent, "physical"); mkdirSync(physical);
  const alias = join(parent, "alias");
  symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(physical, "script.mjs"), content);
  const config = { ...createGlobSelectionConfig(alias), include: ["**/*.mjs"], exclude: [], languages: { javascript: "on" as const } };
  return { parent, physical, alias, config };
}

it("keeps missing in-repository imports selected when the repository root has a directory alias", () => {
  const { config } = fixture("export { missing } from './not-created/deeper/missing.mjs';");
  const result = discoverRepository(config);
  expect(result.candidates.find(candidate => candidate.relPath === "script.mjs")).toMatchObject({ selectionDecision: "selected", reason: "SELECTED" });
  expect(result.files).toHaveLength(1);
  const source = result.files[0]!;
  expect(inspectJavaScriptSource(source.absPath, source.content, config.repositoryRoot).reasons).toContain("JAVASCRIPT_IMPORT_UNRESOLVED:./not-created/deeper/missing.mjs");
});

it("still rejects genuinely escaping missing paths under a directory alias", () => {
  const { config } = fixture("export { missing } from '../outside/not-created/missing.mjs';");
  expect(discoverRepository(config).candidates.find(candidate => candidate.relPath === "script.mjs")).toMatchObject({ analysisOutcome: "failed", reason: "IMPORT_OUTSIDE_REPOSITORY" });
});

it("still rejects missing targets below an existing external directory symlink", () => {
  const { parent, physical, config } = fixture("export { missing } from './external/not-created/missing.mjs';");
  const outside = join(parent, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(physical, "external"), process.platform === "win32" ? "junction" : "dir");
  expect(discoverRepository(config).candidates.find(candidate => candidate.relPath === "script.mjs")).toMatchObject({ analysisOutcome: "failed", reason: "IMPORT_OUTSIDE_REPOSITORY" });
});
