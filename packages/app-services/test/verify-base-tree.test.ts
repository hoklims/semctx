import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemctxError, createDefaultConfig, createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace, saveConfig } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

const roots: string[] = [];
const MONEY = "/** @invariant money: nonnegative */\nexport function clamp(x: number) { return x < 0 ? 0 : x; }\n";

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "-c", "commit.gpgsign=false", ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function repository(body = MONEY, v2 = false) {
  const root = mkdtempSync(join(tmpdir(), "semctx-base-tree-safety-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(join(root, "src", "money.ts"), body);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  const config = v2 ? { ...createGlobSelectionConfig(root), include: ["**/*.ts"] } : createDefaultConfig(root);
  initWorkspace(root, config);
  return { root, config };
}

function commitHead(root: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "head");
  indexRepository(root, "2026-10-12T00:00:00.000Z");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("range base-tree source safety", () => {
  it("reads raw base blobs without executing checkout filters", () => {
    const { root } = repository();
    writeFileSync(join(root, ".gitattributes"), "*.ts filter=semctx-review\n");
    git(root, "add", ".gitattributes");
    git(root, "commit", "-q", "-m", "base attributes");
    const base = git(root, "rev-parse", "HEAD");
    git(root, "rm", "-q", "src/money.ts");
    commitHead(root);
    const marker = join(root, ".git", "filter-executed");
    const filter = join(root, ".git", "filter.cjs");
    writeFileSync(filter, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");process.stdout.write("export function clamp(x: number) { return x; }\\n");`);
    git(root, "config", "filter.semctx-review.smudge", `"${process.execPath.replaceAll("\\", "/")}" "${filter.replaceAll("\\", "/")}"`);
    git(root, "config", "filter.semctx-review.required", "true");

    const result = runVerify(root, { kind: "range", base }).result;
    expect(existsSync(marker)).toBe(false);
    expect(result.findings.map((finding) => finding.rule)).toContain("invariant_touched_without_test");
    expect(result.verdict).toBe("BLOCK");
  });

  it("blocks a selected failed base scope even when the head scope analyzes", () => {
    const { root } = repository(`import { outside } from "../../outside";\n${MONEY}`, true);
    const base = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "src", "money.ts"), "export function clamp(x: number) { return x < 0 ? 0 : x; }\n");
    commitHead(root);

    const result = runVerify(root, { kind: "range", base }).result;
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({
      rule: "analysis_scope_incomplete", severity: "block", message: expect.stringContaining("src/money.ts"),
    })]));
    expect(result.unknowns.join("\n")).toContain("src/money.ts");
    expect(result.verdict).toBe("BLOCK");
  });

  it("discloses an excluded changed base path instead of an unqualified PASS", () => {
    const { root, config } = repository(MONEY, true);
    const base = git(root, "rev-parse", "HEAD");
    git(root, "rm", "-q", "src/money.ts");
    git(root, "commit", "-q", "-m", "delete");
    saveConfig(root, { ...config, exclude: [...config.exclude, "src/money.ts"] });
    indexRepository(root, "2026-10-12T00:00:00.000Z");

    const result = runVerify(root, { kind: "range", base }).result;
    expect(result.unknowns.join("\n")).toContain("src/money.ts");
    expect(result.verdict).not.toBe("PASS");
    expect(result.findings.map((finding) => finding.rule)).not.toContain("invariant_touched_without_test");
  });

  it("never treats a Git symlink blob as regular TypeScript when core.symlinks is false", () => {
    const { root } = repository("export const helper = 1;\n", true);
    git(root, "config", "core.symlinks", "false");
    const payload = join(root, ".git", "link-payload");
    writeFileSync(payload, MONEY);
    const object = git(root, "hash-object", "-w", payload);
    git(root, "update-index", "--add", "--cacheinfo", `120000,${object},src/link.ts`);
    git(root, "commit", "-q", "-m", "base symlink");
    const base = git(root, "rev-parse", "HEAD");
    git(root, "update-index", "--force-remove", "src/link.ts");
    git(root, "commit", "-q", "-m", "remove symlink");
    indexRepository(root, "2026-10-12T00:00:00.000Z");

    try {
      const result = runVerify(root, { kind: "range", base }).result;
      expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({
        rule: "analysis_scope_incomplete", severity: "block", message: expect.stringContaining("src/link.ts"),
      })]));
      expect(result.findings.map((finding) => finding.rule)).not.toContain("invariant_touched_without_test");
    } catch (error) {
      expect(error).toBeInstanceOf(SemctxError);
      expect((error as SemctxError).code).toBe("GIT_ERROR");
      expect((error as SemctxError).details).toEqual(expect.objectContaining({ path: "src/link.ts", mode: "120000" }));
    }
  });

  (process.platform === "win32" ? it : it.skip)("refuses case-aliased base paths before materialization on Windows", () => {
    const { root } = repository("export const helper = 1;\n");
    git(root, "config", "core.ignorecase", "false");
    const upperPayload = join(root, ".git", "upper-payload");
    const lowerPayload = join(root, ".git", "lower-payload");
    writeFileSync(upperPayload, MONEY);
    writeFileSync(lowerPayload, "export function clamp(x: number) { return x; }\n");
    const upper = git(root, "hash-object", "-w", upperPayload);
    const lower = git(root, "hash-object", "-w", lowerPayload);
    git(root, "update-index", "--add", "--cacheinfo", `100644,${upper},src/ALIAS.ts`);
    git(root, "update-index", "--add", "--cacheinfo", `100644,${lower},src/alias.ts`);
    git(root, "commit", "-q", "-m", "base aliases");
    const base = git(root, "rev-parse", "HEAD");
    expect(git(root, "ls-tree", "--name-only", "-r", base)).toContain("src/ALIAS.ts");
    expect(git(root, "ls-tree", "--name-only", "-r", base)).toContain("src/alias.ts");
    git(root, "update-index", "--force-remove", "src/ALIAS.ts", "src/alias.ts");
    git(root, "commit", "-q", "-m", "remove aliases");
    indexRepository(root, "2026-10-12T00:00:00.000Z");

    let refusal: unknown;
    try { runVerify(root, { kind: "range", base }); }
    catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(SemctxError);
    expect((refusal as SemctxError).code).toBe("GIT_ERROR");
  });
});
