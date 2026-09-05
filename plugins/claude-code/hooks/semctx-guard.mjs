#!/usr/bin/env node
// Claude Code PreToolUse guard for semctx (ADR 0007). Advisory by default (never blocks);
// blocks terminal `git commit` / `git push` when guarded mode is enabled and the command is not
// isolated or the current working state has not been verified.
//
// It parses the Bash command STRUCTURALLY (segments + tokens, never a shell eval) and never
// executes PR/agent content. It gates on canonical content fingerprints — no analysis runs here.
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, readdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

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
    new RegExp(String.raw`(?:^|[;&|\n]\s*)${assignments}(?:bash|sh|zsh)(?:\s+(?!-[^-\s]*c[^\s]*\b)\S+)*\s+-[^-\s]*c[^\s]*\s+`, "i"),
    new RegExp(String.raw`(?:^|[;&|\n]\s*)${assignments}(?:powershell|pwsh)(?:\.exe)?(?:\s+(?!-(?:command|c)\b)\S+)*\s+-(?:command|c)\s+`, "i"),
    new RegExp(String.raw`(?:^|[;&|\n]\s*)${assignments}cmd(?:\.exe)?(?:\s+(?!\/c\b)\S+)*\s+\/c\s+`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match !== null) {
      return { body: unwrapShellBody(text.slice(match.index + match[0].length)), start: match.index };
    }
  }
  for (const segment of shellSegments(text)) {
    const tokens = shellWords(segment);
    let commandIndex = 0;
    while (isEnvironmentAssignmentToken(tokens[commandIndex])) commandIndex += 1;
    commandIndex = envCommandIndex(tokens, commandIndex);
    while (isEnvironmentAssignmentToken(tokens[commandIndex])) commandIndex += 1;
    commandIndex = shellWrapperCommandIndex(tokens, commandIndex);
    if (commandIndex < 0) continue;
    const executable = executableName(tokens[commandIndex]);
    const optionInvokesCommand = executable === "cmd" || executable === "cmd.exe"
      ? (option) => option === "/c"
      : executable === "powershell" || executable === "powershell.exe" || executable === "pwsh" || executable === "pwsh.exe"
        ? (option) => option === "-command" || option === "-c"
        : executable === "bash" || executable === "sh" || executable === "zsh"
          ? (option) => /^-[^-]*c[^-]*$/.test(option)
          : null;
    if (optionInvokesCommand === null) continue;
    const optionIndex = tokens.findIndex(
      (token, index) => index > commandIndex && optionInvokesCommand(shellWordLiteralValue(token)?.toLowerCase() ?? ""),
    );
    if (optionIndex < 0 || tokens[optionIndex + 1] === undefined) continue;
    const body = tokens.slice(optionIndex + 1).map(shellWordLiteralValue);
    if (body.some((word) => word === null)) return { body: "", start: text.indexOf(segment) };
    return { body: body.join(" "), start: text.indexOf(segment) };
  }
  return null;
}

function shellCommandBody(command) {
  return wrappedShellCommand(command)?.body ?? null;
}

/** Split shell text without evaluating it, preserving quoted words and ignoring operators in quotes. */
function shellWords(text) {
  const source = String(text ?? "");
  const words = [];
  let word = "";
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote !== null) {
      word += char;
      if (quote === '"' && char === "\\" && source[i + 1] !== undefined) {
        word += source[i + 1];
        i += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\\" && source[i + 1] !== undefined) {
      word += char + source[i + 1];
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      word += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (word !== "") words.push(word);
      word = "";
      continue;
    }
    word += char;
  }
  if (word !== "") words.push(word);
  return words;
}

function shellSegments(text) {
  const source = String(text ?? "");
  const segments = [];
  let segment = "";
  let quote = null;
  let substitutionDepth = 0;
  let backtickOpen = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote !== null) {
      segment += char;
      if (quote === '"' && char === "\\" && source[i + 1] !== undefined) {
        segment += source[i + 1];
        i += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\\" && source[i + 1] !== undefined) {
      segment += char + source[i + 1];
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      segment += char;
      continue;
    }
    if (char === "`") {
      backtickOpen = !backtickOpen;
      segment += char;
      continue;
    }
    if (!backtickOpen && char === "$" && source[i + 1] === "(") {
      substitutionDepth += 1;
      segment += "$(";
      i += 1;
      continue;
    }
    if (!backtickOpen && substitutionDepth > 0 && char === "(") {
      substitutionDepth += 1;
      segment += char;
      continue;
    }
    if (!backtickOpen && substitutionDepth > 0 && char === ")") {
      substitutionDepth -= 1;
      segment += char;
      continue;
    }
    if (backtickOpen || substitutionDepth > 0) {
      segment += char;
      continue;
    }
    const pair = source.slice(i, i + 2);
    if (pair === "&&" || pair === "||") {
      segments.push(segment);
      segment = "";
      i += 1;
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n") {
      segments.push(segment);
      segment = "";
      continue;
    }
    segment += char;
  }
  segments.push(segment);
  return segments;
}

function visibleCommandSubstitutionBodies(text) {
  const source = String(text ?? "");
  const bodies = [];
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "\\" && source[i + 1] !== undefined) {
      i += 1;
      continue;
    }
    if (char === "'") {
      quote = "'";
      continue;
    }
    if (char === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (char === "`") {
      let body = "";
      for (i += 1; i < source.length; i += 1) {
        if (source[i] === "\\" && source[i + 1] !== undefined) {
          body += source[i] + source[i + 1];
          i += 1;
          continue;
        }
        if (source[i] === "`") break;
        body += source[i];
      }
      bodies.push(body);
      continue;
    }
    if (char !== "$" || source[i + 1] !== "(") continue;
    let body = "";
    let depth = 1;
    let innerQuote = null;
    for (i += 2; i < source.length; i += 1) {
      const inner = source[i];
      if (innerQuote !== null) {
        body += inner;
        if (innerQuote === '"' && inner === "\\" && source[i + 1] !== undefined) {
          body += source[i + 1];
          i += 1;
        } else if (inner === innerQuote) {
          innerQuote = null;
        }
        continue;
      }
      if (inner === "\\" && source[i + 1] !== undefined) {
        body += inner + source[i + 1];
        i += 1;
        continue;
      }
      if (inner === "'" || inner === '"') {
        innerQuote = inner;
        body += inner;
        continue;
      }
      if (inner === "(") depth += 1;
      if (inner === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      body += inner;
    }
    bodies.push(body);
  }
  return bodies;
}

function stripVisibleShellGroupEdges(segment) {
  let value = String(segment ?? "").trim();
  while (value.startsWith("(") || value.startsWith("{")) value = value.slice(1).trimStart();
  while (value.endsWith(")") || value.endsWith("}")) value = value.slice(0, -1).trimEnd();
  return value;
}

