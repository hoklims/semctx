import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entrypoint = resolve(import.meta.dir, "../src/index.ts");
const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-cli-setup-plan-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "value.ts"), "export const value = 1;\n", "utf8");
  return root;
}

function run(root: string): { code: number; body: Record<string, unknown>; err: string } {
  const process = Bun.spawnSync(
    ["bun", entrypoint, "setup", "--root", root, "--dry-run", "--json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = new TextDecoder().decode(process.stdout);
  return {
    code: process.exitCode,
    body: JSON.parse(out) as Record<string, unknown>,
    err: new TextDecoder().decode(process.stderr),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("semctx setup --dry-run --json", () => {
  test("emits a read-only plan and preserves unknown runtime outcomes", () => {
    const root = freshRoot();
    const result = run(root);

    expect(result.code, result.err).toBe(0);
    expect(result.body.kind).toBe("setup_plan");
    expect(result.body.verdict).toBe("SETUP_PLANNED");
    expect(result.body.analysisReady).toBe("unknown");
    expect(result.body.setupReady).toBe("unknown");
    expect(result.body.plannedChanges).toContain(".semctx/config.json");
    expect(result.body.index).toEqual({ status: "not-run", reason: "dry-run" });
    expect(existsSync(join(root, ".semctx"))).toBe(false);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  test("returns a structured conflict for malformed config without repairing it", () => {
    const root = freshRoot();
    mkdirSync(join(root, ".semctx"), { recursive: true });
    const config = join(root, ".semctx", "config.json");
    writeFileSync(config, "{broken", "utf8");
    const result = run(root);

    expect(result.code).toBe(1);
    expect(result.body.kind).toBe("setup_conflict");
    expect(result.body.conflict).toMatchObject({ code: "CONFIG_INVALID" });
    expect(result.body.index).toEqual({ status: "not-run", reason: "workspace-conflict" });
    expect(readFileSync(config, "utf8")).toBe("{broken");
    expect(existsSync(join(root, ".semctx", "semctx.db"))).toBe(false);
  });
});
