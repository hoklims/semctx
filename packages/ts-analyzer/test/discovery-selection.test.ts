import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDefaultConfig, type SemctxConfig } from "@semantic-context/core";
import { analyzeWorkspace, analyzeWorkspaceSync } from "@semantic-context/workspace-analyzer-internal";
import {
  discoverFiles,
  countTypeScriptFiles,
  createDiscoveryPathExclusion,
  discoverRepository,
  isPathSelected,
} from "@semantic-context/ts-analyzer";

const roots: string[] = [];
const itOnPosix = process.platform === "win32" ? it.skip : it;

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

describe("discovery path exclusion shared with workspace discovery", () => {
  it.each([
    ["intake", "intake/copy", true, true],
    ["packages/*", "packages/core", true, true],
    ["packages/*/src", "packages/core", true, true],
    ["packages/*/package.json", "packages/core", true, false],
    ["packages/*/src/*.ts", "packages/core", false, true],
    ["intake/**", "intake/copy", false, false],
    ["packages/*/**", "packages/core", false, false],
    ["**", "packages/core", false, false],
  ] as const)("keeps file-glob scope aligned for %s in sync and async workspace discovery", async (exclude, workspaceRoot, sourceSelected, manifestSelected) => {
    const root = fixture();
    mkdirSync(join(root, workspaceRoot, "src"), { recursive: true });
    writeFileSync(join(root, workspaceRoot, "package.json"), '{"name":"scope-regression"}\n');
    writeFileSync(join(root, workspaceRoot, "src/main.ts"), "export const scoped = true;\n");
    const config = globConfig(root, { include: [`${workspaceRoot}/src/**/*.ts`], exclude: [exclude] });
    const source = `${workspaceRoot}/src/main.ts`;
    expect(isPathSelected(config, source)).toBe(sourceSelected);
    expect(discoverRepository(config).files.map((file) => file.relPath).includes(source)).toBe(sourceSelected);
    const input = { repositoryRoot: root, excludePath: createDiscoveryPathExclusion(config) };
    const sync = analyzeWorkspaceSync(input);
    const asyncProjection = await analyzeWorkspace(input);
    expect(sync.nodes.some((node) => node.root === workspaceRoot)).toBe(manifestSelected);
    expect(asyncProjection).toEqual(sync);
  });

  it("applies the legacy v1 ignored segments and substring excludes to directories and manifests", () => {
    const excluded = createDiscoveryPathExclusion({ ...createDefaultConfig("/repo"), exclude: ["intake"] });
    expect(excluded("intake")).toBe(true);
    expect(excluded("intake/copy")).toBe(true);
    expect(excluded("intake/copy/package.json")).toBe(true);
    expect(excluded("packages/core/dist")).toBe(true);
    expect(excluded("packages/core")).toBe(false);
    expect(excluded("packages/core/package.json")).toBe(false);
  });

  it("applies v2 exclude globs to a directory itself and to its contents", () => {
    const excluded = createDiscoveryPathExclusion(globConfig("/repo", { exclude: ["intake/**"] }));
    expect(excluded("intake", "directory")).toBe(true);
    expect(excluded("intake/copy/package.json", "file")).toBe(true);
    expect(excluded("packages/core/build")).toBe(true);
    expect(excluded("packages/core")).toBe(false);
    expect(excluded("services/package.json")).toBe(false);
  });

  it("keeps output directories for the qualified profile, whose walk retains them", () => {
    const excluded = createDiscoveryPathExclusion(globConfig("/repo", {
      exclude: [],
      analysisProfile: "modelo-suite-static-v1",
    } as Partial<SemctxConfig>));
    expect(excluded("packages/core/dist")).toBe(false);
    expect(excluded("packages/core/node_modules")).toBe(true);
  });
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

  it("does not discover sources inside a nested Git worktree", () => {
    const root = fixture();
    mkdirSync(join(root, "nested-worktree"), { recursive: true });
    writeFileSync(join(root, "nested-worktree", ".git"), "gitdir: ../.git/worktrees/nested\n");
    writeFileSync(join(root, "nested-worktree", "hidden.ts"), "export const hidden = true;\n");

    expect(discoverFiles(createDefaultConfig(root)).map((file) => file.relPath)).not.toContain(
      "nested-worktree/hidden.ts",
    );
    expect(discoverRepository(globConfig(root, { include: ["**/*.ts"] })).candidates)
      .not.toContainEqual(expect.objectContaining({ relPath: "nested-worktree/hidden.ts" }));
    for (const config of [createDefaultConfig(root), globConfig(root)]) {
      expect(countTypeScriptFiles(config)).toBe(1);
    }
  });

  itOnPosix("does not discover sources when the nested Git marker is a symlink", () => {
    const root = fixture();
    mkdirSync(join(root, "nested-worktree"), { recursive: true });
    writeFileSync(join(root, "git-marker"), "gitdir: ../.git/worktrees/nested\n");
    symlinkSync("../git-marker", join(root, "nested-worktree", ".git"));
    writeFileSync(join(root, "nested-worktree", "hidden.ts"), "export const hidden = true;\n");

    expect(discoverFiles(createDefaultConfig(root)).map((file) => file.relPath)).not.toContain(
      "nested-worktree/hidden.ts",
    );
    expect(discoverRepository(globConfig(root, { include: ["**/*.ts"] })).candidates)
      .not.toContainEqual(expect.objectContaining({ relPath: "nested-worktree/hidden.ts" }));
  });

  it("keeps root sources for repository and worktree Git markers", () => {
    for (const directory of [true, false]) {
      const root = fixture();
      if (directory) mkdirSync(join(root, ".git"));
      else writeFileSync(join(root, ".git"), "gitdir: elsewhere\n");
      for (const config of [createDefaultConfig(root), globConfig(root)]) {
        expect(discoverFiles(config).map((file) => file.relPath)).toContain("src/legacy.ts");
        expect(countTypeScriptFiles(config)).toBe(1);
      }
    }
  });

  it("fails closed on Git marker inspection errors in both config versions", () => {
    const root = fixture();
    const original = fs.lstatSync;
    const probe = spyOn(fs, "lstatSync").mockImplementation(((path, options) => {
      if (String(path) === join(root, "src", ".git")) {
        throw Object.assign(new Error("marker access denied"), { code: "EACCES" });
      }
      return original(path, options);
    }) as typeof fs.lstatSync);
    try {
      for (const config of [createDefaultConfig(root), globConfig(root)]) {
        for (const discover of [discoverFiles, discoverRepository, countTypeScriptFiles]) {
          expect(() => discover(config)).toThrow(expect.objectContaining({ code: "IO_ERROR" }));
        }
      }
    } finally {
      probe.mockRestore();
    }
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

  it("fails closed when either discovery version cannot enumerate a repository directory", () => {
    const root = fixture();
    const original = fs.readdirSync;
    const probe = spyOn(fs, "readdirSync").mockImplementation(((path, options) => {
      if (String(path) === join(root, "services")) {
        throw Object.assign(new Error("directory access denied"), { code: "EACCES" });
      }
      return original(path, options as never);
    }) as typeof fs.readdirSync);
    try {
      for (const config of [createDefaultConfig(root), globConfig(root)]) {
        expect(() => discoverRepository(config)).toThrow(expect.objectContaining({ code: "IO_ERROR" }));
      }
    } finally {
      probe.mockRestore();
    }
  });

  it("records unreadable selected files as READ_FAILED instead of silently dropping them", () => {
    const root = fixture();
    const unreadable = join(root, "src", "legacy.ts");
    const original = fs.readFileSync;
    const probe = spyOn(fs, "readFileSync").mockImplementation(((path, options) => {
      if (String(path) === unreadable) {
        throw Object.assign(new Error("file access denied"), { code: "EACCES" });
      }
      return original(path, options as never);
    }) as typeof fs.readFileSync);
    try {
      for (const config of [createDefaultConfig(root), globConfig(root)]) {
        const result = discoverRepository(config);
        expect(result.files.map((file) => file.relPath)).not.toContain("src/legacy.ts");
        expect(result.candidates.find((candidate) => candidate.relPath === "src/legacy.ts"))
          .toMatchObject({
            selectionDecision: "selected",
            analysisOutcome: "failed",
            reason: "READ_FAILED",
          });
      }
    } finally {
      probe.mockRestore();
    }
  });

  it("records relative imports and reference paths escaping the repository as failed", () => {
    const root = fixture();
    const outside = join(dirname(root), `${root.split(/[\\/]/).at(-1)}-outside`);
    roots.push(outside);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "imported.ts"), "export const secret = 'outside';\n");
    writeFileSync(join(outside, "types.d.ts"), "declare const externalType: string;\n");
    writeFileSync(
      join(root, "src", "legacy.ts"),
      "import { secret } from '../../" + outside.split(/[\\/]/).at(-1) + "/imported';\n"
        + "export const value = secret;\n",
    );
    writeFileSync(
      join(root, "src", "referenced.ts"),
      "/// <reference path='../../" + outside.split(/[\\/]/).at(-1) + "/types.d.ts' />\n"
        + "export const value = externalType;\n",
    );

    for (const config of [
      createDefaultConfig(root),
      globConfig(root, { include: ["src/**/*.ts"] }),
    ]) {
      const result = discoverRepository(config);
      expect(result.files.map((file) => file.relPath)).not.toContain("src/legacy.ts");
      expect(result.files.map((file) => file.relPath)).not.toContain("src/referenced.ts");
      expect(result.candidates.find((candidate) => candidate.relPath === "src/legacy.ts"))
        .toMatchObject({ analysisOutcome: "failed", reason: "IMPORT_OUTSIDE_REPOSITORY" });
      expect(result.candidates.find((candidate) => candidate.relPath === "src/referenced.ts"))
        .toMatchObject({ analysisOutcome: "failed", reason: "REFERENCE_OUTSIDE_REPOSITORY" });
    }
  });

  it("records a source link escaping the repository without reading its target", () => {
    const root = fixture();
    const outside = mkdtempSync(join(tmpdir(), "semctx-selection-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "linked.ts"), "export const secret = 'outside';\n");
    symlinkSync(outside, join(root, "linked-sources"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(
      join(root, "src", "consumer.ts"),
      "import { secret } from '../linked-sources/linked'; export const value = secret;\n",
    );

    for (const config of [
      createDefaultConfig(root),
      globConfig(root, { include: ["**/*.ts"] }),
    ]) {
      const result = discoverRepository(config);
      expect(result.files.map((file) => file.relPath)).not.toContain("linked-sources/linked.ts");
      expect(result.files.map((file) => file.relPath)).not.toContain("src/consumer.ts");
      expect(result.candidates.find((candidate) => candidate.relPath === "linked-sources"))
        .toMatchObject({ analysisOutcome: "failed", reason: "SOURCE_LINK_OUTSIDE_REPOSITORY" });
      expect(result.candidates.find((candidate) => candidate.relPath === "src/consumer.ts"))
        .toMatchObject({ analysisOutcome: "failed", reason: "IMPORT_OUTSIDE_REPOSITORY" });
      expect(() => countTypeScriptFiles(config)).toThrow(expect.objectContaining({ code: "IO_ERROR" }));
    }
  });
});
