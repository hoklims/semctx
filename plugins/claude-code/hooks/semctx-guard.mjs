#!/usr/bin/env node
// Claude Code PreToolUse guard for semctx (ADR 0007). Advisory by default (never blocks);
// blocks terminal `git commit` / `git push` when guarded mode is enabled and the command is not
// isolated or the current working state has not been verified.
//
// It parses the Bash command STRUCTURALLY (segments + tokens, never a shell eval) and never
// executes PR/agent content. It gates on a diff hash — no analysis runs here.
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, isAbsolute } from "node:path";

function unwrapShellBody(text) {
  const body = text.trim();
  const quote = body[0];
  if (quote !== '"' && quote !== "'") return body;
  const closing = body.lastIndexOf(quote);
  return closing > 0 ? body.slice(1, closing) : body.slice(1);
}

function wrappedShellCommand(command) {
  const text = String(command ?? "");
  const assignments = String.raw`(?:env(?:\s+-\S+)*\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*`;
  const patterns = [
    new RegExp(String.raw`(?:^|[;&|\n]\s*)${assignments}(?:bash|sh|zsh)(?:\s+(?!-c\b)\S+)*\s+-c\s+`, "i"),
    new RegExp(String.raw`(?:^|[;&|\n]\s*)${assignments}(?:powershell|pwsh)(?:\.exe)?(?:\s+(?!-(?:command|c)\b)\S+)*\s+-(?:command|c)\s+`, "i"),
    new RegExp(String.raw`(?:^|[;&|\n]\s*)${assignments}cmd(?:\.exe)?(?:\s+(?!\/c\b)\S+)*\s+\/c\s+`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match !== null) {
      return { body: unwrapShellBody(text.slice(match.index + match[0].length)), start: match.index };
    }
  }
  return null;
}

function shellCommandBody(command) {
  return wrappedShellCommand(command)?.body ?? null;
}

function gitTokenIndex(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  if (stripQuotes(tokens[i]) === "command") i += 1;
  const executable = stripQuotes(tokens[i]).replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  return executable === "git" || executable === "git.exe" ? i : -1;
}

/** Detect a terminal git verb (commit|push) in a shell command, structurally. Returns the verb or null. */
export function isTerminalGitCommand(command) {
  const nested = shellCommandBody(command);
  if (nested !== null) {
    const verb = isTerminalGitCommand(nested);
    if (verb !== null) return verb;
  }
  const segments = String(command ?? "").split(/&&|\|\||;|\||\n/);
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    const gitIndex = gitTokenIndex(tokens);
    if (gitIndex < 0) continue;
    let i = gitIndex + 1;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === "-C" || t === "-c") { i += 2; continue; } // options that take a value
      if (t?.startsWith("-")) { i += 1; continue; } // other global flags
      break;
    }
    const sub = tokens[i];
    if (sub === "commit" || sub === "push") return sub;
  }
  return null;
}

/**
 * Guarded mode authorizes only one terminal Git operation. Safe cwd prefixes are allowed, but any
 * other compound segment or shell expansion could mutate the repository after the pre-check.
 */
