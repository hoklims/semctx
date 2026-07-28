import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, type SemctxConfigV2 } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function repository(relPath = "src/service.py"): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-verify-analysis-scope-"));
  roots.push(root);
  mkdirSync(join(root, ...relPath.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(join(root, ...relPath.split("/")), "def service():\n    return 1\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Semctx Test",
    "-c",
    "user.email=semctx@example.test",
    "commit",
    "-q",
    "-m",
    "fixture",
  );
  const config: SemctxConfigV2 = {
    ...createGlobSelectionConfig(root),
    include: ["**/*.py"],
    languages: {
      typescript: "on",
      python: "off",
      markdown: "on",
      sql: "on",
    },
  };
  initWorkspace(root, config);
  indexRepository(root, "2026-07-28T11:00:00.000Z");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("analysis-health changed-scope path coverage", () => {
  it("blocks a deleted selected Python path even though legacy diff analysis omits deletions", () => {
    const root = repository();
    const diffText = [
      "diff --git a/src/service.py b/src/service.py",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/src/service.py",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-def service():",
      "-    return 1",
      "",
    ].join("\n");

    const computation = runVerify(root, { kind: "provided", diffText });

    expect(computation.result.changedFiles).toEqual([]);
    expect(computation.result.verdict).toBe("BLOCK");
    expect(computation.result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "analysis_scope_incomplete",
        severity: "block",
        message: expect.stringContaining("src/service.py"),
      }),
    ]));
  });

  it("blocks a range rename that moves a selected path outside current selection", () => {
    const root = repository();
    const base = git(root, "rev-parse", "HEAD");
    mkdirSync(join(root, "archive"), { recursive: true });
    renameSync(join(root, "src", "service.py"), join(root, "archive", "service.py"));
    git(root, "add", "-A");
    git(
      root,
      "-c",
      "user.name=Semctx Test",
      "-c",
      "user.email=semctx@example.test",
      "commit",
      "-q",
      "-m",
      "move service",
    );

    const computation = runVerify(root, { kind: "range", base });

    expect(computation.result.changedFiles).toEqual([]);
    expect(computation.result.verdict).toBe("BLOCK");
    expect(computation.result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "analysis_scope_incomplete",
        severity: "block",
        message: expect.stringContaining("src/service.py"),
      }),
    ]));
  });

  it("decodes Git C-quoted UTF-8 paths before the analysis-health preflight", () => {
    const root = repository("équipe/service.py");
    const diffText = [
      "diff --git \"a/\\303\\251quipe/service.py\" \"b/\\303\\251quipe/service.py\"",
      "index 1111111..2222222 100644",
      "--- \"a/\\303\\251quipe/service.py\"",
      "+++ \"b/\\303\\251quipe/service.py\"",
      "@@ -1,2 +1,2 @@",
      " def service():",
      "-    return 1",
      "+    return 2",
      "",
    ].join("\n");

    const computation = runVerify(root, { kind: "provided", diffText });

    expect(computation.result.changedFiles).toEqual(["équipe/service.py"]);
    expect(computation.result.verdict).toBe("BLOCK");
    expect(computation.result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "analysis_scope_incomplete",
        severity: "block",
        message: expect.stringContaining("équipe/service.py"),
      }),
    ]));
  });

  it("blocks timestamped unified-diff headers for a disabled Python scope", () => {
    const root = repository();
    const diffText = [
      "--- a/src/service.py\t2026-07-28 12:00:00.000000000 +0200",
      "+++ b/src/service.py\t2026-07-28 12:01:00.000000000 +0200",
      "@@ -1,2 +1,2 @@",
      " def service():",
      "-    return 1",
      "+    return 2",
      "",
    ].join("\n");

    const computation = runVerify(root, { kind: "provided", diffText });

    expect(computation.result.changedFiles).toEqual(["src/service.py"]);
    expect(computation.result.verdict).toBe("BLOCK");
    expect(computation.result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "analysis_scope_incomplete",
        severity: "block",
        message: expect.stringContaining("src/service.py"),
      }),
    ]));
  });

  it("preserves C-quoted Git paths when unified-diff headers include timestamps", () => {
    const root = repository("équipe/service.py");
    const diffText = [
      "--- \"a/\\303\\251quipe/service.py\"\t2026-07-28 12:00:00.000000000 +0200",
      "+++ \"b/\\303\\251quipe/service.py\"\t2026-07-28 12:01:00.000000000 +0200",
      "@@ -1,2 +1,2 @@",
      " def service():",
      "-    return 1",
      "+    return 2",
      "",
    ].join("\n");

    const computation = runVerify(root, { kind: "provided", diffText });

    expect(computation.result.changedFiles).toEqual(["équipe/service.py"]);
    expect(computation.result.verdict).toBe("BLOCK");
  });

  it("rejects a structured non-empty patch that yields no canonical paths", () => {
    const root = repository();
    const diffText = [
      "--- malformed-old-path",
      "+++ malformed-new-path",
      "@@ -1,2 +1,2 @@",
      " def service():",
      "-    return 1",
      "+    return 2",
      "",
    ].join("\n");

    expect(() => runVerify(root, { kind: "provided", diffText })).toThrow(
      "invalid or unpaired unified diff file header",
    );
  });

  it("rejects a binary Python diff instead of skipping analysis health", () => {
    const root = repository();
    const diffText = [
      "diff --git a/src/service.py b/src/service.py",
      "index 1111111..2222222 100644",
      "Binary files a/src/service.py and b/src/service.py differ",
      "",
    ].join("\n");

    expect(() => runVerify(root, { kind: "provided", diffText })).toThrow(
      "unified diff block has no canonical paths",
    );
  });

  it("rejects a malformed Python block after an earlier valid file", () => {
    const root = repository();
    const diffText = [
      "--- a/src/harmless.ts",
      "+++ b/src/harmless.ts",
      "@@ -1 +1 @@",
      "-export const harmless = 1;",
      "+export const harmless = 2;",
      "--- malformed-old-path",
      "+++ b/src/service.py",
      "@@ -1 +1 @@",
      "-    return 1",
      "+    return 2",
      "",
    ].join("\n");

    expect(() => runVerify(root, { kind: "provided", diffText })).toThrow(
      "invalid or unpaired unified diff file header",
    );
  });

  it("rejects one-sided rename metadata that omits the selected old path", () => {
    const root = repository();
    const diffText = [
      "diff --git a/src/service.py b/src/harmless.ts",
      "similarity index 100%",
      "rename to src/harmless.ts",
      "",
    ].join("\n");

    expect(() => runVerify(root, { kind: "provided", diffText })).toThrow(
      "invalid or unpaired unified diff rename metadata",
    );
  });

  it("rejects malformed tab-separated unified-diff header metadata", () => {
    const root = repository();
    const diffText = [
      "--- a/src/service.py\tnot-a-timestamp",
      "+++ b/src/service.py\tnot-a-timestamp",
      "@@ -1,2 +1,2 @@",
      " def service():",
      "-    return 1",
      "+    return 2",
      "",
    ].join("\n");

    expect(() => runVerify(root, { kind: "provided", diffText })).toThrow(
      "invalid unified diff file header metadata",
    );
  });
});
