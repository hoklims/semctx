import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkCompatibility, COMPATIBILITY_DOCS, compatibilityBlock } from "../compatibility";
import { runVerification } from "../verify-pr";

const repo = resolve(import.meta.dir, "../..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-compatibility-"));
  roots.push(root);
  for (const file of [...COMPATIBILITY_DOCS, "apps/cli/package.json", ".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(repo, file), join(root, file));
  }
  return root;
}

function replace(root: string, file: string, before: string, after: string): void {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  expect(text).toContain(before);
  writeFileSync(path, text.replace(before, after));
}

function replaceEvery(root: string, file: string, before: string, after: string): void {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  expect(text).toContain(before);
  writeFileSync(path, text.replaceAll(before, after));
}

describe("compatibility declaration gate", () => {
  test("current declarations and workflow pins agree", () => {
    expect(checkCompatibility(repo)).toEqual([]);
    expect(compatibilityBlock()).toContain("Other host versions are **unknown**");
  });
  for (const file of COMPATIBILITY_DOCS) {
    test(`rejects a stale generated release in ${file}`, () => {
      const root = fixture();
      replace(root, file, compatibilityBlock(), compatibilityBlock("0.0.1"));
      expect(checkCompatibility(root).some((error) => error.startsWith(`${file}:`))).toBe(true);
    });
  }
  test("rejects the historical Bun 1.3 typo outside the generated section", () => {
    const root = fixture();
    replace(root, "apps/cli/README.md", "≥ 1.4.0", "≥ 1.3");
    expect(checkCompatibility(root)).toContain("apps/cli/README.md: contradictory Bun requirement 1.3");
  });
  test("changing the package minimum without its consumers fails", () => {
    const root = fixture();
    replace(root, "apps/cli/package.json", '">=1.4.0"', '">=1.5.0"');
    expect(checkCompatibility(root)).toContain(".github/workflows/ci.yml: Bun pin differs from package minimum");
  });
  test("rejects an untested host substituted in actual provisioning", () => {
    const root = fixture();
    replace(root, ".github/workflows/release.yml", '"@openai/codex@0.147.0"', '"@openai/codex@0.1.0"');
    expect(checkCompatibility(root)).toContain(".github/workflows/release.yml: tested host @openai/codex@0.147.0 not provisioned");
  });
  test("a comment mentioning the expected host cannot repair wrong provisioning", () => {
    const root = fixture();
    replace(root, ".github/workflows/release.yml", '"@openai/codex@0.147.0"', '"@openai/codex@0.1.0"');
    replace(root, ".github/workflows/release.yml", "          command -v codex", '          # "@openai/codex@0.147.0"\n          command -v codex');
    expect(checkCompatibility(root)).toContain(".github/workflows/release.yml: tested host @openai/codex@0.147.0 not provisioned");
  });
  test("rejects missing provisioning and duplicated documentation sections", () => {
    const root = fixture();
    replaceEvery(root, ".github/workflows/ci.yml", "oven-sh/setup-bun@", "other/setup-bun@");
    replace(root, "README.md", compatibilityBlock(), `${compatibilityBlock()}\n${compatibilityBlock()}`);
    expect(checkCompatibility(root)).toContain(".github/workflows/ci.yml: Bun provisioning missing");
    expect(checkCompatibility(root).some((error) => error.startsWith("README.md:"))).toBe(true);
  });
  test("the canonical gate stops on a real contradictory document before later gates", async () => {
    const root = fixture();
    replace(root, "README.md", compatibilityBlock(), compatibilityBlock("0.0.1"));
    const invoked: string[][] = [];
    const code = await runVerification({ base: "unused", skipDiff: true }, {
      cwd: root,
      log: () => undefined,
      run: async (argv) => {
        invoked.push(argv);
        return argv[1] === "scripts/compatibility.ts" ? (checkCompatibility(root).length ? 1 : 0) : 0;
      },
    });
    expect(code).toBe(1);
    expect(invoked).toEqual([["bun", "scripts/compatibility.ts"]]);
  });
});
