import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function run(root: string, extraArgs: string[] = ["--dry-run"]): { code: number; body: Record<string, unknown>; err: string } {
  const process = Bun.spawnSync(
    ["bun", entrypoint, "setup", "--root", root, ...extraArgs, "--json"],
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

  test("preset preflight keeps malformed config inside the structured conflict envelope", () => {
    const root = freshRoot();
    mkdirSync(join(root, ".semctx"), { recursive: true });
    const config = join(root, ".semctx", "config.json");
    writeFileSync(config, "{broken", "utf8");
    const result = run(root, ["--dry-run", "--preset", "github-claude"]);

    expect(result.code).toBe(1);
    expect(result.body).toMatchObject({
      kind: "setup_conflict",
      preset: "github-claude",
      conflict: { code: "CONFIG_INVALID" },
    });
    expect(readFileSync(config, "utf8")).toBe("{broken");
    expect(existsSync(join(root, ".github"))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
  });

  test("rejects a linked SQLite sidecar before reporting a valid setup plan", () => {
    const root = freshRoot();
    const outside = freshRoot();
    mkdirSync(join(root, ".semctx"), { recursive: true });
    symlinkSync(outside, join(root, ".semctx", "semctx.db-wal"), process.platform === "win32" ? "junction" : "dir");
    const result = run(root);

    expect(result.code).toBe(1);
    expect(result.body).toMatchObject({
      kind: "setup_conflict",
      conflict: { code: "CONFIG_INVALID" },
    });
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  test("real preset setup rejects a linked sidecar before writing host or workspace files", () => {
    const root = freshRoot();
    const outside = freshRoot();
    mkdirSync(join(root, ".semctx"), { recursive: true });
    symlinkSync(outside, join(root, ".semctx", "semctx.db-wal"), process.platform === "win32" ? "junction" : "dir");
    const result = run(root, ["--preset", "github-claude"]);

    expect(result.code).toBe(1);
    expect(result.body).toMatchObject({
      kind: "setup_conflict",
      preset: "github-claude",
      conflict: { code: "CONFIG_INVALID" },
    });
    expect(existsSync(join(root, ".github"))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
    expect(existsSync(join(root, ".semctx", "config.json"))).toBe(false);
    expect(existsSync(join(root, ".semctx", "semantic"))).toBe(false);
    expect(existsSync(join(outside, "semctx.yml"))).toBe(false);
  });

  test("real forced preset validates every target type before writing the earlier target", () => {
    const root = freshRoot();
    mkdirSync(join(root, ".claude", "semctx.md"), { recursive: true });
    const result = run(root, ["--preset", "github-claude", "--force"]);

    expect(result.code).toBe(1);
    expect(result.body).toMatchObject({
      kind: "setup_conflict",
      preset: "github-claude",
      conflict: { code: "CONFIG_INVALID", details: { path: join(root, ".claude", "semctx.md") } },
    });
    expect(existsSync(join(root, ".github"))).toBe(false);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
    expect(existsSync(join(root, ".semctx"))).toBe(false);
  });

  test("directory .gitignore is normalized into a structured setup conflict", () => {
    const root = freshRoot();
    mkdirSync(join(root, ".gitignore"));
    const result = run(root);

    expect(result.code).toBe(1);
    expect(result.body).toMatchObject({
      kind: "setup_conflict",
      conflict: {
        code: "CONFIG_INVALID",
        message: ".gitignore must be a regular file",
        details: { path: join(root, ".gitignore") },
      },
    });
    expect(existsSync(join(root, ".semctx"))).toBe(false);
  });

  test("regular-file .semctx is normalized before any child-path inspection", () => {
    const root = freshRoot();
    writeFileSync(join(root, ".semctx"), "not a directory\n", "utf8");
    const result = run(root);

    expect(result.code).toBe(1);
    expect(result.body).toMatchObject({
      kind: "setup_conflict",
      conflict: {
        code: "CONFIG_INVALID",
        message: "workspace entry must be a directory",
        details: { path: join(root, ".semctx"), expected: "directory" },
      },
    });
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  test("real preset setup rejects a regular-file semantic directory before all writes", () => {
    const root = freshRoot();
    mkdirSync(join(root, ".semctx"));
    writeFileSync(join(root, ".semctx", "semantic"), "not a directory\n", "utf8");
    const result = run(root, ["--preset", "github-claude"]);

    expect(result.code).toBe(1);
    expect(result.body).toMatchObject({
      kind: "setup_conflict",
      conflict: { code: "CONFIG_INVALID", details: { path: join(root, ".semctx", "semantic") } },
    });
    expect(existsSync(join(root, ".semctx", "config.json"))).toBe(false);
    expect(existsSync(join(root, ".github"))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  test("real preset setup rejects a directory scaffold target before all writes", () => {
    const root = freshRoot();
    mkdirSync(join(root, ".semctx", "semantic", "goals.sem"), { recursive: true });
    const result = run(root, ["--preset", "github-claude"]);

    expect(result.code).toBe(1);
    expect(result.body).toMatchObject({
      kind: "setup_conflict",
      conflict: { code: "CONFIG_INVALID", details: { path: join(root, ".semctx", "semantic", "goals.sem") } },
    });
    expect(existsSync(join(root, ".semctx", "config.json"))).toBe(false);
    expect(existsSync(join(root, ".github"))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  test("real preset setup rejects a custom authored semantic symlink before all writes", () => {
    const root = freshRoot();
    const outside = freshRoot();
    mkdirSync(join(root, ".semctx", "semantic", "changes"), { recursive: true });
    symlinkSync(outside, join(root, ".semctx", "semantic", "changes", "custom.sem"), process.platform === "win32" ? "junction" : "dir");
    const result = run(root, ["--preset", "github-claude"]);

    expect(result.code).toBe(1);
    expect(result.body).toMatchObject({
      kind: "setup_conflict",
      conflict: { code: "CONFIG_INVALID", details: { file: join(root, ".semctx", "semantic", "changes", "custom.sem") } },
    });
    expect(existsSync(join(root, ".semctx", "config.json"))).toBe(false);
    expect(existsSync(join(root, ".github"))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  test("real preset setup rejects authored semantic syntax errors before all writes", () => {
    const root = freshRoot();
    mkdirSync(join(root, ".semctx", "semantic", "changes"), { recursive: true });
    const authored = join(root, ".semctx", "semantic", "changes", "custom.sem");
    writeFileSync(authored, "not-a-semantic-block value\n", "utf8");
    const result = run(root, ["--preset", "github-claude"]);

    expect(result.code).toBe(1);
    expect(result.body).toMatchObject({
      kind: "setup_conflict",
      conflict: {
        code: "CONFIG_INVALID",
        message: "semantic model contains syntax errors",
        details: { diagnostics: [expect.objectContaining({ file: ".semctx/semantic/changes/custom.sem" })] },
      },
    });
    expect(readFileSync(authored, "utf8")).toBe("not-a-semantic-block value\n");
    expect(existsSync(join(root, ".semctx", "config.json"))).toBe(false);
    expect(existsSync(join(root, ".semctx", "semantic", "goals.sem"))).toBe(false);
    expect(existsSync(join(root, ".semctx", "semctx.db"))).toBe(false);
    expect(existsSync(join(root, ".github"))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  test("skipped preset target under a linked ancestor blocks the whole mixed plan", () => {
    const root = freshRoot();
    const outside = freshRoot();
    writeFileSync(join(outside, "semctx.md"), "outside\n", "utf8");
    symlinkSync(outside, join(root, ".claude"), process.platform === "win32" ? "junction" : "dir");
    const result = run(root, ["--preset", "github-claude"]);

    expect(result.code).toBe(1);
    expect(result.body).toMatchObject({
      kind: "setup_conflict",
      preset: "github-claude",
      conflict: { code: "CONFIG_INVALID" },
    });
    expect(readFileSync(join(outside, "semctx.md"), "utf8")).toBe("outside\n");
    expect(existsSync(join(root, ".github"))).toBe(false);
    expect(existsSync(join(root, ".semctx"))).toBe(false);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  test("rejects a linked preset ancestor before any workspace or outside write", () => {
    const root = freshRoot();
    const outside = freshRoot();
    symlinkSync(outside, join(root, ".github"), process.platform === "win32" ? "junction" : "dir");
    const result = run(root, ["--dry-run", "--preset", "github-claude"]);

    expect(result.code).toBe(1);
    expect(result.body).toMatchObject({
      kind: "setup_conflict",
      preset: "github-claude",
      conflict: { code: "CONFIG_INVALID" },
    });
    expect(existsSync(join(root, ".semctx"))).toBe(false);
    expect(existsSync(join(outside, "workflows", "semctx.yml"))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
  });

  test("preset dry-run includes every host file real setup writes and remains read-only", () => {
    const root = freshRoot();
    const result = run(root, ["--dry-run", "--preset", "github-claude"]);

    expect(result.code, result.err).toBe(0);
    expect(result.body.kind).toBe("setup_plan");
    expect(result.body.plannedChanges).toEqual(expect.arrayContaining([
      ".semctx/config.json",
      ".github/workflows/semctx.yml",
      ".claude/semctx.md",
      ".gitignore",
    ]));
    expect(result.body.presetPlan).toMatchObject({
      preset: "github-claude",
      files: [
        { path: ".github/workflows/semctx.yml", action: "create" },
        { path: ".claude/semctx.md", action: "create" },
      ],
    });
    expect(existsSync(join(root, ".semctx"))).toBe(false);
    expect(existsSync(join(root, ".github"))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);

    const applied = run(root, ["--preset", "github-claude"]);
    expect(applied.code).toBe(1); // no Git seal: files are written, analysis remains not ready
    expect(existsSync(join(root, ".github", "workflows", "semctx.yml"))).toBe(true);
    expect(existsSync(join(root, ".claude", "semctx.md"))).toBe(true);
    expect(readFileSync(join(root, ".github", "workflows", "semctx.yml"), "utf8")).toContain("github-action@v0.3.5");
  });
});
