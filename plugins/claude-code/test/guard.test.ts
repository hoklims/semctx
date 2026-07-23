import { describe, it, expect } from "bun:test";
// The guard ships as runnable Node ESM (it runs on machines without Bun). bun:test imports it
// directly; main() is guarded by an argv check so importing does not execute it.
import {
  captureVerificationGitState,
  isTerminalGitCommand,
  guardEnabled,
  guardDecision,
  resolveGitCwd,
} from "../hooks/semctx-guard.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { captureVerificationGitState as captureApplicationVerificationGitState } from "@semantic-context/app-services";

describe("isTerminalGitCommand — structural detection (no shell eval)", () => {
  it("detects commit and push, including global options and env assignments", () => {
    expect(isTerminalGitCommand("git commit -m 'x'")).toBe("commit");
    expect(isTerminalGitCommand("git push origin main")).toBe("push");
    expect(isTerminalGitCommand("git -C sub commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("git -c user.name=x commit")).toBe("commit");
    expect(isTerminalGitCommand("cd repo && git commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("GIT_AUTHOR_NAME=x git commit")).toBe("commit");
    expect(isTerminalGitCommand("git add -A && git commit -m x")).toBe("commit");
  });

  it("detects common wrapper, quoted, absolute-path, and shell -c shapes", () => {
    expect(isTerminalGitCommand("/usr/bin/git commit -m x")).toBe("commit");
    expect(isTerminalGitCommand('"git" push origin main')).toBe("push");
    expect(isTerminalGitCommand("command git commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("bash -c 'git push origin main'")).toBe("push");
  });

  it("does not fire on non-terminal or look-alike commands", () => {
    expect(isTerminalGitCommand("git status")).toBeNull();
    expect(isTerminalGitCommand("git log --grep=commit")).toBeNull();
    expect(isTerminalGitCommand("git add -A")).toBeNull();
    expect(isTerminalGitCommand("echo git commit")).toBeNull();
    expect(isTerminalGitCommand("gitfoo commit")).toBeNull();
    expect(isTerminalGitCommand("npm run commit")).toBeNull();
    expect(isTerminalGitCommand("")).toBeNull();
  });
});

describe("guardEnabled — advisory by default, strict off wins", () => {
  it("defaults to advisory (false) with no env and no guard.json", () => {
    expect(guardEnabled({}, null)).toBe(false);
    expect(guardEnabled({}, { enabled: false })).toBe(false);
  });
  it("is guarded when .semctx/guard.json enables it", () => {
    expect(guardEnabled({}, { enabled: true })).toBe(true);
  });
  it("SEMCTX_GUARD=off strictly disables even if guard.json enables", () => {
    expect(guardEnabled({ SEMCTX_GUARD: "off" }, { enabled: true })).toBe(false);
  });
  it("SEMCTX_GUARD=on forces guarded", () => {
    expect(guardEnabled({ SEMCTX_GUARD: "on" }, null)).toBe(true);
  });
});

describe("guardDecision — diff-hash gate (ADR 0007)", () => {
  const HASH = "sha256:abc";
  const CURRENT = { headCommit: "a".repeat(40), workingStateHash: HASH };
  const STATE = { version: 2, ...CURRENT, verdict: "WARN" };
  it("advisory profile never blocks", () => {
    expect(guardDecision({ enabled: false, terminalVerb: "commit", state: null, currentState: CURRENT }).block).toBe(false);
  });
  it("non-terminal commands are never blocked", () => {
    expect(guardDecision({ enabled: true, terminalVerb: null, state: null, currentState: CURRENT }).block).toBe(false);
  });
  it("blocks a commit when no verification is on record", () => {
    const d = guardDecision({ enabled: true, terminalVerb: "commit", state: null, currentState: CURRENT });
    expect(d.block).toBe(true);
    expect(d.reason).toContain("verify diff --record");
  });
  it("allows when the verified diff is unchanged and not BLOCK", () => {
    const d = guardDecision({ enabled: true, terminalVerb: "commit", state: STATE, currentState: CURRENT });
    expect(d.block).toBe(false);
  });
  it("blocks when the commit or working state changed since verification", () => {
    const d = guardDecision({
      enabled: true,
      terminalVerb: "push",
      state: { ...STATE, verdict: "PASS" },
      currentState: { ...CURRENT, workingStateHash: "sha256:changed" },
    });
    expect(d.block).toBe(true);
    expect(d.reason).toContain("changed since the last verification");
  });
  it("blocks when the recorded verdict was BLOCK, even if the diff is unchanged", () => {
    const d = guardDecision({ enabled: true, terminalVerb: "commit", state: { ...STATE, verdict: "BLOCK" }, currentState: CURRENT });
    expect(d.block).toBe(true);
    expect(d.reason).toContain("was BLOCK");
  });
  it("blocks legacy diff-only baselines", () => {
    const d = guardDecision({ enabled: true, terminalVerb: "commit", state: { diffHash: HASH, verdict: "PASS" }, currentState: CURRENT });
    expect(d.block).toBe(true);
    expect(d.reason).toContain("legacy");
  });
});

describe("guard runtime — large working diffs", () => {
  it("preserves the verification hash for a multi-megabyte diff", () => {
    const repo = mkdtempSync(join(tmpdir(), "semctx-guard-large-diff-"));
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      writeFileSync(join(repo, "large.txt"), "a".repeat(2 * 1024 * 1024));
      writeFileSync(join(repo, ".gitignore"), ".semctx/\n");
      execFileSync("git", ["add", "large.txt", ".gitignore"], { cwd: repo, stdio: "ignore" });
      execFileSync(
        "git",
        ["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "baseline"],
        { cwd: repo, stdio: "ignore" },
      );

      writeFileSync(join(repo, "large.txt"), "b".repeat(2 * 1024 * 1024));
      mkdirSync(join(repo, ".semctx"));
      writeFileSync(join(repo, ".semctx", "guard.json"), JSON.stringify({ enabled: true }));
      writeFileSync(
        join(repo, ".semctx", "verification-state.json"),
        JSON.stringify({ version: 2, ...captureVerificationGitState(repo), verdict: "PASS" }),
      );

      const guard = resolve(import.meta.dir, "../hooks/semctx-guard.mjs");
      const result = spawnSync("node", [guard], {
        cwd: repo,
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "git commit -m x" },
          cwd: repo,
        }),
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("verification-state capture parity", () => {
  it("matches the application service for tracked and untracked bytes", () => {
    const repo = mkdtempSync(join(tmpdir(), "semctx-guard-parity-"));
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      writeFileSync(join(repo, "tracked.ts"), "export const value = 1;\n");
      execFileSync("git", ["add", "tracked.ts"], { cwd: repo, stdio: "ignore" });
      execFileSync(
        "git",
        ["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "baseline"],
        { cwd: repo, stdio: "ignore" },
      );
      writeFileSync(join(repo, "tracked.ts"), "export const value = 2;\n");
      writeFileSync(join(repo, "untracked.ts"), "export const extra = true;\n");

      expect(captureVerificationGitState(repo)).toEqual(captureApplicationVerificationGitState(repo));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("resolveGitCwd — evaluate the repo the command targets, not the session cwd", () => {
  const SESSION = resolve("/session/root");

  it("falls back to inputCwd for a plain git commit", () => {
    expect(resolveGitCwd("git commit -m x", SESSION)).toBe(SESSION);
  });

  it("honors git -C <relative>, resolved against inputCwd", () => {
    expect(resolveGitCwd("git -C sub commit -m x", SESSION)).toBe(resolve(SESSION, "sub"));
  });

  it("honors a `cd <path> &&` prefix", () => {
    expect(resolveGitCwd("cd repo && git commit -m x", SESSION)).toBe(resolve(SESSION, "repo"));
  });

  it("accumulates chained cd, and applies -C on top of the running cd", () => {
    expect(resolveGitCwd("cd a && cd b && git commit", SESSION)).toBe(resolve(SESSION, "a", "b"));
    expect(resolveGitCwd("cd a && git -C c commit", SESSION)).toBe(resolve(SESSION, "a", "c"));
  });

  it("skips env assignments before git", () => {
    expect(resolveGitCwd("GIT_AUTHOR_NAME=x git -C sub commit", SESSION)).toBe(resolve(SESSION, "sub"));
  });

  it("honors -C when git is invoked through an absolute path or command wrapper", () => {
    expect(resolveGitCwd("/usr/bin/git -C sub commit", SESSION)).toBe(resolve(SESSION, "sub"));
    expect(resolveGitCwd("command git -C sub push", SESSION)).toBe(resolve(SESSION, "sub"));
  });

  it("resolves the same nested shell body used for terminal-command detection", () => {
    expect(resolveGitCwd("bash -c 'git -C ../other commit -m x'", SESSION)).toBe(resolve(SESSION, "../other"));
    expect(resolveGitCwd("sh -c 'cd nested && git push origin main'", SESSION)).toBe(resolve(SESSION, "nested"));
  });

  it("resolves an absolute -C path independently of inputCwd", () => {
    const abs = resolve("/other/repo");
    expect(resolveGitCwd(`git -C ${abs} commit`, SESSION)).toBe(abs);
  });

  it("regression: a git -C into another repo is NOT evaluated against the session repo", () => {
    // The cross-repo bug: `git -C <other> commit` from a guarded session must resolve to <other>,
    // whose (absent) guard.json makes it advisory — never the session repo's guard state.
    const other = resolve("/other/repo");
    expect(resolveGitCwd(`git -C ${other} commit -m x`, SESSION)).not.toBe(SESSION);
  });
});
