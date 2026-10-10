import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, type SemctxConfigV2 } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

/**
 * The semctx repository itself: the published CLI (`apps/cli`, a declared workspace member) and a
 * host plugin manifest (`plugins/claude-code`, standalone) share one package name. The collision
 * must not make the declared member unanalysable, or every change to it is blocked by verify.
 */

const roots: string[] = [];

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...path.split("/")), text);
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-verify-workspace-identity-"));
  roots.push(root);
  write(root, ".gitignore", ".semctx/\n");
  write(root, "package.json", `${JSON.stringify({ name: "repo", private: true, workspaces: ["apps/*"] })}\n`);
  write(root, "apps/cli/package.json", `${JSON.stringify({ name: "tool" })}\n`);
  write(root, "apps/cli/src/main.ts", "export const main = 1;\n");
  write(root, "plugins/host/package.json", `${JSON.stringify({ name: "tool", private: true })}\n`);
  write(root, "plugins/host/src/host.ts", "export const host = 1;\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");
  const config: SemctxConfigV2 = { ...createGlobSelectionConfig(root), include: ["**/*.ts"] };
  initWorkspace(root, config);
  return root;
}

const scopeBlocks = (root: string) =>
  runVerify(root, { kind: "working-tree" }).result.findings
    .filter((finding) => finding.rule === "analysis_scope_incomplete" && finding.severity === "block")
    .map((finding) => finding.message);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("verify — a package name shared by a declared member and a standalone manifest", () => {
  it("analyses a change to the declared workspace member", () => {
    const root = repository();
    write(root, "apps/cli/src/main.ts", "export const main = 2;\n");
    indexRepository(root, "2026-10-10T08:00:00.000Z");
    expect(scopeBlocks(root)).toEqual([]);
  }, 30_000);

  it("still blocks a change under the standalone manifest whose name is shadowed", () => {
    const root = repository();
    write(root, "plugins/host/src/host.ts", "export const host = 2;\n");
    indexRepository(root, "2026-10-10T08:00:00.000Z");
    expect(scopeBlocks(root)).toEqual([expect.stringContaining("plugins/host/src/host.ts")]);
  }, 30_000);
});
