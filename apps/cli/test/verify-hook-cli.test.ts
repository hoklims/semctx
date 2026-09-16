import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureVerificationGitState } from "@semantic-context/app-services";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function semctx(args: string[], cwd: string, stdin?: string): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["bun", "run", CLI, ...args, "--root", cwd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
  });
  return { code: p.exitCode ?? 1, out: new TextDecoder().decode(p.stdout), err: new TextDecoder().decode(p.stderr) };
}

function git(cwd: string, args: string[]): { code: number; err: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: GIT_ENV });
  return { code: p.exitCode ?? 1, err: new TextDecoder().decode(p.stderr) };
}

function gitOutput(cwd: string, args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: GIT_ENV });
  if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr));
  return new TextDecoder().decode(p.stdout).trim();
}

function readState(repo: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repo, ".semctx", "verification-state.json"), "utf8")) as Record<string, unknown>;
}

const INVARIANT = "/**\n * @invariant a-positive: x must stay positive\n */\nexport function compute(x: number): number {\n  return x + 1;\n}\n";
const HELPER = (body: string) => `function helper(x: number): number {\n  return ${body};\n}\nexport const answer = helper(1);\n`;

let repo: string;
let baseCommit: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "semctx-verify-hook-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), INVARIANT);
  writeFileSync(join(repo, "src", "b.ts"), HELPER("x + 1"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "tmp-consumer", version: "0.0.0" }));
  writeFileSync(join(repo, ".gitignore"), ".semctx/\n");
  git(repo, ["init", "-q"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["branch", "-M", "main"]);
  expect(semctx(["init"], repo).code).toBe(0);
  // `init` rewrites .gitignore and adds .semctx/config.json; commit them as a real project does,
  // then bind the index to that HEAD. `--record` refuses non-ignored untracked files by design.
  git(repo, ["add", "-A"]);
  expect(git(repo, ["commit", "-q", "-m", "semctx init"]).code).toBe(0);
  baseCommit = gitOutput(repo, ["rev-parse", "HEAD"]);
  expect(semctx(["index"], repo).code).toBe(0);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("verify hook pre-commit (CLI, real git) — the last job of a project-managed hook chain", () => {
  it("rejects an unknown hook name", () => {
    const r = semctx(["verify", "hook", "post-merge"], repo);
    expect(r.code).toBe(1);
    expect(r.err).toContain("pre-commit or pre-push");
  });

  it("records a proof when none exists", () => {
    const r = semctx(["verify", "hook", "pre-commit"], repo);
    expect(r.code).toBe(0);
    expect(r.out).toContain("NO_PROOF");
    expect(r.out).toContain("recorded verification state ->");
    const state = readState(repo);
    expect(state.version).toBe(3);
    expect(state.verdict).not.toBe("BLOCK");
  });

  it("returns current without re-analysis when nothing drifted, leaving the record byte-identical", () => {
    const before = readFileSync(join(repo, ".semctx", "verification-state.json"));
    const r = semctx(["verify", "hook", "pre-commit"], repo);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no analysis run");
    expect(r.out).not.toContain("recorded verification state ->");
    expect(readFileSync(join(repo, ".semctx", "verification-state.json")).equals(before)).toBe(true);
  });

  it("re-records on drift and binds the record to the staged tree", () => {
    const previous = readState(repo);
    writeFileSync(join(repo, "src", "b.ts"), HELPER("x + 2"));
    git(repo, ["add", "src/b.ts"]);
    const r = semctx(["verify", "hook", "pre-commit"], repo);
    expect(r.code).toBe(0);
    expect(r.out).toContain("PROOF_STALE");
    const state = readState(repo);
    expect(state.recordedAt).not.toBe(previous.recordedAt);
    const current = captureVerificationGitState(repo);
    expect(state.repositoryStateHash).toBe(current.indexStateHash);
    expect(state.contentStateHash).toBe(current.contentStateHash);
  });

  it("refuses a partial index (unstaged edits) before any analysis and leaves the record untouched", () => {
    const before = readFileSync(join(repo, ".semctx", "verification-state.json"));
    writeFileSync(join(repo, "src", "b.ts"), HELPER("x + 3"));
    const r = semctx(["verify", "hook", "pre-commit"], repo);
    expect(r.code).toBe(1);
    expect(r.err).toContain("PARTIAL_INDEX");
    expect(readFileSync(join(repo, ".semctx", "verification-state.json")).equals(before)).toBe(true);
    git(repo, ["checkout", "--", "src/b.ts"]);
  });

  it("refuses non-ignored untracked files exactly like verify diff --record", () => {
    const scratch = join(repo, "notes.txt");
    writeFileSync(scratch, "scratch\n");
    const r = semctx(["verify", "hook", "pre-commit"], repo);
    expect(r.code).toBe(1);
    expect(r.err).toContain("untracked");
    unlinkSync(scratch);
  });
});

describe("verify hook pre-push (CLI, real git) — checks pushed trees, never records", () => {
  let verifiedCommit: string;

  beforeAll(() => {
    // Commit exactly the tree the pre-commit job recorded, then rebind the index to the new HEAD.
    expect(git(repo, ["commit", "-q", "-m", "helper +2"]).code).toBe(0);
    verifiedCommit = gitOutput(repo, ["rev-parse", "HEAD"]);
    expect(semctx(["index"], repo).code).toBe(0);
  });

  it("is current when every pushed commit materializes the recorded state, with or without ref lines", () => {
    const zero = "0".repeat(40);
    const withRefs = semctx(["verify", "hook", "pre-push"], repo, `refs/heads/main ${verifiedCommit} refs/heads/main ${zero}\n`);
    expect(withRefs.code).toBe(0);
    expect(withRefs.out).toContain("refs/heads/main");
    expect(withRefs.out).toContain("no analysis run");

    const headOnly = semctx(["verify", "hook", "pre-push"], repo);
    expect(headOnly.code).toBe(0);
    expect(headOnly.out).toContain("HEAD");
  });

  it("refuses an unproven commit, a deletion, and malformed ref lines", () => {
    const zero = "0".repeat(40);
    const unproven = semctx(["verify", "hook", "pre-push"], repo, `refs/heads/main ${baseCommit} refs/heads/main ${zero}\n`);
    expect(unproven.code).toBe(1);
    expect(unproven.err).toContain("UNPROVEN_REF");
    expect(unproven.err).toContain(baseCommit);

    const deletion = semctx(["verify", "hook", "pre-push"], repo, `(delete) ${zero} refs/heads/old ${verifiedCommit}\n`);
    expect(deletion.code).toBe(1);
    expect(deletion.err).toContain("REF_DELETION");

    const malformed = semctx(["verify", "hook", "pre-push"], repo, "not a ref line\n");
    expect(malformed.code).toBe(1);
    expect(malformed.err).toContain("INVALID_TASK_INPUT");

    // The root tree of the verified commit hashes to the recorded state, but it is not a commit:
    // a hand-written ref line must not pass as one.
    const treeId = gitOutput(repo, ["rev-parse", "HEAD^{tree}"]);
    const tree = semctx(["verify", "hook", "pre-push"], repo, `refs/heads/main ${treeId} refs/heads/main ${zero}\n`);
    expect(tree.code).toBe(1);
    expect(tree.err).toContain("UNPROVEN_REF");
    expect(tree.err).toContain("not a commit");
  });

  it("exits 3 when the pushed tree is covered by a BLOCK record", () => {
    writeFileSync(join(repo, "src", "a.ts"), INVARIANT.replace("x + 1", "x + 2"));
    git(repo, ["add", "src/a.ts"]);
    const preCommit = semctx(["verify", "hook", "pre-commit"], repo);
    expect(preCommit.code).toBe(3);
    expect(readState(repo).verdict).toBe("BLOCK");
    // Simulate a commit that ignored the hook's exit status.
    expect(git(repo, ["commit", "-q", "-m", "invariant touched"]).code).toBe(0);
    const prePush = semctx(["verify", "hook", "pre-push"], repo);
    expect(prePush.code).toBe(3);
    expect(prePush.err).toContain("BLOCK");
    expect(semctx(["index"], repo).code).toBe(0);
  });

  it("refuses when no record exists", () => {
    const statePath = join(repo, ".semctx", "verification-state.json");
    const saved = readFileSync(statePath);
    unlinkSync(statePath);
    const r = semctx(["verify", "hook", "pre-push"], repo);
    expect(r.code).toBe(1);
    expect(r.err).toContain("NO_PROOF");
    writeFileSync(statePath, saved);
  });
});

describe("verify hook inside a real pre-commit hook — after the last writer", () => {
  const hookPath = () => join(repo, ".git", "hooks", "pre-commit");
  const installHook = () => {
    const bun = process.execPath.replaceAll("\\", "/");
    const cli = CLI.replaceAll("\\", "/");
    const root = repo.replaceAll("\\", "/");
    writeFileSync(
      hookPath(),
      [
        "#!/bin/sh",
        "set -e",
        "# writer: a formatter appends a line and restages",
        "printf '// formatted\\n' >> src/b.ts",
        "git add src/b.ts",
        "# semctx last, after the last writer",
        `"${bun}" "${cli}" verify hook pre-commit --root "${root}"`,
        "",
      ].join("\n"),
    );
    chmodSync(hookPath(), 0o755);
  };

  it("records the post-writer tree so the commit and a later pre-push are covered by one proof", () => {
    installHook();
    try {
      writeFileSync(join(repo, "src", "b.ts"), HELPER("x + 4"));
      git(repo, ["add", "src/b.ts"]);
      const headBefore = gitOutput(repo, ["rev-parse", "HEAD"]);
      const commit = git(repo, ["commit", "-q", "-m", "formatted by hook"]);
      expect(commit.code).toBe(0);
      expect(gitOutput(repo, ["rev-parse", "HEAD"])).not.toBe(headBefore);
      expect(readFileSync(join(repo, "src", "b.ts"), "utf8")).toContain("// formatted");

      const committed = captureVerificationGitState(repo);
      const state = readState(repo);
      expect(state.verdict).not.toBe("BLOCK");
      expect(state.repositoryStateHash).toBe(committed.headTreeHash);

      const prePush = semctx(["verify", "hook", "pre-push"], repo);
      expect(prePush.code).toBe(0);
      expect(prePush.out).toContain("no analysis run");
    } finally {
      if (existsSync(hookPath())) unlinkSync(hookPath());
    }
    expect(semctx(["index"], repo).code).toBe(0);
  });

  it("aborts the commit when the post-writer tree is a BLOCK", () => {
    installHook();
    try {
      writeFileSync(join(repo, "src", "a.ts"), INVARIANT.replace("x + 1", "x + 5"));
      git(repo, ["add", "src/a.ts"]);
      const headBefore = gitOutput(repo, ["rev-parse", "HEAD"]);
      const commit = git(repo, ["commit", "-q", "-m", "must not land"]);
      expect(commit.code).not.toBe(0);
      expect(gitOutput(repo, ["rev-parse", "HEAD"])).toBe(headBefore);
      expect(readState(repo).verdict).toBe("BLOCK");
    } finally {
      if (existsSync(hookPath())) unlinkSync(hookPath());
      git(repo, ["checkout", "HEAD", "--", "src/a.ts", "src/b.ts"]);
    }
  });
});
