import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

/**
 * A PR is checked as a committed range against its base, with the index built at the PR head. What
 * the PR removes is therefore absent from the indexed graph, so every guard it deletes, strips or
 * moves has to be recovered from the base commit instead. Each case below is the same change a
 * working-tree check already refuses; a range check must not be the easier path.
 */

const roots: string[] = [];

const MONEY = [
  "/**",
  " * @invariant money-never-negative: amounts must never be negative",
  " */",
  "export function clamp(x: number): number {",
  "  return x < 0 ? 0 : x;",
  "}",
  "",
].join("\n");

const CART = [
  "export interface CartTotal {",
  "  subtotalCents: number;",
  "  taxCents: number;",
  "}",
  "",
].join("\n");

const HELPER = "export function helper(x: number): number {\n  return x + 1;\n}\n";

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "-c", "commit.gpgsign=false", ...args],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** `main` holds a guarded function, an exported interface and an unguarded helper, all untested. */
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-removed-guards-"));
  roots.push(root);
  write(root, ".gitignore", ".semctx/\n");
  write(root, "src/money.ts", MONEY);
  write(root, "src/cart.ts", CART);
  write(root, "src/helper.ts", HELPER);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  initWorkspace(root, createDefaultConfig(root));
  return root;
}

/** Commit `edit` on a PR branch, index its head, and verify the range against `main`. */
function verifyPullRequest(edit: (root: string) => void) {
  const root = repository();
  git(root, "checkout", "-q", "-b", "pr");
  edit(root);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "pr");
  indexRepository(root, "2026-10-11T10:00:00.000Z");
  return runVerify(root, { kind: "range", base: "main" }).result;
}

const rulesOf = (result: ReturnType<typeof verifyPullRequest>): string[] => result.findings.map((finding) => finding.rule);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a diff with no content hunks", () => {
  it("names the renamed paths as not compared instead of claiming nothing changed", () => {
    const result = verifyPullRequest((root) => git(root, "mv", "src/cart.ts", "src/cart2.ts"));
    const unknowns = result.unknowns.join("\n");
    expect(unknowns).not.toContain("No changes detected");
    expect(unknowns).toContain("no content hunks");
    expect(unknowns).toContain("src/cart.ts");
  });
});

describe("a pull request that removes a guard", () => {
  it("blocks deleting the file that holds an untested @invariant", () => {
    const result = verifyPullRequest((root) => git(root, "rm", "-q", "src/money.ts"));
    expect(rulesOf(result)).toContain("invariant_touched_without_test");
    expect(result.verdict).toBe("BLOCK");
  });

  it("warns on deleting an exported interface that no test covers", () => {
    const result = verifyPullRequest((root) => write(root, "src/cart.ts", ""));
    expect(rulesOf(result)).toContain("contract_changed_without_test");
    expect(result.verdict).toBe("WARN");
  });

  it("warns on a pure rename of a file that exports an uncovered interface, and does not claim nothing changed", () => {
    const result = verifyPullRequest((root) => git(root, "mv", "src/cart.ts", "src/cart2.ts"));
    expect(rulesOf(result)).toContain("contract_changed_without_test");
    expect(result.verdict).toBe("WARN");
    expect(result.unknowns.join("\n")).not.toContain("No changes detected");
  });

  it("blocks stripping only the invariant marker without changing the declaration", () => {
    const result = verifyPullRequest((root) => write(root, "src/money.ts", MONEY.replace(" * @invariant money-never-negative: amounts must never be negative\n", "")));
    expect(rulesOf(result)).toContain("invariant_touched_without_test");
    expect(result.verdict).toBe("BLOCK");
  });

  it("blocks stripping only a security marker without changing the declaration", () => {
    const root = repository();
    write(root, "src/money.ts", MONEY.replace("@invariant money-never-negative: amounts must never be negative", "@tag security"));
    git(root, "add", "src/money.ts");
    git(root, "commit", "-q", "-m", "security base");
    git(root, "checkout", "-q", "-b", "pr");
    write(root, "src/money.ts", MONEY.replace(" * @invariant money-never-negative: amounts must never be negative\n", ""));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "remove security");
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const result = runVerify(root, { kind: "range", base: "main" }).result;
    expect(rulesOf(result)).toContain("security_surface_without_verification");
    expect(result.verdict).toBe("BLOCK");
  });

  it("blocks stripping the @invariant marker while changing the body", () => {
    const result = verifyPullRequest((root) =>
      write(root, "src/money.ts", "export function clamp(x: number): number {\n  return x;\n}\n"));
    expect(rulesOf(result)).toContain("invariant_touched_without_test");
    expect(result.verdict).toBe("BLOCK");
  });
});

describe("a pull request that must keep passing", () => {
  it("still blocks a body change under a surviving @invariant", () => {
    const result = verifyPullRequest((root) => write(root, "src/money.ts", MONEY.replace("? 0 : x", "? 1 : x")));
    expect(result.verdict).toBe("BLOCK");
  });

  it("passes deleting an unguarded function that is not an exported contract", () => {
    const result = verifyPullRequest((root) => git(root, "rm", "-q", "src/helper.ts"));
    expect(result.verdict).toBe("PASS");
  });

  it("passes changing a guarded body when the same PR adds a test that imports it", () => {
    const result = verifyPullRequest((root) => {
      write(root, "src/money.ts", MONEY.replace("? 0 : x", "? 1 : x"));
      write(
        root,
        "test/money.test.ts",
        'import { expect, test } from "bun:test";\nimport { clamp } from "../src/money";\ntest("clamp", () => expect(clamp(-1)).toBe(1));\n',
      );
    });
    expect(result.verdict).toBe("PASS");
  });

  it("passes a pure addition", () => {
    const result = verifyPullRequest((root) => write(root, "src/extra.ts", "export function extra(): number {\n  return 3;\n}\n"));
    expect(result.verdict).toBe("PASS");
  });
});