/** Resolve only literal quote/backslash composition; never expand variables, substitutions, or globs. */
function shellWordLiteralValue(token) {
  const source = String(token ?? "");
  let value = "";
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else value += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === "\\" && source[i + 1] !== undefined && /[$`"\\\n]/.test(source[i + 1])) {
        if (source[i + 1] !== "\n") value += source[i + 1];
        i += 1;
        continue;
      }
      value += char;
      continue;
    }
    if (char === "'") {
      quote = "'";
      continue;
    }
    if (char === '"') {
      quote = '"';
      continue;
    }
    if (char === "\\" && source[i + 1] !== undefined) {
      if (source[i + 1] !== "\n") value += source[i + 1];
      i += 1;
      continue;
    }
    value += char;
  }
  return quote === null ? value : null;
}

function isEnvironmentAssignmentToken(token) {
  const value = shellWordLiteralValue(token);
  return value !== null && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function envSplitStringBody(command) {
  const text = String(command ?? "").trim();
  const tokens = shellWords(text);
  let i = 0;
  while (i < tokens.length && isEnvironmentAssignmentToken(tokens[i])) i += 1;
  if (executableName(tokens[i]) !== "env" && executableName(tokens[i]) !== "env.exe") return null;
  const splitOption = /(?:^|\s)(?:-S\s+|--split-string(?:=|\s+))/.exec(text);
  if (splitOption === null) return null;
  return unwrapShellBody(text.slice(splitOption.index + splitOption[0].length));
}

const RECOGNIZED_GIT_EXECUTABLES = new Set(["git", "git.exe", "git.cmd", "git.bat", "git.com"]);

function executableName(token) {
  const literalName = shellWordLiteralValue(token)?.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  const windowsPathName = stripQuotes(token).replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  if (literalName !== undefined && RECOGNIZED_GIT_EXECUTABLES.has(literalName)) return literalName;
  if (windowsPathName !== undefined && RECOGNIZED_GIT_EXECUTABLES.has(windowsPathName)) return windowsPathName;
  return literalName;
}

function isCanonicalGitExecutableToken(token) {
  const executable = stripQuotes(token).toLowerCase();
  return executable === "git" || executable === "git.exe";
}

function shellExpandedExecutableEndIndex(tokens, start) {
  if (!/[$`]/.test(stripQuotes(tokens[start]))) return -1;
  let substitutionDepth = 0;
  let backtickOpen = false;
  for (let i = start; i < tokens.length; i += 1) {
    const token = stripQuotes(tokens[i]);
    for (let offset = 0; offset < token.length; offset += 1) {
      const char = token[offset];
      if (char === "`") {
        backtickOpen = !backtickOpen;
        continue;
      }
      if (backtickOpen) continue;
      if (char === "$" && token[offset + 1] === "(") {
        substitutionDepth += 1;
        offset += 1;
      } else if (substitutionDepth > 0 && char === "(") {
        substitutionDepth += 1;
      } else if (substitutionDepth > 0 && char === ")") {
        substitutionDepth -= 1;
      }
    }
    if (substitutionDepth === 0 && !backtickOpen) return i;
  }
  return tokens.length - 1;
}

const ENV_OPTIONS_WITH_VALUE = new Set([
  "-a",
  "-C",
  "-S",
  "-u",
  "--argv0",
  "--chdir",
  "--split-string",
  "--unset",
]);

function envCommandIndex(tokens, start) {
  if (executableName(tokens[start]) !== "env" && executableName(tokens[start]) !== "env.exe") return start;
  let i = start + 1;
  while (i < tokens.length) {
    const token = stripQuotes(tokens[i]);
    if (token === "--") return i + 1;
    if (isEnvironmentAssignmentToken(tokens[i]) || !token.startsWith("-")) return i;
    if (ENV_OPTIONS_WITH_VALUE.has(token)) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return i;
}

/** Resolve shell builtins that can directly invoke the following command without evaluating data. */
function shellWrapperCommandIndex(tokens, start) {
  let i = start;
  let wrapper = shellWordLiteralValue(tokens[i])?.toLowerCase();
  if (wrapper === "builtin") {
    i += 1;
    wrapper = shellWordLiteralValue(tokens[i])?.toLowerCase();
    if (wrapper !== "command" && wrapper !== "exec") return -1;
  }
  if (wrapper === "command") {
    i += 1;
    while (i < tokens.length) {
      const option = shellWordLiteralValue(tokens[i]);
      if (option === "--") return i + 1;
      if (option === "-p") {
        i += 1;
        continue;
      }
      if (option?.startsWith("-")) return -1;
      return i;
    }
    return i;
  }
  if (wrapper === "exec") {
    i += 1;
    while (i < tokens.length) {
      const option = shellWordLiteralValue(tokens[i]);
      if (option === "--") return i + 1;
      if (option === "-a") {
        i += 2;
        continue;
      }
      if (option !== null && /^-[cl]+$/.test(option)) {
        i += 1;
        continue;
      }
      if (option?.startsWith("-")) return -1;
      return i;
    }
    return i;
  }
  return start;
}

function gitTokenIndex(tokens) {
  let i = 0;
  while (i < tokens.length && isEnvironmentAssignmentToken(tokens[i])) i += 1;
  i = envCommandIndex(tokens, i);
  while (i < tokens.length && isEnvironmentAssignmentToken(tokens[i])) i += 1;
  i = shellWrapperCommandIndex(tokens, i);
  if (i < 0) return -1;
  const executable = executableName(tokens[i]);
  if (executable !== undefined && RECOGNIZED_GIT_EXECUTABLES.has(executable)) return i;
  return shellExpandedExecutableEndIndex(tokens, i);
}

const SHELL_CONTROL_PREFIXES = new Set([
  "!", "case", "do", "elif", "else", "if", "select", "then", "until", "while",
]);
const EXEC_TRANSPARENT_PREFIXES = new Set([
  "chroot", "chrt", "doas", "ionice", "nice", "nohup", "setsid", "stdbuf", "sudo",
  "taskset", "time", "timeout", "unshare",
]);

function visiblePrefixedGitTokenIndex(tokens) {
  const prefix = shellWordLiteralValue(tokens[0])?.toLowerCase();
  if (!SHELL_CONTROL_PREFIXES.has(prefix) && !EXEC_TRANSPARENT_PREFIXES.has(prefix)) return -1;
  for (let i = 1; i < tokens.length; i += 1) {
    const executable = executableName(tokens[i]);
    if (executable !== undefined && RECOGNIZED_GIT_EXECUTABLES.has(executable)) return i;
  }
  return -1;
}

function terminalGitVerbFromTokens(tokens, gitIndex) {
  let i = gitIndex + 1;
  while (i < tokens.length) {
    const token = shellWordLiteralValue(tokens[i]);
    if (token === null) break;
    if (gitOptionConsumesNext(token)) { i += 2; continue; }
    if (token?.startsWith("-")) { i += 1; continue; }
    break;
  }
  const subcommand = shellWordLiteralValue(tokens[i]);
  return subcommand === "commit" || subcommand === "push" ? subcommand : null;
}

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);

const GIT_RETARGET_OPTIONS = new Set([
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--work-tree",
]);

const GIT_RETARGET_ENV = new Set([
  "ALL_PROXY",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_EXEC_PATH",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_PROXY_COMMAND",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_WORK_TREE",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
]);

function gitOptionName(token) {
  const clean = stripQuotes(token);
  const equals = clean.indexOf("=");
  return equals < 0 ? clean : clean.slice(0, equals);
}

