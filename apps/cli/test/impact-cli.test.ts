import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeImpactReportSchema } from "@semantic-context/core";

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
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: GIT_ENV });
  if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr));
}

const A = "export function compute(x: number): number {\n  return x + 1;\n}\n";
const B = 'import { compute } from "./a";\n\nexport function twice(x: number): number {\n  return compute(compute(x));\n}\n';

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "semctx-impact-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), A);
  writeFileSync(join(repo, "src", "b.ts"), B);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "tmp-impact", version: "0.0.0" }));
  writeFileSync(join(repo, ".gitignore"), ".semctx/\nimpact.json\n");
  git(repo, ["init", "-q"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["branch", "-M", "main"]);
  semctx(["init"], repo);
  semctx(["index"], repo);
  writeFileSync(join(repo, "src", "a.ts"), A.replace("x + 1", "x + 2"));
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("impact diff (CLI, real git)", () => {
  it("emits the versioned ChangeImpact contract and exits 0", () => {
    const r = semctx(["impact", "diff", "--format", "json"], repo);
    expect(r.code).toBe(0);
    const report = ChangeImpactReportSchema.parse(JSON.parse(r.out));
    expect(report.kind).toBe("change_impact");
    // `semctx init` left .gitignore dirty before indexing: that file is joined on its new side,
    // the edited source on its committed side.
    expect(report.analysis.binding).toMatchObject({ status: "bound", rangeSide: "mixed" });
    expect(report.changes.units!.map((unit) => [unit.id, unit.side])).toEqual([["sym:function:src/a.ts:compute", "old"]]);
    expect(report.directlyAffected!.map((target) => target.id)).toEqual(["sym:function:src/b.ts:twice"]);
  });

  it("writes the same report atomically with --output", () => {
    const r = semctx(["impact", "diff", "--json", "--output", "impact.json"], repo);
    expect(r.code).toBe(0);
    expect(existsSync(join(repo, "impact.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(repo, "impact.json"), "utf8"))).toEqual(JSON.parse(r.out));
  });

  it("renders text that never presents absence as safety", () => {
    const r = semctx(["impact", "diff"], repo);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Directly affected (1)");
    expect(r.out).toContain("Nothing absent from these tiers is shown to be unaffected");
    expect(r.out).not.toMatch(/\b(PASS|BLOCK)\b/);
  });

  it("refuses inputs it cannot bind to the index", () => {
    expect(semctx(["impact", "diff", "--from-file", "x.diff"], repo).code).toBe(1);
    expect(semctx(["impact", "diff", "--base", "main", "--staged"], repo).code).toBe(1);
    expect(semctx(["impact", "diff", "--format", "github"], repo).code).toBe(1);
    expect(semctx(["impact", "nope"], repo).code).toBe(2);
  });
});
