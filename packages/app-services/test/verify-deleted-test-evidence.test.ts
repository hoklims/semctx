import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig } from "@semantic-context/core";
import { GraphIndex } from "@semantic-context/context-engine";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

const roots: string[] = [];
const SOURCE = "/** @invariant nonnegative: amounts never become negative */\nexport function clamp(x: number) { return x < 0 ? 0 : x; }\n";
const TEST = 'import { expect, test } from "bun:test";\nimport { clamp } from "../src/money";\ntest("clamp", () => expect(clamp(-1)).toBe(0));\n';

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "-c", "commit.gpgsign=false", ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function range(deleteTest: boolean) {
  const root = mkdtempSync(join(tmpdir(), "semctx-deleted-test-evidence-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(join(root, "src/money.ts"), SOURCE);
  writeFileSync(join(root, "src/helper.ts"), "export function helper() { return 1; }\n");
  writeFileSync(join(root, "test/money.test.ts"), TEST);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "guard and covering test");
  initWorkspace(root, createDefaultConfig(root));
  const base = new GraphIndex(indexRepository(root, "2026-10-12T00:00:00.000Z").analysis.graph);
  const guarded = base.nodesOfKind("function").find((node) => node.name === "clamp")!;
  expect(base.outEdges(guarded.id, ["constrained_by"]).length).toBe(1);
  expect(base.outEdges(guarded.id, ["tested_by"]).map((edge) => base.node(edge.to)?.filePath)).toEqual(["test/money.test.ts"]);
  git(root, "checkout", "-q", "-b", "remove");
  git(root, "rm", "-q", "src/money.ts", ...(deleteTest ? ["test/money.test.ts"] : []));
  git(root, "commit", "-q", "-m", "remove guarded source");
  const head = new GraphIndex(indexRepository(root, "2026-10-12T00:01:00.000Z").analysis.graph);
  expect(head.node(guarded.id)).toBeUndefined();
  expect(head.nodesOfKind("test").map((node) => node.filePath)).toEqual(deleteTest ? [] : ["test/money.test.ts"]);
  return runVerify(root, { kind: "range", base: "main" }).result;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("deleted ordinary guard evidence", () => {
  it("blocks deleting a guarded source together with its only covering test", () => {
    const result = range(true);
    expect(result.findings.map((finding) => finding.rule)).toContain("invariant_touched_without_test");
    expect(result.verdict).toBe("BLOCK");
  });

  it("keeps the existing exemption when the former covering test survives at the head", () => {
    const result = range(false);
    expect(result.findings.map((finding) => finding.rule)).not.toContain("invariant_touched_without_test");
    expect(result.verdict).toBe("PASS");
  });
});