function gitOptionConsumesNext(token) {
  const clean = stripQuotes(token);
  return !clean.includes("=") && GIT_GLOBAL_OPTIONS_WITH_VALUE.has(clean);
}

function gitCPath(token, nextToken) {
  const clean = stripQuotes(token);
  if (clean === "-C") return nextToken === undefined ? null : stripQuotes(nextToken);
  return clean.startsWith("-C") && clean.length > 2 ? clean.slice(2) : null;
}

function pathRequiresShellExpansion(token) {
  return /[$~*?{}[\]]/.test(stripQuotes(token));
}

function shellTokenRequiresExpansion(token) {
  const source = String(token ?? "");
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === "\\" && source[i + 1] !== undefined) {
        i += 1;
        continue;
      }
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === "$" || char === "`") return true;
      continue;
    }
    if (char === "\\" && source[i + 1] !== undefined) {
      i += 1;
      continue;
    }
    if (char === '"') {
      quote = '"';
      continue;
    }
    if (char === "'") {
      quote = "'";
      continue;
    }
    if (char === "$" || char === "`") return true;
    if (quote === null && /[~*?{}[\]]/.test(char)) return true;
  }
  return quote !== null;
}

/**
 * Detect terminal Git words that shell expansion can split inside one lexical token.
 * Expansion bodies are opaque: only the surrounding literal fragments are joined, and the
 * result must be an exact supported invocation shape. This catches `git${IFS}push` without
 * treating look-alikes such as `echo${IFS}git${IFS}push` as terminal Git commands.
 */
function literalPrintfOutput(body) {
  return /(?:^|[;&|]\s*)printf\s+(?:--\s+)?([A-Za-z0-9_.-]+)\s*$/.exec(body)?.[1];
}

function terminalVerbFromExpandedWord(token) {
  const source = String(token ?? "");
  let compact = "";
  let quote = null;
  let expanded = false;
  let expandedGitExecutable = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else compact += char;
      continue;
    }
    if (quote === '"' && char === '"') {
      quote = null;
      continue;
    }
    if (quote === null && char === "'") {
      quote = "'";
      continue;
    }
    if (quote === null && char === '"') {
      quote = '"';
      continue;
    }
    if (char === "\\" && source[i + 1] !== undefined) {
      if (quote === null || /[$`"\\\n]/.test(source[i + 1])) {
        if (source[i + 1] !== "\n") compact += source[i + 1];
        i += 1;
      } else {
        compact += char;
      }
      continue;
    }
    if (char === "`" && quote !== "'") {
      expanded = true;
      const closing = source.indexOf("`", i + 1);
      const body = source.slice(i + 1, closing < 0 ? source.length : closing);
      const literal = literalPrintfOutput(body);
      if (literal !== undefined) compact += literal;
      if (/(?:^|\s|[\\/])git(?:\.exe|\.cmd|\.bat|\.com)?(?:\s|$)/i.test(body)) expandedGitExecutable = true;
      i = closing < 0 ? source.length : closing;
      continue;
    }
    if (char !== "$" || quote === "'") {
      compact += char;
      continue;
    }

    expanded = true;
    const next = source[i + 1];
    if (next === "{") {
      let depth = 1;
      const bodyStart = i + 2;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") depth -= 1;
        i += 1;
      }
      const body = source.slice(bodyStart, depth === 0 ? i - 1 : source.length);
      const parameter = /^([A-Za-z_][A-Za-z0-9_]*)(:?[-+=?])([A-Za-z0-9_.-]+)$/.exec(body);
      const bareName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(body) ? body.toUpperCase() : null;
      if (bareName === "IFS") compact += " ";
      else if (bareName === "GIT") compact += "git";
      else if (parameter !== null && parameter[2] !== "?" && parameter[2] !== ":?") {
        compact += parameter[3];
      }
      if (
        /^GIT(?:[^A-Za-z0-9_]|$)/i.test(body)
        || /:?[-+=?]git(?:\.exe|\.cmd|\.bat|\.com)?$/i.test(body)
      ) {
        expandedGitExecutable = true;
      }
      i -= 1;
      continue;
    }
    if (next === "(") {
      let depth = 1;
      const bodyStart = i + 2;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === "(") depth += 1;
        else if (source[i] === ")") depth -= 1;
        i += 1;
      }
      const body = source.slice(bodyStart, depth === 0 ? i - 1 : source.length);
      const literal = literalPrintfOutput(body);
      if (literal !== undefined) compact += literal;
      if (/(?:^|\s|[\\/])git(?:\.exe|\.cmd|\.bat|\.com)?(?:\s|$)/i.test(body)) expandedGitExecutable = true;
      i -= 1;
      continue;
    }
    if (next !== undefined && /[A-Za-z0-9_]/.test(next)) {
      const nameStart = i + 1;
      i += 1;
      while (i + 1 < source.length && /[A-Za-z0-9_]/.test(source[i + 1])) i += 1;
      if (/^GIT(?:_|$)/i.test(source.slice(nameStart, i + 1))) expandedGitExecutable = true;
    } else if (next !== undefined) {
      i += 1;
    }
  }

  if (!expanded || quote !== null) return null;
  const literalWords = compact.trim().split(/\s+/);
  const literalExecutable = literalWords[0]?.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (/^git(?:\.exe|\.cmd|\.bat|\.com)?$/.test(literalExecutable)) {
    const verb = literalWords[1]?.toLowerCase();
    if (verb === "commit" || verb === "push") return verb;
  }
  const normalized = compact.replace(/\s+/g, "").replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const shapes = /^(?:builtin)?(?:command|exec)?git(?:\.exe|\.cmd|\.bat|\.com)?(commit|push)$/;
  const exact = shapes.exec(normalized)?.[1];
  if (exact !== undefined) return exact;
  if (expandedGitExecutable) {
    const firstLiteralWord = compact.trim().split(/\s+/, 1)[0]?.toLowerCase();
    if (firstLiteralWord === "commit" || firstLiteralWord === "push") return firstLiteralWord;
  }
  return null;
}

function isRetargetingEnvironmentName(name) {
  const normalized = String(name ?? "").toUpperCase();
  return GIT_RETARGET_ENV.has(normalized) || normalized.startsWith("GIT_CONFIG_");
}

function isRetargetingEnvironmentAssignment(token) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(shellWordLiteralValue(token) ?? "");
  if (match === null) return false;
  return isRetargetingEnvironmentName(match[1]);
}

function envWrapperMakesScopeAmbiguous(tokens, gitIndex) {
  let envIndex = 0;
  while (envIndex < tokens.length && isEnvironmentAssignmentToken(tokens[envIndex])) envIndex += 1;
  if (executableName(tokens[envIndex]) !== "env" && executableName(tokens[envIndex]) !== "env.exe") return false;
  const envArgs = tokens.slice(envIndex + 1, gitIndex);
  for (let i = 0; i < envArgs.length; i += 1) {
    const token = stripQuotes(envArgs[i]);
    if (token === "-i" || token === "--ignore-environment") return true;
    if (token === "-u" || token === "--unset") {
      if (isRetargetingEnvironmentName(stripQuotes(envArgs[i + 1]))) return true;
      i += 1;
      continue;
    }
    if (
      (token.startsWith("-u") && token.length > 2 && isRetargetingEnvironmentName(token.slice(2)))
      || (token.startsWith("--unset=") && isRetargetingEnvironmentName(token.slice("--unset=".length)))
    ) {
      return true;
    }
    if (
      token === "-C"
      || token === "-S"
      || token === "--chdir"
      || token === "--split-string"
      || (token.startsWith("-C") && token.length > 2)
      || token.startsWith("--chdir=")
      || token.startsWith("--split-string=")
    ) {
      return true;
    }
  }
  return false;
}

