import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function semctx(args: string[], cwd: string): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["bun", "run", CLI, ...args, "--root", cwd], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: new TextDecoder().decode(p.stdout), err: new TextDecoder().decode(p.stderr) };
}
function git(cwd: string, args: string[]): void {
  Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: GIT_ENV });
}

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "semctx-preset-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export function f(x: number): number {\n  return x + 1;\n}\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0" }));
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  git(repo, ["init", "-q"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

const PRESET_FILES = [".semctx/config.json", ".github/workflows/semctx.yml", ".claude/semctx.md"];

describe("init --preset github-claude", () => {
  it("dry-run previews the files and writes nothing", () => {
    const r = semctx(["init", "--preset", "github-claude", "--dry-run", "--json"], repo);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.dryRun).toBe(true);
    expect(out.files.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(PRESET_FILES));
    expect(out.files.every((f: { action: string }) => f.action === "create")).toBe(true);
    // nothing written
    for (const f of PRESET_FILES) expect(existsSync(join(repo, f))).toBe(false);
  });

  it("applies the preset, creating the expected files and updating .gitignore", () => {
    const r = semctx(["init", "--preset", "github-claude"], repo);
    expect(r.code).toBe(0);
    for (const f of PRESET_FILES) expect(existsSync(join(repo, f))).toBe(true);
    // devcontainer is opt-in — not created by default
    expect(existsSync(join(repo, ".devcontainer/devcontainer.json"))).toBe(false);
    // .gitignore preserved + .semctx appended
    const gi = readFileSync(join(repo, ".gitignore"), "utf8");
    expect(gi).toContain("node_modules/");
    expect(gi).toMatch(/^\.semctx\/$/m);
    // the workflow uses least privilege and the safe trigger
    const wf = readFileSync(join(repo, ".github/workflows/semctx.yml"), "utf8");
    expect(wf).toContain("contents: read");
    expect(wf).not.toContain("pull_request_target");
  });

  it("never overwrites existing files without --force", () => {
    const r = semctx(["init", "--preset", "github-claude", "--json"], repo);
    const out = JSON.parse(r.out);
    for (const f of out.files) expect(f.action).toBe("skip-exists");
  });

  it("--force overwrites and --with-devcontainer adds the devcontainer", () => {
    const r = semctx(["init", "--preset", "github-claude", "--with-devcontainer", "--force", "--json"], repo);
    const out = JSON.parse(r.out);
    expect(out.files.some((f: { path: string; action: string }) => f.path === ".devcontainer/devcontainer.json")).toBe(true);
    expect(existsSync(join(repo, ".devcontainer/devcontainer.json"))).toBe(true);
    expect(out.files.filter((f: { path: string }) => f.path === ".semctx/config.json")[0].action).toBe("overwrite");
  });

  it("the bootstrapped repo indexes and verifies", () => {
    expect(semctx(["index"], repo).code).toBe(0);
    // no working-tree change → PASS, exit 0
    const v = semctx(["verify", "diff", "--format", "json"], repo);
    expect(v.code).toBe(0);
    expect(JSON.parse(v.out).verdict).toBe("PASS");
  });

  it("rejects an unknown preset", () => {
    const r = semctx(["init", "--preset", "nope"], repo);
    expect(r.code).not.toBe(0);
    expect(r.err + r.out).toContain("unknown preset");
  });
});
