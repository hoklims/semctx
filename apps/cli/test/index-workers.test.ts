import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../src/index.ts");
const roots: string[] = [];

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-cli-workers-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n");
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2\n");
  writeFileSync(join(root, "package.json"), '{"name":"cli-workers"}\n');
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-q", "-m", "fixture");
  const init = Bun.spawnSync([process.execPath, CLI, "init", "--polyglot", "--root", root], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (init.exitCode !== 0) throw new Error(new TextDecoder().decode(init.stderr));
  return root;
}

function run(root: string, workers: string): { code: number; stdout: string; stderr: string } {
  const child = Bun.spawnSync([
    process.execPath,
    CLI,
    "index",
    "--json",
    "--workers",
    workers,
    "--root",
    root,
  ], { stdout: "pipe", stderr: "pipe" });
  return {
    code: child.exitCode ?? 1,
    stdout: new TextDecoder().decode(child.stdout),
    stderr: new TextDecoder().decode(child.stderr),
  };
}

function runBareWorkers(root: string, command: "index" | "setup"): { code: number; stderr: string } {
  const child = Bun.spawnSync([
    process.execPath,
    CLI,
    command,
    "--workers",
    "--root",
    root,
  ], { stdout: "pipe", stderr: "pipe" });
  return {
    code: child.exitCode ?? 1,
    stderr: new TextDecoder().decode(child.stderr),
  };
}

function runSetup(root: string, workers: string): { code: number; stdout: string; stderr: string } {
  const child = Bun.spawnSync([
    process.execPath,
    CLI,
    "setup",
    "--json",
    "--workers",
    workers,
    "--root",
    root,
  ], { stdout: "pipe", stderr: "pipe" });
  return {
    code: child.exitCode ?? 1,
    stdout: new TextDecoder().decode(child.stdout),
    stderr: new TextDecoder().decode(child.stderr),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("semctx index --workers", () => {
  test("reports selected parallelism outside the freshness seal", () => {
    const result = run(repository(), "2");
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output["parallelism"]).toMatchObject({ requested: 2, used: 2, mode: "parallel" });
    expect(output["freshnessSeal"]).not.toHaveProperty("parallelism");
  });

  test("rejects worker counts outside 1 through 8 before indexing", () => {
    const result = run(repository(), "9");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--workers must be auto or an integer from 1 through 8");
  });

  test.each(["index", "setup"] as const)("rejects a bare --workers flag for %s", (command) => {
    const result = runBareWorkers(repository(), command);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--workers requires auto or an integer from 1 through 8");
  });

  test("routes actual setup through the async worker path and reports telemetry", () => {
    const result = runSetup(repository(), "2");
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output["parallelism"]).toMatchObject({ requested: 2, used: 2, mode: "parallel" });
    expect(output["freshnessSeal"]).not.toHaveProperty("parallelism");
  });
});
