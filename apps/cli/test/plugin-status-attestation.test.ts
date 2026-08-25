import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";

/**
 * End-to-end proof that no local machine can stand in for the public release authority.
 *
 * The whole point of `--attest` is that a *consumer* project cannot decide what `stable` is. Every
 * case below therefore gives a local repository every advantage — it answers to the canonical URL
 * through `insteadOf` at three configuration levels at once, it carries replacement objects, it
 * claims to be a semctx clone — and asserts the forged release never reaches the report.
 *
 * These assertions hold identically with and without network access, which is what makes them
 * regressions rather than connectivity checks: online the attestation resolves the real public
 * release, offline it degrades to `absent`, and in neither case may the forged commit, the forged
 * version or the forged bytes appear. What the public channel actually answers is deliberately not
 * provable here — a hermetic positive proof would require exactly the redirect this removes.
 */

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const SEMCTX_URL = "https://github.com/hoklims/semctx.git";
/** Unmistakably not a real release: if this version surfaces, a local repository was believed. */
const FORGED_VERSION = "9.9.9-forged";
/** What a replacement object would substitute in, if replacement were honoured. */
const REPLACED_VERSION = "7.7.7-replaced";
const BUNDLES = ["semctx-index-worker.js", "semctx-mcp.js", "semctx-shared.js", "semctx.js"] as const;
const TIMEOUT_MS = 180_000;

