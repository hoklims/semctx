import { describe, it, expect, beforeAll, afterAll, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
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
    // .gitignore preserved + shareable .semctx policy (config + semantic tracked; #82)
    const gi = readFileSync(join(repo, ".gitignore"), "utf8");
    expect(gi).toContain("node_modules/");
    expect(gi).toContain(".semctx/*");
    expect(gi).toContain("!.semctx/config.json");
    expect(gi).toContain("!.semctx/semantic/");
    expect(gi).not.toMatch(/^\.semctx\/$/m);
    // config is policy-only (no machine absolute root)
    const config = JSON.parse(readFileSync(join(repo, ".semctx", "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(config).not.toHaveProperty("repositoryRoot");
    // the workflow uses least privilege and the safe trigger
    const wf = readFileSync(join(repo, ".github/workflows/semctx.yml"), "utf8");
    expect(wf).toContain("contents: read");
    expect(wf).toContain("uses: hoklims/semctx/packages/github-action@v0.2.0");
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

/**
 * `--root` is the only authority for which repository a call targets. Running from an unrelated
 * directory must reach the named repo and must not treat the caller's cwd as a fallback root (#82).
 */
describe("CLI invoked from a foreign directory", () => {
  let target: string;
  let foreign: string;

  beforeAll(() => {
    target = mkdtempSync(join(tmpdir(), "semctx-target-"));
    foreign = mkdtempSync(join(tmpdir(), "semctx-foreign-"));
    mkdirSync(join(target, "src"), { recursive: true });
    writeFileSync(join(target, "src", "a.ts"), "export function g(x: number): number {\n  return x * 2;\n}\n");
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: "target", version: "0.0.0" }));
    writeFileSync(join(target, ".gitignore"), "node_modules/\n");
    git(target, ["init", "-q"]);
    git(target, ["add", "-A"]);
    git(target, ["commit", "-q", "-m", "init"]);
  });

  afterAll(() => {
    for (const dir of [target, foreign]) rmSync(dir, { recursive: true, force: true });
  });

  function fromForeign(args: string[]): { code: number; out: string; err: string } {
    const p = Bun.spawnSync(["bun", "run", CLI, ...args, "--root", target], {
      cwd: foreign,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: p.exitCode ?? 1,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    };
  }

  it("initializes the repository named by --root, never the caller's cwd", () => {
    const r = fromForeign(["init"]);
    expect(r.code).toBe(0);

    expect(existsSync(join(target, ".semctx", "config.json"))).toBe(true);
    expect(existsSync(join(foreign, ".semctx"))).toBe(false);

    const config = JSON.parse(
      readFileSync(join(target, ".semctx", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(config).not.toHaveProperty("repositoryRoot");
  });

  it("indexes and verifies the --root repository from the foreign cwd", () => {
    expect(fromForeign(["index"]).code).toBe(0);

    const v = fromForeign(["verify", "diff", "--format", "json"]);
    expect(v.code).toBe(0);
    expect(JSON.parse(v.out).verdict).toBe("PASS");
    // Machine state stayed in the target repo.
    expect(existsSync(join(target, ".semctx", "semctx.db"))).toBe(true);
    expect(existsSync(join(foreign, ".semctx"))).toBe(false);
  });
});

// `init --preset` returns before `initWorkspace`, so it carries its own link checks: a checkout that
// ships `.semctx` as a link, or a planted `config.json.tmp` link, must not have the preset config
// written outside the repository (SEC-PB-01).

function probe(create: (probeDir: string) => void): boolean {
  const probeDir = mkdtempSync(join(tmpdir(), "semctx-preset-link-probe-"));
  try {
    create(probeDir);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

function link(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

const linksSupported = probe((probeDir) => link(probeDir, join(probeDir, "self")));
const fileLinksSupported = probe((probeDir) => {
  writeFileSync(join(probeDir, "target"), "");
  symlinkSync(join(probeDir, "target"), join(probeDir, "alias"), "file");
});

const linked = test.skipIf(!linksSupported);
const fileLinked = test.skipIf(!fileLinksSupported);

function presetRepository(): { repo: string; outside: string } {
  const repo = mkdtempSync(join(tmpdir(), "semctx-preset-link-"));
  const outside = mkdtempSync(join(tmpdir(), "semctx-preset-outside-"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0" }));
  git(repo, ["init", "-q"]);
  return { repo, outside };
}

describe("init --preset refuses a linked .semctx", () => {
  linked("a linked .semctx is refused and nothing is written through it", () => {
    const { repo, outside } = presetRepository();
    try {
      link(outside, join(repo, ".semctx"));

      const r = semctx(["init", "--preset", "github-claude"], repo);

      expect(r.code).not.toBe(0);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  fileLinked("a linked .semctx target is refused outright, not skipped as existing", () => {
    const { repo, outside } = presetRepository();
    try {
      mkdirSync(join(repo, ".semctx"));
      writeFileSync(join(outside, "config.json"), "{}\n");
      symlinkSync(join(outside, "config.json"), join(repo, ".semctx", "config.json"), "file");

      // Without --force the old code reported "skip-exists" and exited 0 without looking at the link.
      const r = semctx(["init", "--preset", "github-claude"], repo);

      expect(r.code).not.toBe(0);
      expect(readFileSync(join(outside, "config.json"), "utf8")).toBe("{}\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  fileLinked("a linked host file outside .semctx is skipped when present and refused only when written", () => {
    const { repo, outside } = presetRepository();
    try {
      mkdirSync(join(repo, ".claude"));
      writeFileSync(join(outside, "semctx.md"), "outside\n");
      symlinkSync(join(outside, "semctx.md"), join(repo, ".claude", "semctx.md"), "file");

      const skipped = semctx(["init", "--preset", "github-claude", "--json"], repo);
      expect(skipped.code).toBe(0);
      expect(JSON.parse(skipped.out).files).toContainEqual({ path: ".claude/semctx.md", action: "skip-exists" });

      const forced = semctx(["init", "--preset", "github-claude", "--force"], repo);
      expect(forced.code).not.toBe(0);
      expect(readFileSync(join(outside, "semctx.md"), "utf8")).toBe("outside\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  fileLinked("a planted config.json.tmp link never receives the preset config", () => {
    const { repo, outside } = presetRepository();
    try {
      mkdirSync(join(repo, ".semctx"));
      symlinkSync(join(outside, "config.json"), join(repo, ".semctx", "config.json.tmp"), "file");

      const r = semctx(["init", "--preset", "github-claude"], repo);

      expect(r.code).toBe(0);
      expect(existsSync(join(outside, "config.json"))).toBe(false);
      expect(readFileSync(join(repo, ".semctx", "config.json"), "utf8")).toContain("\"include\"");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
