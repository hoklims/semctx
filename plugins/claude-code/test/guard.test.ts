import { describe, it, expect } from "bun:test";
// The guard ships as runnable Node ESM (it runs on machines without Bun). bun:test imports it
// directly; main() is guarded by an argv check so importing does not execute it.
import { isTerminalGitCommand, guardEnabled, guardDecision } from "../hooks/semctx-guard.mjs";

describe("isTerminalGitCommand — structural detection (no shell eval)", () => {
  it("detects commit and push, including global options and env assignments", () => {
    expect(isTerminalGitCommand("git commit -m 'x'")).toBe("commit");
    expect(isTerminalGitCommand("git push origin main")).toBe("push");
    expect(isTerminalGitCommand("git -C sub commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("git -c user.name=x commit")).toBe("commit");
    expect(isTerminalGitCommand("cd repo && git commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("GIT_AUTHOR_NAME=x git commit")).toBe("commit");
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