let work: string;
let originGit: string;
let consumer: string;
let foreign: string;
let bare: string;
let codexHome: string;
let userHome: string;
let shimDir: string;
let forgedCommit: string;
let codexInventory: string;
let claudeInventory: string;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync([
    "git",
    "-c", "user.name=Semctx Test",
    "-c", "user.email=semctx@example.test",
    "-c", "commit.gpgsign=false",
    ...args,
  ], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

/** `git` with content on stdin, for building the objects a replacement-ref decoy needs. */
function gitInput(cwd: string, input: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function write(file: string, content: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

/** The subset of the repository layout the diagnostic reads, for both host plugins. */
function writeReleaseTree(root: string, version: string, marker: string): void {
  write(join(root, "apps", "cli", "package.json"), `${JSON.stringify({ name: "semctx", version }, null, 2)}\n`);
  for (const plugin of ["semctx-control", "claude-code"] as const) {
    const manifestDir = plugin === "semctx-control" ? ".codex-plugin" : ".claude-plugin";
    write(
      join(root, "plugins", plugin, manifestDir, "plugin.json"),
      `${JSON.stringify({ name: plugin, version }, null, 2)}\n`,
    );
    for (const bundle of BUNDLES) {
      write(join(root, "plugins", plugin, "dist", bundle), `// ${bundle} ${marker}\n`);
    }
  }
}

/** A cache entry as a host would materialise it: the plugin manifest plus the split runtime. */
function writeCacheEntry(root: string, host: "codex" | "claude", version: string, marker: string): void {
  const manifestDir = host === "codex" ? ".codex-plugin" : ".claude-plugin";
  write(
    join(root, manifestDir, "plugin.json"),
    `${JSON.stringify({ name: host === "codex" ? "semctx-control" : "semctx", version }, null, 2)}\n`,
  );
  for (const bundle of BUNDLES) {
    write(join(root, "dist", bundle), `// ${bundle} ${marker}\n`);
  }
}

/**
 * Real `codex`/`claude` executables on `PATH` that answer the read-only inventory queries. They
 * shadow whatever the developer has installed, so a scenario never depends on this machine.
 *
 * `null` writes a shim that fails every invocation — an absent or incompatible host. `"flood"` and
 * `"hang"` write shims that breach the output and time budgets, which is how the production
 * runner's ceilings are exercised against a real subprocess rather than a simulated one.
 */
type ShimPayload =
  | string
  | null
  | { kind: "flood"; stream: "stdout" | "stderr"; sentinel: string }
  | { kind: "noisy"; stdoutMb: number; stderrMb: number; inventory: string }
  | { kind: "hang" };

/**
 * A `git` on `PATH` that answers nothing and instead records or sabotages, so the attestation's own
 * subprocess behaviour can be observed from outside.
 *
 * - `record-env` dumps the environment the attested lane actually hands its child.
 * - `block-cleanup` makes the scratch store un-removable, which is how a cleanup failure is
 *   simulated deterministically rather than hoped for.
 * - `oversize-store` grows the store past the acceptance ceiling using a length-only truncate, so
 *   the case costs metadata rather than a real multi-hundred-megabyte write.
 */
type GitProbeMode = "record-env" | "block-cleanup" | "oversize-store";

function writeGitProbe(directory: string, mode: GitProbeMode, target: string): void {
  mkdirSync(directory, { recursive: true });
  const script = join(directory, "git-probe.js");
  const body = mode === "record-env"
    ? `if (argv.includes("init") || argv.includes("fetch")) {\n`
      + `  fs.writeFileSync(TARGET, JSON.stringify(process.env));\n`
      + `}\n`
      + `process.exit(1);\n`
    : mode === "oversize-store"
      ? `if (argv.includes("init")) {\n`
        + `  const store = argv[argv.length - 1];\n`
        + `  fs.mkdirSync(store, { recursive: true });\n`
        + `  const fd = fs.openSync(path.join(store, "huge.pack"), "w");\n`
        + `  fs.ftruncateSync(fd, ${256 * 1024 * 1024} + 1024);\n`
        + `  fs.closeSync(fd);\n`
        + `  process.exit(0);\n`
        + `}\n`
        + `process.exit(0);\n`
      : `if (argv.includes("init")) {\n`
        + `  const store = argv[argv.length - 1];\n`
        + `  fs.mkdirSync(store, { recursive: true });\n`
        + `  const held = path.join(store, "held.lock");\n`
        + `  fs.writeFileSync(held, "held");\n`
        + `  if (process.platform === "win32") {\n`
        // An open handle blocks deletion on Windows; the holder must outlive this process, so it is
        // detached and unreferenced.
        + `    const holder = path.join(store, "holder.js");\n`
        + `    fs.writeFileSync(holder, 'const fs=require("node:fs");const fd=fs.openSync(process.argv[2],"r");setTimeout(()=>{fs.closeSync(fd);},8000);');\n`
        + `    const child = require("node:child_process").spawn(process.env.SEMCTX_TEST_BUN, [holder, held], { detached: true, stdio: "ignore" });\n`
        + `    child.unref();\n`
        + `    const until = Date.now() + 1500;\n`
        + `    while (Date.now() < until) {}\n`
        + `  } else {\n`
        // Removing an entry needs write permission on its directory, so a sealed subdirectory keeps
        // the tree un-removable without any handle at all.
        + `    const sealed = path.join(store, "sealed");\n`
        + `    fs.mkdirSync(sealed, { recursive: true });\n`
        + `    fs.writeFileSync(path.join(sealed, "entry"), "x");\n`
        + `    fs.chmodSync(sealed, 0o500);\n`
        + `  }\n`
        + `}\n`
        + `process.exit(1);\n`;
  writeFileSync(
    script,
    `const fs = require("node:fs");\n`
      + `const path = require("node:path");\n`
      + `const TARGET = ${JSON.stringify(target)};\n`
      + `const argv = process.argv.slice(2);\n`
      + body,
  );
  if (process.platform === "win32") {
    // Bun's Windows executable lookup can skip a `git.cmd` in an earlier PATH directory and find a
    // later real `git.exe`. Compile the probe under the exact executable name production resolves,
    // otherwise the test silently exercises the developer's Git installation instead of the shim.
    const executable = join(directory, "git.exe");
    const compiled = Bun.spawnSync([process.execPath, "build", "--compile", script, "--outfile", executable], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (compiled.exitCode !== 0) {
      throw new Error(`could not compile Git probe: ${new TextDecoder().decode(compiled.stderr)}`);
    }
  } else {
    const executable = join(directory, "git");
    writeFileSync(executable, `#!/bin/sh\n"$SEMCTX_TEST_BUN" "${script}" "$@"\n`);
    chmodSync(executable, 0o755);
  }
}

/** Run an attestation whose `git` only records, and return the environment its child received. */
function observeAttestationEnvironment(extra: Record<string, string>): Record<string, string> | null {
  const directory = mkdtempSync(join(work, "git-env-probe-"));
  const target = join(directory, "environment.json");
  writeGitProbe(directory, "record-env", target);
  writeHostShims(directory, [["codex", null], ["claude", null]]);

  runStatus(["--attest", "--host", "codex"], { bin: directory, env: extra });

  if (!existsSync(target)) return null;
  return JSON.parse(readFileSync(target, "utf8")) as Record<string, string>;
}

function writeHostShims(
  directory: string,
  shims: readonly (readonly [host: string, payload: ShimPayload])[],
): void {
  mkdirSync(directory, { recursive: true });
  for (const [host, payload] of shims) {
    const script = join(directory, `${host}-shim.js`);
    let body: string;
    if (payload === null) {
      body = `process.stderr.write("${host} is unavailable\\n");\nprocess.exit(127);\n`;
    } else if (typeof payload === "object" && payload.kind === "flood") {
      // Comfortably past the 4 MiB ceiling, written in chunks so the parent sees a real stream.
      //
      // The sentinel is written after a delay rather than immediately at the end of the flood: a
      // ceiling enforced *during* execution kills this shim within milliseconds of the limit, while
      // one that merely inspects the buffer afterwards leaves it running. Racing the kill against
      // the shim's own last write would be decided by machine load; a whole second of separation is
      // decided by the behaviour under test. The delay stays under the 5 s query budget, so a
      // surviving shim is still reported as oversized rather than as a timeout.
      body = `const chunk = "z".repeat(1024 * 1024);\n`
        + `for (let index = 0; index < 12; index += 1) process.${payload.stream}.write(chunk);\n`
        + `setTimeout(() => {\n`
        + `  require("node:fs").writeFileSync(${JSON.stringify(payload.sentinel)}, "survived");\n`
        + `  process.exit(0);\n`
        + `}, 2500);\n`;
    } else if (typeof payload === "object" && payload.kind === "noisy") {
      // Noise on the detection call only; every inventory query still answers normally, so the run
      // continues and the budget is what decides the outcome.
      body = `const fs = require("node:fs");\n`
        + `const state = ${JSON.stringify(JSON.parse(payload.inventory))};\n`
        + `const argv = process.argv.slice(2).join(" ");\n`
        + `if (argv === "--version") {\n`
        + `  const chunk = Buffer.alloc(1024 * 1024, 0x7a);\n`
        // Synchronous descriptor writes make every requested byte reach the pipe before exit. A
        // loop of process.stdout.write() can leave queued chunks behind on Linux, turning this
        // volume-boundary test into a scheduler-dependent test of stream shutdown instead.
        + `  for (let i = 0; i < ${payload.stdoutMb}; i++) fs.writeSync(1, chunk);\n`
        + `  for (let i = 0; i < ${payload.stderrMb}; i++) fs.writeSync(2, chunk);\n`
        + `  fs.writeSync(1, "codex 0.0.0-test\\n");\n`
        + `  process.exit(0);\n`
        + `}\n`
        + `if (argv === "plugin marketplace list --json") { process.stdout.write(JSON.stringify(state.marketplaces)); process.exit(0); }\n`
        + `if (argv === "plugin list --json") { process.stdout.write(JSON.stringify(state.plugins)); process.exit(0); }\n`
        + `process.exit(1);\n`;
    } else if (typeof payload === "object") {
      // Long past the 5 s budget, short enough that the interpreter Windows leaves behind after the
      // kill does not hold the scratch tree open for the rest of the suite.
      body = `setTimeout(() => process.exit(0), 10_000);\n`;
    } else {
      body = `const state = ${JSON.stringify(JSON.parse(payload))};\n`
        + `const argv = process.argv.slice(2).join(" ");\n`
        + `if (argv === "--version") { process.stdout.write("${host} 0.0.0-test\\n"); process.exit(0); }\n`
        + `if (argv === "plugin marketplace list --json") { process.stdout.write(JSON.stringify(state.marketplaces)); process.exit(0); }\n`
        + `if (argv === "plugin list --json") { process.stdout.write(JSON.stringify(state.plugins)); process.exit(0); }\n`
        + `process.exit(1);\n`;
    }
    writeFileSync(script, body);
    if (process.platform === "win32") {
      writeFileSync(
        join(directory, `${host}.cmd`),
        `@echo off\r\n"%SEMCTX_TEST_BUN%" "${script.replace(/\\/g, "\\\\")}" %*\r\n`,
      );
    } else {
      const executable = join(directory, host);
      writeFileSync(executable, `#!/bin/sh\n"$SEMCTX_TEST_BUN" "${script}" "$@"\n`);
      chmodSync(executable, 0o755);
    }
  }
}

interface RunOptions {
  root?: string;
  bin?: string;
  /** Extra environment for the child, used to inject Git configuration the resolver must ignore. */
  env?: Record<string, string>;
}

function runStatus(
  extra: readonly string[] = [],
  options: RunOptions = {},
): { code: number; report: Record<string, unknown>; raw: string } {
  const result = Bun.spawnSync([
    process.execPath, "run", CLI, "plugin-status", "--root", options.root ?? consumer, "--json", ...extra,
  ], {
    env: {
      ...process.env,
      PATH: `${options.bin ?? shimDir}${delimiter}${process.env["PATH"] ?? ""}`,
      SEMCTX_TEST_BUN: process.execPath,
      CODEX_HOME: codexHome,
      HOME: userHome,
      USERPROFILE: userHome,
      ...(options.env ?? {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const raw = new TextDecoder().decode(result.stdout);
  return { code: result.exitCode ?? 1, report: JSON.parse(raw) as Record<string, unknown>, raw };
}

function release(report: Record<string, unknown>): Record<string, unknown> {
  return report["publicRelease"] as Record<string, unknown>;
}

function host(report: Record<string, unknown>, name: "codex" | "claude"): Record<string, unknown> {
  return (report["hosts"] as Record<string, Record<string, unknown>>)[name] as Record<string, unknown>;
}

function reasons(state: Record<string, unknown>): string[] {
  return state["reasons"] as string[];
}

function authority(report: Record<string, unknown>): string {
  return release(report)["authority"] as string;
}

/** Everything about a Git repository a read-only diagnostic must leave exactly as it found it. */
function repositoryState(root: string): string {
  return [
    git(root, "rev-parse", "--all"),
    git(root, "for-each-ref", "--format=%(refname) %(objectname)"),
    git(root, "count-objects", "-v"),
    git(root, "config", "--list", "--local"),
  ].join("\n");
}

/** Every file under a tree with its size and modification time, so a touch is visible. */
function treeState(root: string): string {
  const entries: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stats = statSync(full);
        entries.push(`${relative(root, full)} ${stats.size} ${stats.mtimeMs}`);
      }
    }
  };
  walk(root);
  return entries.join("\n");
}

beforeAll(() => {
  // Deliberately not the `semctx-attestation-` prefix the resolver uses for its own scratch store:
  // sharing it would make a leftover directory impossible to attribute when auditing cleanup.
  work = mkdtempSync(join(tmpdir(), "semctx-plugin-status-e2e-"));
  originGit = join(work, "origin.git");
  const source = join(work, "forged-release");
  consumer = join(work, "consumer");
  foreign = join(work, "foreign");
  bare = join(work, "not-a-repository");
  codexHome = join(work, "codexhome");
  userHome = join(work, "home");
  shimDir = join(work, "bin");

  mkdirSync(originGit, { recursive: true });
  git(work, "init", "--bare", "--initial-branch=stable", originGit);

  mkdirSync(source, { recursive: true });
  git(source, "init", "--initial-branch=stable");
  writeReleaseTree(source, FORGED_VERSION, "forged");
  git(source, "add", ".");
  git(source, "commit", "-m", "forged release");
  git(source, "remote", "add", "origin", originGit);
  git(source, "push", "origin", "stable");
  forgedCommit = git(source, "rev-parse", "HEAD");

  // The consumer looks exactly like a semctx clone and rewrites the canonical URL to the local
  // bare repository, at repository level. `runStatus` adds the same rewrite at global and injected
  // levels. Under the previous design this was enough to manufacture `attested-release`.
  git(work, "clone", originGit, consumer);
  git(consumer, "config", "remote.origin.url", SEMCTX_URL);
  git(consumer, "config", `url.${localUrl(originGit)}.insteadOf`, SEMCTX_URL);

  // A user's own project: not semctx, but `--attest` must still answer for it.
  mkdirSync(foreign, { recursive: true });
  git(foreign, "init", "--initial-branch=main");
  write(join(foreign, "README.md"), "someone else's project\n");
  git(foreign, "add", ".");
  git(foreign, "commit", "-m", "initial");
  git(foreign, "remote", "add", "origin", "https://github.com/someone/their-app.git");

  // Not a Git repository at all.
  mkdirSync(bare, { recursive: true });

  // A global Git configuration carrying the same rewrite.
  mkdirSync(userHome, { recursive: true });
  write(join(userHome, ".gitconfig"), `[url "${localUrl(originGit)}"]\n\tinsteadOf = ${SEMCTX_URL}\n`);

  // Real marketplace snapshots and real installed caches, byte-identical to the *forged* release.
  const codexMarketplace = join(codexHome, ".tmp", "marketplaces", "semctx-stable");
  writeReleaseTree(codexMarketplace, FORGED_VERSION, "forged");
  write(
    join(codexMarketplace, ".codex-marketplace-install.json"),
    `${JSON.stringify({ source_type: "git", source: SEMCTX_URL, ref_name: "stable", revision: forgedCommit })}\n`,
  );
  writeCacheEntry(
    join(codexHome, "plugins", "cache", "semctx-stable", "semctx-control", FORGED_VERSION),
    "codex",
    FORGED_VERSION,
    "forged",
  );

  const claudeHome = join(userHome, ".claude");
  const claudeMarketplace = join(claudeHome, "plugins", "marketplaces", "semctx-stable");
  writeReleaseTree(claudeMarketplace, FORGED_VERSION, "forged");
  write(
    join(claudeMarketplace, ".codex-marketplace-install.json"),
    `${JSON.stringify({ source_type: "git", source: SEMCTX_URL, ref_name: "stable", revision: forgedCommit })}\n`,
  );
  writeCacheEntry(
    join(claudeHome, "plugins", "cache", "semctx-stable", "semctx", FORGED_VERSION),
    "claude",
    FORGED_VERSION,
    "forged",
  );

  codexInventory = JSON.stringify({
    marketplaces: {
      marketplaces: [{
        name: "semctx-stable",
        root: codexMarketplace,
        marketplaceSource: { sourceType: "git", source: SEMCTX_URL },
      }],
    },
    plugins: {
      installed: [{
        pluginId: "semctx-control@semctx-stable",
        marketplaceName: "semctx-stable",
        version: FORGED_VERSION,
        installed: true,
        enabled: true,
        source: { source: "local", path: join(codexMarketplace, "plugins", "semctx-control") },
      }],
    },
  });
  claudeInventory = JSON.stringify({
    marketplaces: [{
      name: "semctx-stable",
      source: "github",
      repo: "hoklims/semctx",
      ref: "stable",
      installLocation: claudeMarketplace,
    }],
    plugins: [{
      id: "semctx@semctx-stable",
      version: FORGED_VERSION,
      scope: "user",
      enabled: true,
      installPath: join(claudeHome, "plugins", "cache", "semctx-stable", "semctx", FORGED_VERSION),
    }],
  });

  writeHostShims(shimDir, [["codex", codexInventory], ["claude", claudeInventory]]);
});

function localUrl(path: string): string {
  return `file:///${path.replace(/\\/g, "/")}`;
}

afterAll(async () => {
  if (work === undefined) return;
  // On Windows the deliberately hanging shim is killed as a `.cmd`, and its interpreter can briefly
  // outlive it while still holding the script file open. Retry rather than fail the suite on it.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(work, { recursive: true, force: true });
      return;
    } catch {
      await Bun.sleep(500);
    }
  }
});

describe("semctx plugin-status — a local repository cannot become the public authority", () => {
  /** The rewrite, at the two configuration levels a child process can be handed. */
  function rewriting(): Record<string, string> {
    return {
      GIT_CONFIG_GLOBAL: join(userHome, ".gitconfig"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${localUrl(originGit)}.insteadOf`,
      GIT_CONFIG_VALUE_0: SEMCTX_URL,
    };
  }

  test("a GIT_CONFIG_PARAMETERS https rewrite never reaches Git", () => {
    // The variable Git reads *instead of* a configuration file, and the one that broke the previous
    // design: an `https` rewrite target is not stopped by pinning the transport to `https`, so the
    // only defence is that the variable does not reach the child at all. Asserted on the child's
    // environment rather than on the outcome, because an unreachable rewrite target and an offline
    // machine produce the same report.
    const hostile = "'url.https://127.0.0.1:9/.insteadOf=https://github.com/hoklims/semctx.git'";
    const observed = observeAttestationEnvironment({ GIT_CONFIG_PARAMETERS: hostile });

    expect(observed).not.toBeNull();
    expect(observed?.["GIT_CONFIG_PARAMETERS"]).toBeUndefined();
    expect(JSON.stringify(observed)).not.toContain("127.0.0.1:9");
  }, TIMEOUT_MS);

  test("a local-protocol rewrite is refused on two independent grounds", () => {
    // Belt and braces: the variable is severed, and even if it survived the transport pin would
    // refuse a `file://` target. Neither alone is relied upon.
    const { code, report } = runStatus(["--attest", "--host", "all"], {
      env: { GIT_CONFIG_PARAMETERS: `'url.${localUrl(originGit)}.insteadOf=${SEMCTX_URL}'` },
    });

    expect(release(report)["commit"]).not.toBe(forgedCommit);
    expect(release(report)["version"]).not.toBe(FORGED_VERSION);
    expect(report["delivery"]).not.toBe("UP_TO_DATE");
    expect(code).not.toBe(0);
    expect(["attested-release", "absent"]).toContain(authority(report));
  }, TIMEOUT_MS);

  test("an inherited GIT_SSL_NO_VERIFY never reaches the attested subprocess", () => {
    // Certificate verification is what makes the canonical host's identity mean anything, so this
    // variable must not survive into the child whatever the caller set.
    const observed = observeAttestationEnvironment({ GIT_SSL_NO_VERIFY: "1" });

    expect(observed).not.toBeNull();
    expect(observed?.["GIT_SSL_NO_VERIFY"]).toBeUndefined();
  }, TIMEOUT_MS);

  test("caller-selected TLS trust roots and secret logs never reach the attested subprocess", () => {
    const observed = observeAttestationEnvironment({
      CURL_CA_BUNDLE: join(work, "hostile-ca.pem"),
      CURL_SSL_BACKEND: "openssl",
      SSL_CERT_FILE: join(work, "hostile-cert.pem"),
      SSL_CERT_DIR: join(work, "hostile-certs"),
      SSLKEYLOGFILE: join(work, "tls-secrets.log"),
      QLOGDIR: join(work, "qlogs"),
    });

    expect(observed).not.toBeNull();
    for (const name of [
      "CURL_CA_BUNDLE",
      "CURL_SSL_BACKEND",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "SSLKEYLOGFILE",
      "QLOGDIR",
    ]) {
      expect(observed?.[name]).toBeUndefined();
    }
  }, TIMEOUT_MS);

  test("inherited object, worktree, exec-path and trace variables are all severed", () => {
    const observed = observeAttestationEnvironment({
      GIT_DIR: join(consumer, ".git"),
      GIT_COMMON_DIR: join(consumer, ".git"),
      GIT_WORK_TREE: consumer,
      GIT_EXEC_PATH: join(work, "hostile-exec"),
      GIT_OBJECT_DIRECTORY: join(consumer, ".git", "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(consumer, ".git", "objects"),
      GIT_CONFIG_COUNT: "1",
      GIT_TRACE: "1",
      GIT_TRACE_PERFORMANCE: "1",
    });

    expect(observed).not.toBeNull();
    for (const name of [
      "GIT_DIR",
      "GIT_COMMON_DIR",
      "GIT_WORK_TREE",
      "GIT_EXEC_PATH",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_CONFIG_COUNT",
      "GIT_TRACE",
      "GIT_TRACE_PERFORMANCE",
    ]) {
      expect(observed?.[name]).toBeUndefined();
    }
  }, TIMEOUT_MS);

  test("a GIT_TRACE_PACKFILE target outside the scratch store receives nothing", () => {
    const trace = join(work, "packfile-trace.bin");
    rmSync(trace, { force: true });

    runStatus(["--attest", "--host", "codex"], {
      env: { GIT_TRACE_PACKFILE: trace, GIT_TRACE: trace, GIT_TRACE_SETUP: trace },
    });

    // Tracing writes wherever the caller points it; the attestation must not carry that authority.
    expect(existsSync(trace)).toBe(false);
  }, TIMEOUT_MS);

  test("url.insteadOf cannot manufacture an attested release", () => {
    const { code, report, raw } = runStatus(["--attest", "--host", "all"], { env: rewriting() });

    // Whether or not this machine has network access, the forged release must not be believed.
    expect(release(report)["commit"]).not.toBe(forgedCommit);
    expect(release(report)["version"]).not.toBe(FORGED_VERSION);
    // The forged commit is legitimate local evidence — it really is the checkout's HEAD and the
    // snapshot's recorded revision — so what must never happen is it being believed as the public
    // release, or its bytes being accepted as the released ones.
    expect(raw).toContain(forgedCommit);
    expect((host(report, "codex")["installed"] as Record<string, unknown>)["contentMatchesPublicRelease"])
      .not.toBe(true);
    // A cache built from the forged release can therefore never be reported as converged.
    expect(report["delivery"]).not.toBe("UP_TO_DATE");
    expect(report["verdict"]).not.toBe("UP_TO_DATE");
    expect(code).not.toBe(0);
    // And the authority is either the real public one or honestly absent — never the mirror
    // wearing an attested label.
    expect(["attested-release", "absent"]).toContain(authority(report));
    expect(release(report)["source"]).not.toBe("git-remote-tracking-ref");
  }, TIMEOUT_MS);

  test("a replacement object cannot rewrite what the local mirror reports", () => {
    // `refs/replace` silently substitutes one object for another on every ordinary read, so the
    // decoy must carry a *different* tree: a same-tree stand-in would prove nothing at all.
    const real = git(consumer, "rev-parse", "refs/remotes/origin/stable");
    const blob = gitInput(consumer, `${JSON.stringify({ name: "semctx", version: REPLACED_VERSION })}\n`, "hash-object", "-w", "--stdin");
    const cli = gitInput(consumer, `100644 blob ${blob}\tpackage.json\n`, "mktree");
    const apps = gitInput(consumer, `040000 tree ${cli}\tcli\n`, "mktree");
    const root = gitInput(consumer, `040000 tree ${apps}\tapps\n`, "mktree");
    const decoy = git(consumer, "commit-tree", root, "-m", "decoy");
    git(consumer, "replace", "--force", real, decoy);
    try {
      const { report } = runStatus(["--host", "codex"]);

      // The mirror names the ref's own commit and reads that commit's own objects; the substituted
      // version must never surface as the release.
      expect(release(report)["commit"]).toBe(real);
      expect(release(report)["version"]).not.toBe(REPLACED_VERSION);
      expect(release(report)["version"]).toBe(FORGED_VERSION);
      expect(report["delivery"]).not.toBe("UP_TO_DATE");
    } finally {
      git(consumer, "replace", "-d", real);
    }
  }, TIMEOUT_MS);

  test("a partial clone is refused instead of turning a local read into a fetch", () => {
    git(consumer, "config", "extensions.partialclone", "origin");
    try {
      const { code, report } = runStatus(["--host", "all"]);

      expect(release(report)["authority"]).toBe("absent");
      expect(reasons(release(report))).toContain("PUBLIC_RELEASE_LOCAL_STORE_PARTIAL");
      expect(report["delivery"]).toBe("UNKNOWN");
      expect(code).toBe(3);
    } finally {
      git(consumer, "config", "--unset", "extensions.partialclone");
    }
  }, TIMEOUT_MS);

  test("the default path never claims an attested authority", () => {
    const { code, report } = runStatus(["--host", "all"], { env: rewriting() });

    expect(release(report)["authority"]).toBe("local-mirror");
    expect(release(report)["status"]).toBe("unknown");
    expect(reasons(release(report))).toContain("PUBLIC_RELEASE_UNATTESTED");
    expect(report["delivery"]).toBe("UNKNOWN");
    expect(code).toBe(3);
  }, TIMEOUT_MS);
});

describe("semctx plugin-status — attestation does not require a semctx checkout", () => {
  test("runs from an unrelated project without being gated on its origin", () => {
    const { report } = runStatus(["--attest", "--host", "codex"], { root: foreign });

    // The regression: a resolver anchored on the consumer's `origin` refused to answer here.
    expect(reasons(release(report))).not.toContain("PUBLIC_RELEASE_ORIGIN_NOT_SEMCTX");
    expect(["attested-release", "absent"]).toContain(authority(report));
    expect(release(report)["commit"]).not.toBe(forgedCommit);
  }, TIMEOUT_MS);

  test("runs from a directory that is not a Git repository", () => {
    const { report } = runStatus(["--attest", "--host", "codex"], { root: bare });

    expect(reasons(release(report))).not.toContain("PUBLIC_RELEASE_ORIGIN_NOT_SEMCTX");
    expect(["attested-release", "absent"]).toContain(authority(report));
    expect((report["repository"] as Record<string, unknown>)["conveysDelivery"]).toBe(false);
  }, TIMEOUT_MS);
});

describe("semctx plugin-status — the production runner enforces its own budgets", () => {
  test("a host flooding stdout is stopped at the ceiling, not buffered and judged afterwards", () => {
    const flooding = join(work, "flood-stdout-bin");
    const sentinel = join(work, "stdout-flood-survived");
    writeHostShims(flooding, [["codex", { kind: "flood", stream: "stdout", sentinel }], ["claude", null]]);

    const { code, report } = runStatus(["--host", "codex"], { bin: flooding });

    expect(reasons(host(report, "codex"))).toContain("HOST_OUTPUT_TOO_LARGE");
    // The budget is a live ceiling: the flood is killed in flight rather than accumulated whole
    // and inspected once the damage is already done.
    expect(existsSync(sentinel)).toBe(false);
    expect(report["delivery"]).toBe("UNKNOWN");
    expect(code).toBe(3);
  }, TIMEOUT_MS);

  test("a host flooding stderr is bounded exactly like one flooding stdout", () => {
    const flooding = join(work, "flood-stderr-bin");
    const sentinel = join(work, "stderr-flood-survived");
    writeHostShims(flooding, [["codex", { kind: "flood", stream: "stderr", sentinel }], ["claude", null]]);

    const { code, report } = runStatus(["--host", "codex"], { bin: flooding });

    expect(reasons(host(report, "codex"))).toContain("HOST_OUTPUT_TOO_LARGE");
    expect(existsSync(sentinel)).toBe(false);
    expect(code).toBe(3);
  }, TIMEOUT_MS);

  test("a host that never returns is killed at its deadline and reported as a timeout", () => {
    const hanging = join(work, "hang-bin");
    writeHostShims(hanging, [["codex", { kind: "hang" }], ["claude", null]]);

    const started = Date.now();
    const { code, report } = runStatus(["--host", "codex"], { bin: hanging });

    expect(reasons(host(report, "codex"))).toContain("HOST_QUERY_TIMEOUT");
    // The budget is a real deadline, not a hint: the shim would otherwise run for a minute.
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(host(report, "codex")["convergence"]).toEqual([]);
    expect(host(report, "codex")["activation"]).toBeNull();
    expect(code).toBe(3);
  }, TIMEOUT_MS);
});

describe("semctx plugin-status — scope selection over real hosts", () => {
  test("auto omits an absent host while an explicit scope keeps it unknown", () => {
    const codexOnly = join(work, "codex-only-bin");
    writeHostShims(codexOnly, [["codex", codexInventory], ["claude", null]]);

    const auto = runStatus(["--attest"], { bin: codexOnly });
    // `auto` asks what is installed here, so an absent host is not part of the question.
    expect(host(auto.report, "claude")["requested"]).toBe(false);
    expect(host(auto.report, "codex")["requested"]).toBe(true);
    expect(reasons(host(auto.report, "codex"))).not.toContain("HOST_NOT_DETECTED");

    // Naming the host makes its absence part of the answer.
    const all = runStatus(["--attest", "--host", "all"], { bin: codexOnly });
    expect(host(all.report, "claude")["requested"]).toBe(true);
    expect(reasons(host(all.report, "claude"))).toContain("HOST_NOT_DETECTED");
    expect(all.report["delivery"]).toBe("UNKNOWN");
    expect(all.code).toBe(3);
  }, TIMEOUT_MS);
});

describe("semctx plugin-status — the attestation scratch store is placed, capped and removed", () => {
  test("a temporary base inside the inspected project is refused without creating anything", () => {
    // `os.tmpdir()` is whatever TEMP/TMP say, so the caller picks where this command would write.
    const inside = join(consumer, "hostile-temp");
    rmSync(inside, { recursive: true, force: true });

    const { code, report } = runStatus(["--attest", "--host", "codex"], {
      env: { TMPDIR: inside, TEMP: inside, TMP: inside },
    });

    expect(reasons(release(report))).toContain("PUBLIC_RELEASE_SCRATCH_LOCATION_REJECTED");
    expect(authority(report)).toBe("absent");
    expect(report["delivery"]).toBe("UNKNOWN");
    expect(code).toBe(3);
    // Refused on its location, not created and then cleaned up.
    expect(existsSync(inside)).toBe(false);
  }, TIMEOUT_MS);

  test("a temporary base inside a host's own tree is refused", () => {
    const inside = join(codexHome, "hostile-temp");
    rmSync(inside, { recursive: true, force: true });

    const { report } = runStatus(["--attest", "--host", "codex"], {
      env: { TMPDIR: inside, TEMP: inside, TMP: inside },
    });

    expect(reasons(release(report))).toContain("PUBLIC_RELEASE_SCRATCH_LOCATION_REJECTED");
    expect(existsSync(inside)).toBe(false);
  }, TIMEOUT_MS);

  test("a UNC temporary base is refused on its shape, before any access", () => {
    // Touching a UNC path would be an SMB round trip and an authentication attempt; the refusal
    // has to happen on the string, not after a filesystem call.
    const started = Date.now();
    const { report } = runStatus(["--attest", "--host", "codex"], {
      env: {
        TMPDIR: "\\\\10.255.255.1\\share\\tmp",
        TEMP: "\\\\10.255.255.1\\share\\tmp",
        TMP: "\\\\10.255.255.1\\share\\tmp",
      },
    });

    expect(reasons(release(report))).toContain("PUBLIC_RELEASE_SCRATCH_LOCATION_REJECTED");
    // An SMB attempt against an unroutable host would stall for seconds; a shape check does not.
    expect(Date.now() - started).toBeLessThan(30_000);
  }, TIMEOUT_MS);

  test("a relative temporary base is refused", () => {
    const { report } = runStatus(["--attest", "--host", "codex"], {
      env: { TMPDIR: "relative-temp", TEMP: "relative-temp", TMP: "relative-temp" },
    });

    expect(reasons(release(report))).toContain("PUBLIC_RELEASE_SCRATCH_LOCATION_REJECTED");
  }, TIMEOUT_MS);

  test("a temporary-base junction into the inspected project is refused on its canonical target", () => {
    const target = join(consumer, "hostile-temp-target");
    const link = join(work, "hostile-temp-link");
    rmSync(link, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

    const { report } = runStatus(["--attest", "--host", "codex"], {
      env: { TMPDIR: link, TEMP: link, TMP: link },
    });

    expect(reasons(release(report))).toContain("PUBLIC_RELEASE_SCRATCH_LOCATION_REJECTED");
    expect(readdirSync(target)).toEqual([]);
  }, TIMEOUT_MS);

  test("a store past the acceptance ceiling is refused before any witness is read", () => {
    const directory = mkdtempSync(join(work, "git-oversize-probe-"));
    writeGitProbe(directory, "oversize-store", join(directory, "unused"));
    writeHostShims(directory, [["codex", null], ["claude", null]]);

    const { code, report } = runStatus(["--attest", "--host", "codex"], { bin: directory });

    // `--depth=1` bounds ancestry, not bytes; acceptance is what is actually bounded.
    expect(reasons(release(report))).toContain("PUBLIC_RELEASE_STORE_TOO_LARGE");
    expect(authority(report)).toBe("absent");
    expect(release(report)["version"]).toBeNull();
    expect(release(report)["commit"]).toBeNull();
    expect(report["delivery"]).toBe("UNKNOWN");
    expect(code).toBe(3);
  }, TIMEOUT_MS);

  test("a scratch store that cannot be removed fails closed instead of reporting success", () => {
    const directory = mkdtempSync(join(work, "git-cleanup-probe-"));
    const base = mkdtempSync(join(work, "cleanup-base-"));
    writeGitProbe(directory, "block-cleanup", join(directory, "unused"));
    writeHostShims(directory, [["codex", null], ["claude", null]]);

    const { code, report } = runStatus(["--attest", "--host", "codex"], {
      bin: directory,
      env: { TMPDIR: base, TEMP: base, TMP: base },
    });

    // A store left on disk is a leaked copy of the release; silence about it is the failure mode.
    expect(reasons(release(report))).toContain("PUBLIC_RELEASE_SCRATCH_NOT_REMOVED");
    expect(authority(report)).toBe("absent");
    expect(report["delivery"]).toBe("UNKNOWN");
    expect(code).toBe(3);
    // The reason names the condition, never a filesystem path.
    expect(JSON.stringify(report)).not.toContain(base);
  }, TIMEOUT_MS);

  test("a successful attestation leaves no scratch store behind", () => {
    const base = mkdtempSync(join(work, "clean-base-"));

    runStatus(["--attest", "--host", "codex"], {
      env: { TMPDIR: base, TEMP: base, TMP: base },
    });

    expect(readdirSync(base)).toEqual([]);
  }, TIMEOUT_MS);
});

describe("semctx plugin-status — the output budget is a total, not a per-stream allowance", () => {
  test("a single stream past half the budget is refused", () => {
    // The spawn bounds each stream on its own, so the declared total is enforced as half per
    // stream. Without that halving, this 3 MiB burst would pass a budget that claims to cover
    // stdout and stderr together.
    const directory = mkdtempSync(join(work, "half-budget-bin-"));
    writeHostShims(directory, [
      ["codex", { kind: "noisy", stdoutMb: 3, stderrMb: 0, inventory: codexInventory }],
      ["claude", null],
    ]);

    const { report } = runStatus(["--host", "codex"], { bin: directory });

    expect(reasons(host(report, "codex"))).toContain("HOST_OUTPUT_TOO_LARGE");
  }, TIMEOUT_MS);

  test("both streams under half are accepted, which is what bounds the total", () => {
    // 1 MiB on each: under the per-stream ceiling, and together still inside the declared total.
    const directory = mkdtempSync(join(work, "combined-budget-bin-"));
    writeHostShims(directory, [
      ["codex", { kind: "noisy", stdoutMb: 1, stderrMb: 1, inventory: codexInventory }],
      ["claude", null],
    ]);

    const { report } = runStatus(["--host", "codex"], { bin: directory });

    expect(reasons(host(report, "codex"))).not.toContain("HOST_OUTPUT_TOO_LARGE");
    expect(host(report, "codex")["detected"]).toBe(true);
  }, TIMEOUT_MS);
});

describe("semctx plugin-status — nothing is mutated, including under --attest", () => {
  test("leaves the inspected repository's objects, refs and configuration untouched", () => {
    const before = repositoryState(consumer);

    runStatus(["--attest", "--host", "all"], { env: { GIT_CONFIG_GLOBAL: join(userHome, ".gitconfig") } });

    // No fetch into the inspected project, no ref written, no configuration changed — an
    // attestation that borrowed the consumer's object store would show up here.
    expect(repositoryState(consumer)).toBe(before);
  }, TIMEOUT_MS);

  test("leaves every marketplace snapshot and installed cache byte-for-byte identical", () => {
    const beforeCodex = treeState(codexHome);
    const beforeClaude = treeState(userHome);

    runStatus(["--attest", "--host", "all"]);

    expect(treeState(codexHome)).toBe(beforeCodex);
    expect(treeState(userHome)).toBe(beforeClaude);
  }, TIMEOUT_MS);
});