function shellWrapperMakesScopeAmbiguous(tokens, gitIndex) {
  for (let i = 0; i < gitIndex; i += 1) {
    const literal = shellWordLiteralValue(tokens[i])?.toLowerCase();
    if (literal === "command" || literal === "exec" || literal === "builtin") return true;
  }
  return false;
}

/**
 * Whether the command can make Git operate on state other than the structurally resolved cwd.
 * These forms are not evaluated or expanded by the hook, so guarded mode must use the session
 * guard as a fail-closed fallback.
 */
function gitScopeRequiresSessionGuard(command) {
  const text = String(command ?? "");
  if (envSplitStringBody(text) !== null) return true;
  const nested = shellCommandBody(text);
  if (nested !== null && gitScopeRequiresSessionGuard(nested)) return true;

  for (const segment of shellSegments(text)) {
    const tokens = shellWords(segment.trim());
    let i = 0;
    while (i < tokens.length && isEnvironmentAssignmentToken(tokens[i])) {
      if (isRetargetingEnvironmentAssignment(tokens[i])) return true;
      i += 1;
    }
    if (stripQuotes(tokens[i]).toLowerCase() === "cd" && tokens[i + 1] !== undefined) {
      if (pathRequiresShellExpansion(tokens[i + 1])) return true;
      continue;
    }

    const gitIndex = gitTokenIndex(tokens);
    if (gitIndex < 0) continue;
    if (!isCanonicalGitExecutableToken(tokens[gitIndex])) return true;
    if (envWrapperMakesScopeAmbiguous(tokens, gitIndex)) return true;
    if (shellWrapperMakesScopeAmbiguous(tokens, gitIndex)) return true;
    for (let prefix = 0; prefix < gitIndex; prefix += 1) {
      if (isRetargetingEnvironmentAssignment(tokens[prefix])) return true;
    }

    i = gitIndex + 1;
    while (i < tokens.length) {
      const token = stripQuotes(tokens[i]);
      const option = gitOptionName(token);
      const cwdPath = gitCPath(token, tokens[i + 1]);
      if (cwdPath !== null) {
        if (pathRequiresShellExpansion(cwdPath)) return true;
      } else if (token === "-c" || token.startsWith("-c")) {
        // Any command-scoped config is outside the authorizing contract. Even an apparently
        // unrelated key can include another config that changes hooksPath or repository discovery.
        return true;
      } else if (option === "--config-env") {
        return true;
      } else if (GIT_RETARGET_OPTIONS.has(option) || option === "--bare") {
        return true;
      }
      if (!token.startsWith("-")) break;
      i += gitOptionConsumesNext(token) ? 2 : 1;
    }
  }
  return false;
}

function visibleDynamicWrapperBody(command) {
  const tokens = shellWords(String(command ?? "").trim());
  const wrapper = shellWordLiteralValue(tokens[0])?.toLowerCase();
  if (wrapper === "eval") {
    const body = tokens.slice(1).map(shellWordLiteralValue);
    return body.length > 0 && body.every((word) => word !== null) ? body.join(" ") : null;
  }
  if (wrapper !== "xargs") return null;
  for (let i = 1; i + 2 < tokens.length; i += 1) {
    const shell = executableName(tokens[i]);
    if (shell !== "sh" && shell !== "bash") continue;
    if (shellWordLiteralValue(tokens[i + 1]) !== "-c") continue;
    return shellWordLiteralValue(tokens[i + 2]);
  }
  return null;
}

/** Detect a terminal git verb (commit|push) in a shell command, structurally. Returns the verb or null. */
export function isTerminalGitCommand(command) {
  for (const body of visibleCommandSubstitutionBodies(command)) {
    const verb = isTerminalGitCommand(body);
    if (verb !== null) return verb;
  }
  const envSplit = envSplitStringBody(command);
  if (envSplit !== null) {
    const verb = isTerminalGitCommand(envSplit);
    if (verb !== null) return verb;
  }
  const nested = shellCommandBody(command);
  if (nested !== null) {
    const verb = isTerminalGitCommand(nested);
    if (verb !== null) return verb;
  }
  const dynamicWrapper = visibleDynamicWrapperBody(command);
  if (dynamicWrapper !== null) {
    const verb = isTerminalGitCommand(dynamicWrapper);
    if (verb !== null) return verb;
  }
  const segments = shellSegments(command);
  for (const seg of segments) {
    const visibleSegment = stripVisibleShellGroupEdges(seg);
    const composedVerb = terminalVerbFromExpandedWord(visibleSegment);
    if (composedVerb !== null) return composedVerb;
    const tokens = shellWords(visibleSegment);
    for (const token of tokens) {
      const expandedVerb = terminalVerbFromExpandedWord(token);
      if (expandedVerb !== null) return expandedVerb;
    }
    let gitIndex = gitTokenIndex(tokens);
    if (gitIndex < 0) gitIndex = visiblePrefixedGitTokenIndex(tokens);
    if (gitIndex < 0) continue;
    const verb = terminalGitVerbFromTokens(tokens, gitIndex);
    if (verb !== null) return verb;
  }
  return null;
}

/**
 * Guarded mode authorizes only one terminal Git operation. Safe cwd prefixes are allowed, but any
 * other compound segment or shell expansion could mutate the repository after the pre-check.
 */
