import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, SemctxError, type SemctxConfigV2 } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import {
  __setIndexRepositoryCaptureBarrierForTesting,
  indexRepositoryAsync,
} from "../src/indexing";

const roots: string[] = [];
const CAPTURED_AT = "2026-08-25T12:00:00.000Z";

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-parallel-index-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export function a() { return 1 }\n");
  writeFileSync(join(root, "src", "b.ts"), "import { a } from './a'; export function b() { return a() }\n");
  writeFileSync(join(root, "package.json"), '{"name":"parallel-fixture"}\n');
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-q", "-m", "fixture");
  const config: SemctxConfigV2 = { ...createGlobSelectionConfig(root), include: ["src/**/*.ts"] };
  initWorkspace(root, config);
  return root;
}

afterEach(() => {
  __setIndexRepositoryCaptureBarrierForTesting(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worker-backed repository indexing", () => {
  test("workers 1 and 2 persist identical facts, claims, and freshness seal", async () => {
    const root = repository();
    const one = await indexRepositoryAsync(root, CAPTURED_AT, 1);
    const two = await indexRepositoryAsync(root, CAPTURED_AT, 2);

    expect(one.parallelism).toMatchObject({ used: 1, mode: "single" });
    expect(two.parallelism).toMatchObject({ used: 2, mode: "parallel" });
    expect(two.analysis).toEqual(one.analysis);
    expect(two.claims).toEqual(one.claims);
    expect(two.freshnessSeal).toEqual(one.freshnessSeal);
  });

  test("keeps the TOCTOU barrier ahead of SQLite replacement on the async path", async () => {
    const root = repository();
    __setIndexRepositoryCaptureBarrierForTesting(() => {
      writeFileSync(join(root, "src", "a.ts"), "export function a() { return 2 }\n");
    });

    let thrown: unknown;
    try {
      await indexRepositoryAsync(root, CAPTURED_AT, 2);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SemctxError);
    expect(thrown).toMatchObject({ code: "GIT_ERROR" });
  });
});
