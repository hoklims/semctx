import { describe, it, expect } from "bun:test";
// The guard ships as runnable Node ESM (it runs on machines without Bun). bun:test imports it
// directly; main() is guarded by an argv check so importing does not execute it.
import { isTerminalGitCommand, guardEnabled, guardDecision, resolveGitCwd } from "../hooks/semctx-guard.mjs";
import { resolve } from "node:path";

describe("isTerminalGitCommand — structural detection (no shell eval)", () => {
  it("detects commit and push, including global options and env assignments", () => {
    expect(isTerminalGitCommand("git commit -m 'x'")).toBe("commit");
    expect(isTerminalGitCommand("git push origin main")).toBe("push");
    expect(isTerminalGitCommand("git -C sub commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("git -c user.name=x commit")).toBe("commit");
    expect(isTerminalGitCommand("cd repo && git commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("GIT_AUTHOR_NAME=x git commit")).toBe("commit");
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
  it("advisory profile never blocks", () => {
    expect(guardDecision({ enabled: false, terminalVerb: "commit", state: null, currentHash: HASH }).block).toBe(false);
  });
  it("non-terminal commands are never blocked", () => {
    expect(guardDecision({ enabled: true, terminalVerb: null, state: null, currentHash: HASH }).block).toBe(false);
  });
  it("blocks a commit when no verification is on record", () => {
    const d = guardDecision({ enabled: true, terminalVerb: "commit", state: null, currentHash: HASH });
    expect(d.block).toBe(true);
    expect(d.reason).toContain("verify diff --record");
  });
  it("allows when the verified diff is unchanged and not BLOCK", () => {
    const d = guardDecision({ enabled: true, terminalVerb: "commit", state: { diffHash: HASH, verdict: "WARN" }, currentHash: HASH });
    expect(d.block).toBe(false);
  });
  it("blocks when the diff changed since verification", () => {
    const d = guardDecision({ enabled: true, terminalVerb: "push", state: { diffHash: "sha256:old", verdict: "PASS" }, currentHash: HASH });
    expect(d.block).toBe(true);
    expect(d.reason).toContain("changed since the last verification");
  });
  it("blocks when the recorded verdict was BLOCK, even if the diff is unchanged", () => {
    const d = guardDecision({ enabled: true, terminalVerb: "commit", state: { diffHash: HASH, verdict: "BLOCK" }, currentHash: HASH });
    expect(d.block).toBe(true);
    expect(d.reason).toContain("was BLOCK");
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
