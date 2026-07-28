import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig, type SemctxConfig } from "@semantic-context/core";
import {
  discoverFiles,
  discoverRepository,
  isPathSelected,
} from "@semantic-context/ts-analyzer";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-selection-"));
  roots.push(root);
  for (const path of ["src", "services/api", "docs", "vendor", "équipe"]) {
    mkdirSync(join(root, path), { recursive: true });
  }
  writeFileSync(join(root, "src", "legacy.ts"), "export const legacy = true;\n");
  writeFileSync(join(root, "services", "api", "main.py"), "def main():\n    return 1\n");
  writeFileSync(join(root, "services", "api", "ignored.py"), "def ignored():\n    return 0\n");
  writeFileSync(join(root, "docs", "guide.md"), "# Guide\n");
  writeFileSync(join(root, "vendor", "third_party.py"), "def vendor():\n    return 0\n");
  writeFileSync(join(root, "équipe", "outil.py"), "def outil():\n    return 1\n");
  writeFileSync(join(root, "README.txt"), "not semantically analyzed\n");
  return root;
}

function globConfig(root: string, overrides: Partial<SemctxConfig> = {}): SemctxConfig {
  return {
    ...createDefaultConfig(root),
    version: 2,
    selectionMode: "globs-v1",
    include: ["services/**/*.py", "équipe/**/*.py", "src/**/*.ts"],
    exclude: ["services/**/ignored.py", "vendor/**"],
    languages: {
      typescript: "on",
      python: "on",
      markdown: "on",
      sql: "on",
    },
    ...overrides,
  } as SemctxConfig;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("versioned source selection", () => {
  it("preserves legacy v1 discovery even when include does not match", () => {
    const root = fixture();
    const config = { ...createDefaultConfig(root), include: ["does-not-match/**/*.ts"] };
    expect(discoverFiles(config).map((file) => file.relPath)).toEqual([
      "docs/guide.md",
      "src/legacy.ts",
    ]);
  });

  it("applies normalized include globs with exclude precedence in v2", () => {
    const root = fixture();
    const result = discoverRepository(globConfig(root));
    expect(result.files.map((file) => file.relPath)).toEqual([
      "services/api/main.py",
      "src/legacy.ts",
      "équipe/outil.py",
    ]);
    expect(result.candidates.find((candidate) => candidate.relPath === "services/api/ignored.py"))
      .toMatchObject({
        selectionDecision: "excluded",
        reason: "EXCLUDE_MATCH",
      });
  });

  it("records every considered candidate in deterministic code-unit order", () => {
    const root = fixture();
    const result = discoverRepository(globConfig(root));
    const paths = result.candidates.map((candidate) => candidate.relPath);
    expect(paths).toEqual([...paths].sort());
    expect(new Set(paths).size).toBe(paths.length);
    expect(result.candidates.find((candidate) => candidate.relPath === "README.txt"))
      .toMatchObject({
        selectionDecision: "excluded",
        reason: "INCLUDE_MISS",
      });
  });

  it("keeps selected but disabled and unsupported languages distinct", () => {
    const root = fixture();
    writeFileSync(join(root, "services", "api", "worker.rb"), "def work = 1\n");
    const config = globConfig(root, {
      include: ["services/**/*.{py,rb}"],
      languages: {
        typescript: "on",
        python: "off",
        markdown: "on",
        sql: "on",
      },
    } as Partial<SemctxConfig>);
    const result = discoverRepository(config);
    expect(result.candidates.find((candidate) => candidate.relPath === "services/api/main.py"))
      .toMatchObject({
        selectionDecision: "selected",
        analysisOutcome: "disabled",
        language: "python",
      });
    expect(result.candidates.find((candidate) => candidate.relPath === "services/api/worker.rb"))
      .toMatchObject({
        selectionDecision: "selected",
        analysisOutcome: "unsupported",
        language: "unknown",
      });
  });

  it("treats an empty v2 include list as an explicit empty selection", () => {
    const root = fixture();
    const result = discoverRepository(globConfig(root, { include: [] }));
    expect(result.files).toEqual([]);
    expect(result.candidates.every((candidate) => candidate.selectionDecision === "excluded")).toBe(true);
  });

  it("normalizes Windows separators before applying include and exclude precedence", () => {
    const root = fixture();
    const config = globConfig(root);
    expect(isPathSelected(config, "services\\api\\main.py")).toBe(true);
    expect(isPathSelected(config, "services\\api\\ignored.py")).toBe(false);
  });

  it("fails closed when v2 discovery cannot enumerate the configured repository root", () => {
    const parent = fixture();
    const missing = join(parent, "missing-repository");

    expect(() => discoverRepository(globConfig(missing))).toThrow(
      expect.objectContaining({ code: "IO_ERROR" }),
    );
  });
});
