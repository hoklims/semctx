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
function git(cwd: string, args: string[]): number {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: GIT_ENV });
  return p.exitCode ?? 1;
}

const A_MAIN = `/**\n * @invariant a-positive: x must stay positive\n */\nexport function compute(x: number): number {\n  return x + 1;\n}\nexport interface PublicPort {\n  run(): void;\n}\n`;
const A_FEATURE = `/**\n * @invariant a-positive: x must stay positive\n */\nexport function compute(x: number): number {\n  return x + 2;\n}\nexport interface PublicPort {\n  run(): void;\n}\n`;

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "semctx-verify-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), A_MAIN);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "tmp-consumer", version: "0.0.0" }));
  writeFileSync(join(repo, ".gitignore"), ".semctx/\nreport.json\ndryrun.json\n");
  git(repo, ["init", "-q"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["branch", "-M", "main"]);
  // index the main state (compute is invariant-constrained and untested)
  semctx(["init"], repo);
  semctx(["index"], repo);
  // a feature branch that changes the invariant-constrained function body
  git(repo, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(repo, "src", "a.ts"), A_FEATURE);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "change compute"]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("verify diff --base (CLI, real git)", () => {
  it("errors cleanly when the base ref is unavailable (no implicit fetch)", () => {
    const r = semctx(["verify", "diff", "--base", "origin/does-not-exist"], repo);
    expect(r.code).not.toBe(0);
    expect(r.err + r.out).toContain("not available locally");
  });

  it("computes the merge-base range and emits the stable JSON contract", () => {
    const r = semctx(["verify", "diff", "--base", "main", "--format", "json"], repo);
    const report = JSON.parse(r.out);
    expect(report.schemaVersion).toBe(1);
    expect(report.base).toBe("main");
    expect(report.head).toBe("HEAD");
    expect(report.mergeBase).toMatch(/^[0-9a-f]{40}$/);
    expect(report.range).toMatch(/^[0-9a-f]{12}\.\.[0-9a-f]{12}$/);
    expect(report.changedFiles).toContain("src/a.ts");
    // compute is invariant-constrained and has no test → strict BLOCK
    expect(report.verdict).toBe("BLOCK");
    expect(report.findings.some((f: { rule: string }) => f.rule === "invariant_touched_without_test")).toBe(true);
    expect(r.code).toBe(3); // default --fail-on block
  });

  it("BLOCK exits 0 with --fail-on none, non-zero with the default", () => {
    expect(semctx(["verify", "diff", "--base", "main", "--fail-on", "none"], repo).code).toBe(0);
    expect(semctx(["verify", "diff", "--base", "main", "--fail-on", "block"], repo).code).toBe(3);
  });

  it("writes the JSON report atomically to --output (no leftover .tmp)", () => {
    const out = join(repo, "report.json");
    semctx(["verify", "diff", "--base", "main", "--format", "text", "--output", out, "--fail-on", "none"], repo);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(`${out}.tmp`)).toBe(false);
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.schemaVersion).toBe(1);
    expect(report.verdict).toBe("BLOCK");
  });

  it("--dry-run shows the resolved range and writes nothing", () => {
    const out = join(repo, "dryrun.json");
    const r = semctx(["verify", "diff", "--base", "main", "--dry-run", "--output", out], repo);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Dry run");
    expect(r.out).toContain("main");
    expect(existsSync(out)).toBe(false);
  });

  it("github format emits workflow annotations and a verdict notice", () => {
    const r = semctx(["verify", "diff", "--base", "main", "--format", "github", "--fail-on", "none"], repo);
    expect(r.out).toMatch(/^::error /m);
    expect(r.out).toContain("::notice::semctx verdict BLOCK");
  });

  it("rejects an invalid --format and --fail-on", () => {
    expect(semctx(["verify", "diff", "--base", "main", "--format", "xml"], repo).code).not.toBe(0);
    expect(semctx(["verify", "diff", "--base", "main", "--fail-on", "maybe"], repo).code).not.toBe(0);
  });

  it("--record writes a verification state with a diff hash and verdict (guarded-mode input)", () => {
    const r = semctx(["verify", "diff", "--record", "--fail-on", "none"], repo);
    expect(r.code).toBe(0);
    const statePath = join(repo, ".semctx", "verification-state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.diffHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(["PASS", "WARN", "BLOCK"]).toContain(state.verdict);
  });
});

describe("verify diff co-change signal (CLI, real git history)", () => {
  let coRepo: string;

  beforeAll(() => {
    coRepo = mkdtempSync(join(tmpdir(), "semctx-cochange-"));
    mkdirSync(join(coRepo, "src"), { recursive: true });
    writeFileSync(join(coRepo, "package.json"), JSON.stringify({ name: "tmp-cochange", version: "0.0.0" }));
    writeFileSync(join(coRepo, ".gitignore"), ".semctx/\n");
    git(coRepo, ["init", "-q"]);
    git(coRepo, ["branch", "-M", "main"]);
    const w = (name: string, v: number) => writeFileSync(join(coRepo, "src", name), `export const ${name.replace(".ts", "")} = ${v};\n`);
    // c1 & c2: a.ts and b.ts change together (support 2). c3: a.ts and c.ts together (support 1).
    w("a.ts", 1); w("b.ts", 1); git(coRepo, ["add", "-A"]); git(coRepo, ["commit", "-q", "-m", "c1"]);
    w("a.ts", 2); w("b.ts", 2); git(coRepo, ["add", "-A"]); git(coRepo, ["commit", "-q", "-m", "c2"]);
    w("a.ts", 3); w("c.ts", 1); git(coRepo, ["add", "-A"]); git(coRepo, ["commit", "-q", "-m", "c3"]);
    semctx(["init"], coRepo);
    semctx(["index"], coRepo);
    w("a.ts", 4); // uncommitted working-tree change
  });

  afterAll(() => {
    rmSync(coRepo, { recursive: true, force: true });
  });

  it("reports files historically co-changed with a changed file, above minSupport only", () => {
    const r = semctx(["verify", "diff", "--format", "json", "--fail-on", "none"], coRepo);
    const report = JSON.parse(r.out);
    const entry = report.coChangedFiles?.find((c: { file: string }) => c.file === "src/a.ts");
    expect(entry).toBeDefined();
    const files = entry.coChanged.map((x: { file: string }) => x.file);
    expect(files).toContain("src/b.ts"); // co-changed in c1 and c2 → support 2
    expect(files).not.toContain("src/c.ts"); // co-changed only in c3 → support 1 < 2
  });

  it("emits no co-change field when the diff is empty (nothing changed)", () => {
    git(coRepo, ["stash", "-q"]); // clean the working tree
    const r = semctx(["verify", "diff", "--format", "json", "--fail-on", "none"], coRepo);
    git(coRepo, ["stash", "pop", "-q"]);
    const report = JSON.parse(r.out);
    expect("coChangedFiles" in report).toBe(false);
  });
});