export function isIsolatedTerminalGitCommand(command) {
  const text = String(command ?? "").trim();
  if (text === "" || shellCommandBody(text) !== null) return false;
  if (/\$\(|`|\r|\n|\|\||(?<!\|)\|(?!\|)|;|(?<!&)&(?!&)|[<>]/.test(text)) return false;

  const segments = text.split("&&").map((segment) => segment.trim());
  if (segments.some((segment) => segment === "")) return false;
  const terminal = segments.pop();
  if (terminal === undefined || isTerminalGitCommand(terminal) === null) return false;

  for (const prefix of segments) {
    const tokens = prefix.split(/\s+/).filter(Boolean);
    if (tokens.length !== 2 || stripQuotes(tokens[0]).toLowerCase() !== "cd") return false;
    const target = stripQuotes(tokens[1]);
    if (target === "" || /[$*?{}\[\]]/.test(target)) return false;
  }
  return true;
}

/** Strip one layer of surrounding single or double quotes from a shell token. */
function stripQuotes(token) {
  const t = String(token ?? "");
  const q = t[0];
  if (t.length >= 2 && (q === '"' || q === "'") && t[t.length - 1] === q) return t.slice(1, -1);
  return t;
}

/** Resolve `p` (a shell token) against `base`; absolute paths win. */
function resolveUnder(base, p) {
  const clean = stripQuotes(p);
  return isAbsolute(clean) ? resolve(clean) : resolve(base, clean);
}

/**
 * Resolve the directory the terminal git command will actually run in, so the guard evaluates the
 * repo being committed to — not the session cwd. Honors left-to-right `cd <path>` prefixes and
 * git's own `-C <path>` global option, resolved relative to inputCwd. An unresolvable path (e.g.
 * `cd $VAR`) points at a non-existent dir, which safely degrades to advisory (no guard.json found →
 * fail-open) rather than blocking the wrong repo. Falls back to inputCwd.
 */
export function resolveGitCwd(command, inputCwd) {
  const text = String(command ?? "");
  const wrapped = wrappedShellCommand(text);
  if (wrapped !== null) {
    const nestedBase = wrapped.start > 0 ? resolveGitCwd(text.slice(0, wrapped.start), inputCwd) : inputCwd;
    return resolveGitCwd(wrapped.body, nestedBase);
  }
  const segments = text.split(/&&|\|\||;|\||\n/);
  let cwd = inputCwd;
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1; // skip env assignments
    if (tokens[i] === "cd" && tokens[i + 1] !== undefined) {
      cwd = resolveUnder(cwd, tokens[i + 1]);
      continue;
    }
    const gitIndex = gitTokenIndex(tokens);
    if (gitIndex < 0) continue;
    i = gitIndex + 1;
    let gitCwd = cwd;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === "-C" && tokens[i + 1] !== undefined) { gitCwd = resolveUnder(gitCwd, tokens[i + 1]); i += 2; continue; }
      if (t === "-c" && tokens[i + 1] !== undefined) { i += 2; continue; } // -c takes a value, not a path
      if (t?.startsWith("-")) { i += 1; continue; }
      break;
    }
    const sub = tokens[i];
    if (sub === "commit" || sub === "push") return gitCwd;
  }
  return cwd;
}

/** Enablement: SEMCTX_GUARD=off strictly disables (wins); =on forces; else .semctx/guard.json {enabled}. */
export function guardEnabled(env, guardJson) {
  const e = String(env?.SEMCTX_GUARD ?? "").toLowerCase();
  if (e === "off" || e === "0" || e === "false") return false;
  if (e === "on" || e === "1" || e === "true") return true;
  return guardJson?.enabled === true;
}

/** Pure decision. ctx: { enabled, terminalVerb, commandIsolated?, state|null, currentState|null }. */
export function guardDecision(ctx) {
  if (!ctx.enabled || !ctx.terminalVerb) return { block: false };
  const retry = `then retry the ${ctx.terminalVerb}. (strictly disable: SEMCTX_GUARD=off)`;
  if (ctx.commandIsolated === false) {
    return {
      block: true,
      reason: `semctx guarded mode: git ${ctx.terminalVerb} must be an isolated command; compound commands, shell substitutions, and redirections are not authorized.\n${retry}`,
    };
  }
  if (!ctx.state) {
    return { block: true, reason: `semctx guarded mode: no verification on record. Run:\n  semctx verify diff --record\n${retry}` };
  }
  if (
    ctx.state.version !== 2
    || !ctx.state.headCommit
    || !ctx.state.workingStateHash
    || !ctx.currentState
  ) {
    return { block: true, reason: `semctx guarded mode: the verification baseline is legacy, invalid, or unavailable. Re-run:\n  semctx verify diff --record\n${retry}` };
  }
  if (ctx.state.verdict === "BLOCK") {
    return { block: true, reason: `semctx guarded mode: the last verification was BLOCK. Resolve the findings, then re-run:\n  semctx verify diff --record` };
  }
  if (
    ctx.state.headCommit !== ctx.currentState.headCommit
    || ctx.state.workingStateHash !== ctx.currentState.workingStateHash
  ) {
    return { block: true, reason: `semctx guarded mode: the commit or working state changed since the last verification. Re-run:\n  semctx verify diff --record\n${retry}` };
  }
  return { block: false };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function frame(hash, label, payload) {
  const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  hash.update(`${label}\0${bytes.byteLength}\0`, "utf8").update(bytes);
}

/** Capture the same commit + tracked/untracked bytes recorded by `semctx verify diff --record`. */
export function captureVerificationGitState(cwd) {
  const headCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const diff = execFileSync("git", ["diff", "HEAD", "--relative", "--binary", "--no-color", "--", "."], {
    cwd,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  frame(hash, "domain", "semctx:verification-working-state:v1");
  frame(hash, "tracked-diff", diff);
  for (const path of untracked) {
    const absolute = resolve(cwd, path);
    const stat = lstatSync(absolute);
    frame(hash, "untracked-path", path.replace(/\\/g, "/"));
    if (stat.isSymbolicLink()) {
      frame(hash, "untracked-kind", "symlink");
      frame(hash, "untracked-target", readlinkSync(absolute));
    } else if (stat.isFile()) {
      frame(hash, "untracked-kind", (stat.mode & 0o111) === 0 ? "file:100644" : "file:100755");
      frame(hash, "untracked-content", readFileSync(absolute));
    } else {
      throw new Error(`unsupported untracked verification input: ${path}`);
    }
  }
  return { headCommit, workingStateHash: `sha256:${hash.digest("hex")}` };
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // no/invalid input → do not block
  }
  const toolName = input.tool_name ?? input.toolName;
  if (toolName !== "Bash") process.exit(0);
  const command = input.tool_input?.command ?? input.toolInput?.command ?? "";
  const terminalVerb = isTerminalGitCommand(command);
  if (!terminalVerb) process.exit(0);

  const inputCwd = input.cwd ?? process.cwd();
  const cwd = resolveGitCwd(command, inputCwd); // the repo the git command targets, not the session cwd
  const enabled = guardEnabled(process.env, readJson(join(cwd, ".semctx", "guard.json")));
  if (!enabled) process.exit(0); // advisory (default)

  const state = readJson(join(cwd, ".semctx", "verification-state.json"));
  let currentState = null;
  try {
    currentState = captureVerificationGitState(cwd);
  } catch {
    currentState = null;
  }
  const decision = guardDecision({
    enabled,
    terminalVerb,
    commandIsolated: isIsolatedTerminalGitCommand(command),
    state,
    currentState,
  });
  if (decision.block) {
    process.stderr.write(decision.reason + "\n");
    process.exit(2); // PreToolUse: non-zero (2) blocks the tool and surfaces stderr to the agent
  }
  process.exit(0);
}

if (process.argv[1]?.endsWith("semctx-guard.mjs")) main();