export function isIsolatedTerminalGitCommand(command) {
  const text = String(command ?? "").trim();
  if (
    text === ""
    || shellCommandBody(text) !== null
    || envSplitStringBody(text) !== null
    || visibleDynamicWrapperBody(text) !== null
  ) return false;
  if (/\$\(|`|\r|\n|\|\||(?<!\|)\|(?!\|)|;|(?<!&)&(?!&)|[<>]/.test(text)) return false;
  if (gitScopeRequiresSessionGuard(text)) return false;

  const segments = text.split("&&").map((segment) => segment.trim());
  if (segments.some((segment) => segment === "")) return false;
  const terminal = segments.pop();
  if (terminal === undefined || isTerminalGitCommand(terminal) === null) return false;
  if (shellWords(terminal).some(shellTokenRequiresExpansion)) return false;

  for (const prefix of segments) {
    const tokens = shellWords(prefix);
    if (tokens.length !== 2 || stripQuotes(tokens[0]).toLowerCase() !== "cd") return false;
    const target = stripQuotes(tokens[1]);
    if (target === "" || pathRequiresShellExpansion(target)) return false;
  }
  return true;
}

const COMMIT_OPTIONS_WITH_VALUE = new Set([
  "-c", "-C", "-F", "-m", "-t", "--author", "--cleanup", "--date", "--file",
  "--fixup", "--message", "--reedit-message", "--reuse-message", "--squash", "--template",
  "--trailer",
]);

const COMMIT_TREE_SELECTION_OPTIONS = new Set([
  "--all", "--include", "--interactive", "--only", "--patch", "--pathspec-file-nul",
  "--pathspec-from-file", "-a", "-i", "-o", "-p",
]);

const COMMIT_PREFIX_SENSITIVE_OPTIONS = new Set([
  ...COMMIT_TREE_SELECTION_OPTIONS,
  "--fixup",
]);

function isAbbreviatedCommitOption(option) {
  return option.startsWith("--")
    && [...COMMIT_PREFIX_SENSITIVE_OPTIONS].some((full) => full !== option && full.startsWith(option));
}

/** Authorize only commit forms that materialize the already-inspected index without restaging or path selection. */
export function commitUsesWholeIndex(command) {
  const terminal = String(command ?? "").split("&&").at(-1)?.trim() ?? "";
  const tokens = shellWords(terminal);
  const gitIndex = gitTokenIndex(tokens);
  if (gitIndex < 0) return false;
  let i = gitIndex + 1;
  while (i < tokens.length) {
    const token = literalShellWord(tokens[i]);
    if (token === null) return false;
    if (gitOptionConsumesNext(token)) { i += 2; continue; }
    if (token.startsWith("-")) { i += 1; continue; }
    break;
  }
  if (literalShellWord(tokens[i]) !== "commit") return false;
  i += 1;
  while (i < tokens.length) {
    const token = literalShellWord(tokens[i]);
    if (token === null || token === "--") return false;
    const option = gitOptionName(token);
    if (
      COMMIT_TREE_SELECTION_OPTIONS.has(option)
      || isAbbreviatedCommitOption(option)
      || option === "--fixup"
      || (/^-[^-]+/.test(token) && !token.startsWith("-m") && !token.startsWith("-F") && /[aiop]/.test(token.slice(1)))
    ) return false;
    if (!token.startsWith("-")) return false;
    if (COMMIT_OPTIONS_WITH_VALUE.has(option) && !token.includes("=") && token === option) {
      const value = tokens[i + 1] === undefined ? null : literalShellWord(tokens[i + 1]);
      if (value === null) return false;
      i += 2;
      continue;
    }
    i += 1;
  }
  return true;
}

function gitHookSurfaceClear(cwd) {
  try {
    const result = spawnSync("git", ["rev-parse", "--git-path", "hooks"], { cwd, encoding: "utf8" });
    if (result.status !== 0) return false;
    const raw = result.stdout.trim();
    if (raw === "") return false;
    const hooks = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
    return readdirSync(hooks, { withFileTypes: true })
      .every((entry) => entry.isFile() && entry.name.endsWith(".sample"));
  } catch {
    return false;
  }
}

/** A pre-tool proof is valid only when no commit hook can restage or trigger follow-up effects. */
export function commitHookSurfaceClear(cwd) {
  return gitHookSurfaceClear(cwd);
}

/** A pre-tool proof is valid only when no pre-push hook can add uninspected side effects. */
export function pushHookSurfaceClear(cwd) {
  return gitHookSurfaceClear(cwd);
}

const UNSAFE_PUSH_OPTIONS = new Set([
  "--all", "--branches", "--delete", "-d", "--follow-tags", "--mirror", "--prune",
  "--recurse-submodules", "--tags", "--exec", "--push-option", "--receive-pack", "-o",
]);

const SAFE_PUSH_OPTIONS = new Set([
  "--atomic", "--dry-run", "--force", "--force-if-includes", "--force-with-lease",
  "--ipv4", "--ipv6", "--no-atomic", "--no-force-if-includes", "--no-force-with-lease",
  "--no-signed", "--no-thin", "--no-verify", "--porcelain", "--quiet", "--set-upstream",
  "--signed", "--thin", "--verbose", "-4", "-6", "-f", "-n", "-q", "-u", "-v",
]);

const SAFE_PUSH_SCHEMES = new Set(["file", "git", "http", "https", "ssh"]);

function pushEndpointIsSafe(endpoint) {
  const value = String(endpoint ?? "");
  if (value === "" || /[\r\n\0]/.test(value) || value.includes("::")) return false;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value)?.[1]?.toLowerCase();
  return scheme === undefined || SAFE_PUSH_SCHEMES.has(scheme);
}

function pushRemoteTransportIsSafe(cwd, remote) {
  if (!pushEndpointIsSafe(remote)) return false;
  const remotes = spawnSync("git", ["remote"], { cwd, encoding: "utf8" });
  if (remotes.status !== 0) return false;
  const configuredNames = remotes.stdout.split(/\r?\n/).filter((name) => name !== "");
  if (!configuredNames.includes(remote)) return true;
  const urls = spawnSync("git", ["remote", "get-url", "--push", "--all", remote], {
    cwd,
    encoding: "utf8",
  });
  if (urls.status !== 0) return false;
  const endpoints = urls.stdout.split(/\r?\n/).filter((endpoint) => endpoint !== "");
  return endpoints.length > 0 && endpoints.every(pushEndpointIsSafe);
}

/** Resolve one shell word without evaluating it; reject quote/backslash composition inside a word. */
function literalShellWord(token) {
  const raw = String(token ?? "");
  const value = stripQuotes(raw);
  const wholeQuoted = raw.length >= 2
    && (raw[0] === '"' || raw[0] === "'")
    && raw.at(-1) === raw[0];
  if ((wholeQuoted ? value : raw).includes("\\")) return null;
  if (wholeQuoted ? value.includes(raw[0]) : /["']/.test(value)) return null;
  return value;
}

/**
 * Prove that an isolated push can publish only the checked-out HEAD through an explicit,
 * non-delegating remote transport.
 */
export function pushSourceMatchesHead(command, cwd, currentHead) {
  try {
    const terminal = String(command ?? "").split("&&").at(-1)?.trim() ?? "";
    if (gitScopeRequiresSessionGuard(terminal)) return false;
    const tokens = shellWords(terminal);
    if (tokens.some(shellTokenRequiresExpansion)) return false;
    const gitIndex = gitTokenIndex(tokens);
    if (gitIndex < 0) return false;
    let i = gitIndex + 1;
    while (i < tokens.length) {
      const token = literalShellWord(tokens[i]);
      if (token === null) return false;
      if (token === "-c" || token.startsWith("-c") || token === "--config-env" || token.startsWith("--config-env=")) {
        return false;
      }
      if (gitOptionConsumesNext(token)) { i += 2; continue; }
      if (token.startsWith("-")) { i += 1; continue; }
      break;
    }
    if (literalShellWord(tokens[i]) !== "push") return false;
    i += 1;

    const positionals = [];
    while (i < tokens.length) {
      const token = literalShellWord(tokens[i]);
      if (token === null) return false;
      const option = gitOptionName(token);
      if (UNSAFE_PUSH_OPTIONS.has(option) || option === "--repo") return false;
      if (token.startsWith("-")) {
        if (!SAFE_PUSH_OPTIONS.has(option)) return false;
        i += 1;
        continue;
      }
      positionals.push(token);
      i += 1;
    }
    if (positionals.length !== 2) return false;

    const configured = spawnSync(
      "git",
      [
        "config",
        "--get-regexp",
        "^(push\\.(followtags|recursesubmodules|pushoption)|submodule\\.recurse|remote\\..*\\.(mirror|push|receivepack|proxy|proxyauthmethod|serveroption|vcs)|core\\.(sshcommand|gitproxy)|http(\\..+)?\\.(proxy|proxyauthmethod|proxysslcainfo|proxysslcert|proxysslcertpasswordprotected|proxysslkey|curloptresolve|followredirects|extraheader)|url\\..*\\.(insteadof|pushinsteadof))$",
      ],
      { cwd, encoding: "utf8" },
    );
    if (configured.status !== 1) return false;

    const remote = positionals[0];
    if (!pushRemoteTransportIsSafe(cwd, remote)) return false;
    const refspec = positionals[1];
    const separator = refspec.indexOf(":");
    const rawSource = separator < 0 ? refspec : refspec.slice(0, separator);
    const source = rawSource.startsWith("+") ? rawSource.slice(1) : rawSource;
    if (source === "" || source.includes("*") || source.startsWith("^")) return false;
    if (source !== "HEAD" && source !== currentHead) return false;
    const resolved = execFileSync("git", ["rev-parse", "--verify", source], {
      cwd,
      encoding: "utf8",
    }).trim();
    return resolved === currentHead;
  } catch {
    return false;
  }
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
 * git's own `-C <path>` global option, resolved relative to inputCwd. Paths that require shell
 * expansion are deliberately not interpreted here; guarded mode treats their scope as ambiguous
 * and falls back to the session guard. Falls back to inputCwd.
 */
export function resolveGitCwd(command, inputCwd) {
  const text = String(command ?? "");
  const envSplit = envSplitStringBody(text);
  if (envSplit !== null) return resolveGitCwd(envSplit, inputCwd);
  const wrapped = wrappedShellCommand(text);
  if (wrapped !== null) {
    const nestedBase = wrapped.start > 0 ? resolveGitCwd(text.slice(0, wrapped.start), inputCwd) : inputCwd;
    return resolveGitCwd(wrapped.body, nestedBase);
  }
  const segments = shellSegments(text);
  let cwd = inputCwd;
  for (const seg of segments) {
    const tokens = shellWords(seg.trim());
    let i = 0;
    while (i < tokens.length && isEnvironmentAssignmentToken(tokens[i])) i += 1; // skip env assignments
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
      const cwdPath = gitCPath(t, tokens[i + 1]);
      if (cwdPath !== null) {
        gitCwd = resolveUnder(gitCwd, cwdPath);
        i += stripQuotes(t) === "-C" ? 2 : 1;
        continue;
      }
      if (t === "-c" && tokens[i + 1] !== undefined) { i += 2; continue; } // -c takes a value, not a path
      if (gitOptionConsumesNext(t)) { i += 2; continue; }
      if (t?.startsWith("-")) { i += 1; continue; }
      break;
    }
    const sub = tokens[i];
    if (sub === "commit" || sub === "push") return gitCwd;
  }
  return cwd;
}

/** Resolve a command directory to the repository root Git itself will discover from there. */
function resolveGitRoot(cwd) {
  try {
    const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
    return root === "" ? cwd : resolve(root);
  } catch {
    let current = resolve(cwd);
    while (true) {
      if (existsSync(join(current, ".git")) || existsSync(join(current, ".semctx", "guard.json"))) {
        return current;
      }
      const parent = dirname(current);
      if (parent === current) return resolve(cwd);
      current = parent;
    }
  }
}

/** Enablement: SEMCTX_GUARD=off strictly disables (wins); =on forces; else .semctx/guard.json {enabled}. */
export function guardEnabled(env, guardJson) {
  const e = String(env?.SEMCTX_GUARD ?? "").toLowerCase();
  if (e === "off" || e === "0" || e === "false") return false;
  if (e === "on" || e === "1" || e === "true") return true;
  return guardJson?.enabled === true;
}

/** Verify command for a shell that has no plugin bundle in reach. */
export const GLOBAL_VERIFY_COMMAND = "semctx verify diff --record";

/** POSIX single-quote: safe for spaces, `$`, backticks, and embedded quotes. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * Absolute path of the plugin-bundled CLI, or null when no bundle is in reach.
 *
 * Claude Code exports CLAUDE_PLUGIN_ROOT to *hook processes* (and to MCP/LSP subprocesses) — it is
 * NOT exported to the agent's shell, and `${CLAUDE_PLUGIN_ROOT}` is a load-time placeholder for
 * skill/hook/MCP fields only. A guard reason string is neither, so the path must be resolved here.
 * Falls back to this hook's own location so a plugin copy without the env var still works.
 */
export function pluginCliPath(env = process.env, exists = existsSync) {
  const candidates = [];
  const declared = String(env?.CLAUDE_PLUGIN_ROOT ?? "").trim();
  if (declared) candidates.push(join(declared, "dist", "semctx.js"));
  candidates.push(resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "semctx.js"));
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // unreadable candidate: fall through to the next one
    }
  }
  return null;
}

/**
 * Whether a `bun` executable is on PATH. Directory probe only — the guard must stay fast and
 * side-effect free, so it never spawns a process to answer this.
 */
export function bunOnPath(env = process.env, exists = existsSync) {
  const entries = String(env?.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const names = process.platform === "win32" ? ["bun.exe", "bun.cmd", "bun"] : ["bun"];
  for (const entry of entries) {
    if (!entry) continue;
    for (const name of names) {
      try {
        if (exists(join(entry, name))) return true;
      } catch {
        // unreadable PATH entry: keep probing
      }
    }
  }
  return false;
}

/**
 * Prefer the plugin-bundled CLI (same release as the MCP runtime) and emit it as an ALREADY
 * RESOLVED, shell-quoted absolute path — the agent runs this string in a shell that does not
 * receive CLAUDE_PLUGIN_ROOT, so a deferred `"$CLAUDE_PLUGIN_ROOT/…"` would expand to `/dist/…`.
 * Fall back to a global `semctx` when no bundle is in reach, or when Bun is absent: this hook runs
 * under Node precisely so guarded mode works on Bun-less machines, and a block message must never
 * name a runtime the user does not have.
 */
export function verifyRecordCommand(env = process.env, exists = existsSync) {
  const cli = pluginCliPath(env, exists);
  if (!cli || !bunOnPath(env, exists)) return GLOBAL_VERIFY_COMMAND;
  return `bun ${shellQuote(cli)} verify diff --record`;
}

/**
 * Pure decision — reads no environment and touches no filesystem.
 * ctx: { enabled, terminalVerb, commandIsolated?, state|null, currentState|null, verifyCommand? }.
 */
export function guardDecision(ctx) {
  if (!ctx.enabled || !ctx.terminalVerb) return { block: false };
  const verifyCmd = ctx.verifyCommand ?? GLOBAL_VERIFY_COMMAND;
  const retry = `then retry the ${ctx.terminalVerb}. (strictly disable: SEMCTX_GUARD=off)`;
  if (ctx.commandIsolated === false) {
    return {
      block: true,
      reason: `semctx guarded mode: git ${ctx.terminalVerb} must be an isolated command; compound commands, shell substitutions, redirections, unexpanded cwd paths, and Git repository retargeting are not authorized.\n${retry}`,
    };
  }
  if (ctx.terminalVerb === "push" && ctx.pushSourceAuthorized === false) {
    return {
      block: true,
      reason: `semctx guarded mode: git push may publish only the verified HEAD; deletion, multi-ref, mirror, tag-wide, wildcard, configured, and ambiguous pushes are not authorized.\n${retry}`,
    };
  }
  if (!ctx.state) {
    return { block: true, reason: `semctx guarded mode: no verification on record. Run:\n  ${verifyCmd}\n${retry}` };
  }
  if (ctx.terminalVerb === "commit" && ctx.commitHooksAbsent === false) {
    return {
      block: true,
      reason: "semctx guarded mode: repository commit hooks can change the index after verification; disable pre-commit, prepare-commit-msg, and commit-msg hooks, then retry the commit.",
    };
  }
  if (ctx.terminalVerb === "push" && ctx.pushHooksAbsent === false) {
    return {
      block: true,
      reason: "semctx guarded mode: a repository pre-push hook can execute unverified side effects; disable the pre-push hook, then retry the push.",
    };
  }
  if (!isGuardVerificationState(ctx.state) || !ctx.currentState) {
    return { block: true, reason: `semctx guarded mode: the verification baseline is legacy, invalid, or unavailable. Re-run:\n  ${verifyCmd}\n${retry}` };
  }
  if (ctx.state.verdict === "BLOCK") {
    return { block: true, reason: `semctx guarded mode: the last verification was BLOCK. Resolve the findings, then re-run:\n  ${verifyCmd}` };
  }
  const sameAnalyzedContent = ctx.state.contentStateHash === ctx.currentState.contentStateHash
    && ctx.state.repositoryStateHash === ctx.currentState.repositoryStateHash;
  const exactCommittedContent = ctx.currentState.headTreeHash === ctx.state.repositoryStateHash;
  const exactStagedContent = ctx.currentState.indexStateHash === ctx.state.repositoryStateHash;
  if (
    !sameAnalyzedContent
    || (ctx.terminalVerb === "commit" && (ctx.commitContentAuthorized === false || !exactStagedContent))
    || (ctx.terminalVerb === "push" && !exactCommittedContent)
  ) {
    return { block: true, reason: `semctx guarded mode: the analyzed content changed or the commit does not exactly materialize it. Re-run:\n  ${verifyCmd}\n${retry}` };
  }
  return { block: false };
}

/** Reject authored or corrupted baselines unless every persisted v3 field has its exact public shape. */
export function isGuardVerificationState(state) {
  const sha256 = /^sha256:[0-9a-f]{64}$/;
  return typeof state === "object"
    && state !== null
    && state.version === 3
    && typeof state.headCommit === "string"
    && /^[0-9a-f]{40,64}$/.test(state.headCommit)
    && typeof state.analyzedSourceHash === "string"
    && sha256.test(state.analyzedSourceHash)
    && typeof state.workingStateHash === "string"
    && sha256.test(state.workingStateHash)
    && typeof state.contentStateHash === "string"
    && sha256.test(state.contentStateHash)
    && typeof state.repositoryStateHash === "string"
    && sha256.test(state.repositoryStateHash)
    && typeof state.indexStateHash === "string"
    && sha256.test(state.indexStateHash)
    && typeof state.headTreeHash === "string"
    && sha256.test(state.headTreeHash)
    && (state.verdict === "PASS" || state.verdict === "WARN" || state.verdict === "BLOCK")
    && typeof state.recordedAt === "string"
    && Number.isFinite(Date.parse(state.recordedAt));
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

function normalizedPath(path) {
  return path.replace(/\\/g, "/");
}

function sortedPaths(paths) {
  return [...paths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function trackedIndexEntries(cwd) {
  const skipWorktree = new Set(execFileSync("git", ["ls-files", "-v", "-z", "--", "."], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).split("\0").filter((record) => record.startsWith("S ")).map((record) => normalizedPath(record.slice(2))));
  const records = execFileSync("git", ["ls-files", "--stage", "-z", "--", "."], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const entries = new Map();
  for (const record of records.split("\0")) {
    if (!record) continue;
    const match = /^([0-9]{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("invalid index entry");
    if (match[3] !== "0") throw new Error(`unmerged index entry: ${match[4]}`);
    const path = normalizedPath(match[4]);
    entries.set(path, { mode: match[1], objectId: match[2], skipWorktree: skipWorktree.has(path) });
  }
  return entries;
}

function objectPayload(cwd, objectId) {
  return execFileSync("git", ["cat-file", "blob", objectId], {
    cwd,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function hashObject(cwd, path, payload) {
  const objectId = execFileSync("git", ["hash-object", `--path=${path}`, "--stdin"], {
    cwd,
    input: payload,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
  if (!/^[0-9a-f]{40,64}$/.test(objectId)) throw new Error(`invalid object id: ${path}`);
  return objectId;
}

function unstagedPaths(cwd) {
  const records = execFileSync("git", ["diff", "--name-only", "-z", "--relative", "--no-ext-diff", "--no-textconv", "--", "."], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return new Set(records.split("\0").filter(Boolean).map(normalizedPath));
}

function captureRepositoryStateHash(entries) {
  const ordered = [...entries].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const hash = createHash("sha256");
  frame(hash, "domain", "semctx:verification-repository-state:v1");
  for (const entry of ordered) {
    frame(hash, "path", entry.path);
    frame(hash, "mode", entry.mode);
    frame(hash, "object", entry.objectId);
  }
  return `sha256:${hash.digest("hex")}`;
}

function captureIndexStateHash(tracked) {
  return captureRepositoryStateHash([...tracked].map(([path, entry]) => ({ path, ...entry })));
}

function initializedGitlinkHead(cwd, path) {
  const absolute = resolve(cwd, path);
  const materialized = lstatIfPresent(absolute);
  if (!materialized) return undefined;
  if (materialized.isSymbolicLink()) {
    throw new Error(`symlinked gitlink verification input is unsupported: ${path}`);
  }
  const gitMarkerPresent = Boolean(lstatIfPresent(resolve(absolute, ".git")));
  const topLevel = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  });
  if (topLevel.status !== 0) {
    if (gitMarkerPresent) throw new Error(`cannot resolve initialized gitlink repository: ${path}`);
    return undefined;
  }
  if (realpathSync.native(topLevel.stdout.trim()) !== realpathSync.native(absolute)) return undefined;
  const result = spawnSync("git", ["-C", path, "rev-parse", "--verify", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`cannot resolve initialized gitlink HEAD: ${path}`);
  const head = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error(`invalid initialized gitlink HEAD: ${path}`);
  return head;
}

function captureHeadTreeHash(cwd) {
  const records = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const entries = [];
  for (const record of records.split("\0")) {
    if (!record) continue;
    const match = /^([0-9]{6}) (?:blob|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("invalid HEAD tree entry");
    entries.push({ path: normalizedPath(match[3]), mode: match[1], objectId: match[2] });
  }
  return captureRepositoryStateHash(entries);
}

function captureContentState(cwd, tracked, untracked, changedOutsideIndex) {
  const contentHash = createHash("sha256");
  const repositoryHash = createHash("sha256");
  frame(contentHash, "domain", "semctx:verification-content-state:v1");
  frame(repositoryHash, "domain", "semctx:verification-repository-state:v1");
  const paths = sortedPaths(new Set([...tracked.keys(), ...untracked.map(normalizedPath)]));
  for (const path of paths) {
    const indexEntry = tracked.get(path);
    if (indexEntry?.mode === "160000") {
      const materializedHead = initializedGitlinkHead(cwd, path);
      if (changedOutsideIndex.has(path) || (materializedHead && materializedHead !== indexEntry.objectId)) {
        throw new Error(`changed gitlink verification input is unsupported: ${path}`);
      }
      frame(contentHash, "path", path);
      frame(contentHash, "mode", indexEntry.mode);
      frame(contentHash, "gitlink", indexEntry.objectId);
      frame(repositoryHash, "path", path);
      frame(repositoryHash, "mode", indexEntry.mode);
      frame(repositoryHash, "object", indexEntry.objectId);
      continue;
    }
    const absolute = resolve(cwd, path);
    const stat = lstatIfPresent(absolute);
    if (!stat && !indexEntry?.skipWorktree) continue;
    let mode;
    let kind;
    let payload;
    if (!stat && indexEntry) {
      mode = indexEntry.mode;
      kind = mode === "120000" ? "symlink" : "file";
      payload = objectPayload(cwd, indexEntry.objectId);
    } else if (indexEntry?.mode === "120000") {
      mode = "120000";
      kind = "symlink";
      payload = stat.isSymbolicLink()
        ? Buffer.from(readlinkSync(absolute), "utf8")
        : readFileSync(absolute);
    } else if (stat.isSymbolicLink()) {
      mode = "120000";
      kind = "symlink";
      payload = Buffer.from(readlinkSync(absolute), "utf8");
    } else if (stat.isFile()) {
      mode = process.platform === "win32"
        ? indexEntry?.mode === "100755" ? "100755" : "100644"
        : (stat.mode & 0o111) === 0 ? "100644" : "100755";
      kind = "file";
      payload = readFileSync(absolute);
    } else {
      throw new Error(`unsupported verification input: ${path}`);
    }
    frame(contentHash, "path", path);
    frame(contentHash, "mode", mode);
    frame(contentHash, "kind", kind);
    frame(contentHash, "content", payload);
    const objectId = !stat && indexEntry && indexEntry.mode === mode && !changedOutsideIndex.has(path)
      ? indexEntry.objectId
      : hashObject(cwd, path, payload);
    frame(repositoryHash, "path", path);
    frame(repositoryHash, "mode", mode);
    frame(repositoryHash, "object", objectId);
  }
  return {
    contentStateHash: `sha256:${contentHash.digest("hex")}`,
    repositoryStateHash: `sha256:${repositoryHash.digest("hex")}`,
  };
}

function fingerprintVerificationSource(headCommit, diff) {
  const hash = createHash("sha256");
  frame(hash, "domain", "semctx:verification-analyzed-source:v1");
  frame(hash, "head", headCommit);
  frame(hash, "diff", diff);
  return `sha256:${hash.digest("hex")}`;
}

/** Capture the same commit, content bytes, paths and modes recorded by `semctx verify diff --record`. */
export function captureVerificationGitState(cwd) {
  const headCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const analyzedDiff = execFileSync("git", ["diff", "--relative", "--unified=0", "--no-color", "--no-ext-diff", "--no-textconv", headCommit, "--"], {
    cwd,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  const diff = execFileSync("git", ["diff", "HEAD", "--relative", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--", "."], {
    cwd,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).split("\0").filter(Boolean).map(normalizedPath).sort();
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
  const tracked = trackedIndexEntries(cwd);
  return {
    headCommit,
    analyzedSourceHash: fingerprintVerificationSource(headCommit, new TextDecoder().decode(analyzedDiff)),
    workingStateHash: `sha256:${hash.digest("hex")}`,
    ...captureContentState(cwd, tracked, untracked, unstagedPaths(cwd)),
    indexStateHash: captureIndexStateHash(tracked),
    headTreeHash: captureHeadTreeHash(cwd),
  };
}

/**
 * Host-neutral evaluation of one shell tool call. Claude's `main()` and the Oh My Pi `tool_call`
 * adapter both call this, so the two hosts cannot drift apart. `toolName` is compared
 * case-insensitively to `bash` (Claude sends `Bash`, Oh My Pi sends `bash`).
 * @returns {{ block: true, reason: string } | { block: false }}
 */
export function evaluateBashGuard({ toolName, command, cwd: inputCwd, env = process.env }) {
  if (String(toolName ?? "").toLowerCase() !== "bash") return { block: false };
  const terminalVerb = isTerminalGitCommand(command);
  if (!terminalVerb) return { block: false };

  const rawCwd = inputCwd ?? process.cwd();
  const commandIsolated = isIsolatedTerminalGitCommand(command);
  const scopeRequiresSessionGuard = gitScopeRequiresSessionGuard(command);
  const sessionCwd = resolveGitRoot(rawCwd);
  const cwd = resolveGitRoot(resolveGitCwd(command, rawCwd)); // the repo the git command targets, not the session cwd
  const targetGuard = readJson(join(cwd, ".semctx", "guard.json"));
  const sessionGuard = scopeRequiresSessionGuard
    ? readJson(join(sessionCwd, ".semctx", "guard.json"))
    : null;
  const enabled = guardEnabled(env, targetGuard)
    || (scopeRequiresSessionGuard && guardEnabled(env, sessionGuard));
  if (!enabled) return { block: false }; // advisory (default)

  const state = commandIsolated
    ? readJson(join(cwd, ".semctx", "verification-state.json"))
    : null;
  let currentState = null;
  if (commandIsolated) {
    try {
      currentState = captureVerificationGitState(cwd);
    } catch {
      currentState = null;
    }
  }
  const pushSourceAuthorized = terminalVerb !== "push"
    || (currentState !== null && pushSourceMatchesHead(command, cwd, currentState.headCommit));
  const commitContentAuthorized = terminalVerb !== "commit" || commitUsesWholeIndex(command);
  const commitHooksAbsent = terminalVerb !== "commit" || (commandIsolated && commitHookSurfaceClear(cwd));
  const pushHooksAbsent = terminalVerb !== "push" || (commandIsolated && pushHookSurfaceClear(cwd));
  return guardDecision({
    enabled,
    terminalVerb,
    commandIsolated,
    pushSourceAuthorized,
    commitContentAuthorized,
    commitHooksAbsent,
    pushHooksAbsent,
    state,
    currentState,
    verifyCommand: verifyRecordCommand(env),
  });
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // no/invalid input → do not block
  }
  const decision = evaluateBashGuard({
    toolName: input.tool_name ?? input.toolName,
    command: input.tool_input?.command ?? input.toolInput?.command ?? "",
    cwd: input.cwd ?? process.cwd(),
    env: process.env,
  });
  if (decision.block) {
    process.stderr.write(decision.reason + "\n");
    process.exit(2); // PreToolUse: non-zero (2) blocks the tool and surfaces stderr to the agent
  }
  process.exit(0);
}

if (process.argv[1]?.endsWith("semctx-guard.mjs")) main();
