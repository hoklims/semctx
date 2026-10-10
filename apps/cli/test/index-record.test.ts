import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "../src/args";
import { runIndex, runIndexAsync } from "../src/commands/index-cmd";

const CLI = resolve(import.meta.dir, "../src/index.ts");
const roots: string[] = [];

function captureStdout<T>(action: () => T): { result: T; out: string } {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let out = "";
  (process.stdout.write as unknown) = (chunk: string): boolean => { out += chunk; return true; };
  try {
    return { result: action(), out };
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function withoutStdoutAsync<T>(action: () => Promise<T>): Promise<T> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (): boolean => true;
  try {
    return await action();
  } finally {
    process.stdout.write = originalWrite;
  }
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: GIT_ENV });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function semctx(root: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const child = Bun.spawnSync([process.execPath, CLI, ...args, "--root", root], { stdout: "pipe", stderr: "pipe" });
  return {
    code: child.exitCode ?? 1,
    stdout: new TextDecoder().decode(child.stdout),
    stderr: new TextDecoder().decode(child.stderr),
  };
}

/** Run a `semctx` subcommand and fail with its captured output when it does not exit 0. */
function expectSemctxOk(root: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const result = semctx(root, args);
  if (result.code !== 0) {
    throw new Error(
      `semctx ${args.join(" ")} exited ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return result;
}

const EVIDENCE_PATH = (root: string): string => join(root, ".semctx", "verification-state.json");

const MAIN = `/**\n * @invariant a-positive: x must stay positive\n */\nexport function compute(x: number): number {\n  return x + 1;\n}\n`;
const FEATURE = `/**\n * @invariant a-positive: x must stay positive\n */\nexport function compute(x: number): number {\n  return x + 2;\n}\n`;

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-cli-index-record-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), MAIN);
  writeFileSync(join(root, "package.json"), '{"name":"cli-index-record"}\n');
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  expectSemctxOk(root, ["init"]);
  // `init` rewrites `.gitignore` to re-track `.semctx/config.json` (#82): commit that state so the
  // working tree is clean before `--record` runs, which refuses non-ignored untracked files.
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "semctx init state");
  expectSemctxOk(root, ["index"]);
  // A clean working tree records a trivially PASS-ing baseline (no diff against HEAD).
  expectSemctxOk(root, ["verify", "diff", "--record"]);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("semctx index --record (CLI, real git)", () => {
  test("stale-baseline diagnostics share the explicit recovery remedy", () => {
    const root = repository();
    writeFileSync(join(root, "src", "a.ts"), FEATURE);
    const status = semctx(root, ["status", "--json"]);
    expect(status.code).toBe(3);
    expect(JSON.parse(status.stdout).reasons).toContain("SEMANTIC_LIFECYCLE_INVALID");
    // UNSEALED says why: the concrete lifecycle finding and the one command that seals again.
    expect(JSON.parse(status.stdout).explanation).toContainEqual(expect.objectContaining({
      reason: "SEMANTIC_LIFECYCLE_INVALID",
      code: "EVIDENCE_BASELINE_STALE",
      remedy: "semctx index --record",
    }));
    expect(status.stderr).toContain("semctx index --record");
    const semantic = semctx(root, ["semantic", "check", "--json"]);
    expect(semantic.code).toBe(1);
    const findings = JSON.parse(semantic.stdout).lifecycleFindings as Array<{ code: string; message: string }>;
    expect(findings.find((finding) => finding.code === "EVIDENCE_BASELINE_STALE")?.message)
      .toContain("semctx index --record");
    const indexed = expectSemctxOk(root, ["index", "--json"]);
    expect(JSON.parse(indexed.stdout).indexed).toBe(true);
    expect(indexed.stderr).toContain("semctx index --record");
    const verified = semctx(root, ["verify", "diff", "--record", "--format", "json"]);
    expect(verified.code).toBe(3);
    expect(JSON.parse(verified.stdout).unknowns.join("\n")).toContain("semctx index --record");
  });

  test("the documented sealing path turns an explained UNSEALED into FRESH", () => {
    const root = repository();
    writeFileSync(join(root, "src", "a.ts"), FEATURE);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "checkpoint");
    const before = JSON.parse(semctx(root, ["status", "--json"]).stdout);
    expect(before.verdict).toBe("UNSEALED");
    expect(before.explanation.map((entry: { remedy: string | null }) => entry.remedy)).toContain("semctx index --record");
    semctx(root, ["index", "--record", "--json"]);
    const after = semctx(root, ["status", "--json"]);
    expect(JSON.parse(after.stdout)).toMatchObject({ verdict: "FRESH", reasons: [], explanation: [] });
    expect(after.code).toBe(0);
  });

  test("--help names --record under index", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-cli-index-record-help-"));
    roots.push(root);
    const result = semctx(root, ["help"]);
    const indexHelp = result.stdout.match(/^ {2}index \[.*?\n(?:(?!^ {2}\S).*(?:\n|$))*/m)?.[0];
    expect(indexHelp).toBeDefined();
    expect(indexHelp).toContain("[--record]");
    expect(indexHelp).toContain("rebuild, verify the working tree, and atomically record evidence");
  });

  test("plain index preserves recorded evidence bytes, even while they are stale", () => {
    const root = repository();
    const before = readFileSync(EVIDENCE_PATH(root));
    writeFileSync(join(root, "src", "a.ts"), FEATURE);

    const result = expectSemctxOk(root, ["index", "--json"]);

    expect(result.code).toBe(0);
    expect(readFileSync(EVIDENCE_PATH(root))).toEqual(before);
  });

  test("recovers a stale baseline as one JSON document with the actual verdict", () => {
    const root = repository();
    writeFileSync(join(root, "src", "a.ts"), FEATURE);
    expectSemctxOk(root, ["index"]);
    const expected = JSON.parse(expectSemctxOk(root, ["verify", "diff", "--format", "json", "--fail-on", "none"]).stdout) as { unknowns: string[] };
    expect(expected.unknowns.length).toBeGreaterThan(0);

    const result = semctx(root, ["index", "--record", "--json"]);

    // One JSON document: the whole stdout parses once, carrying both the index fields and the
    // verification outcome, never two concatenated payloads.
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload["indexed"]).toBe(true);
    expect(typeof payload["nodes"]).toBe("number");
    const verification = payload["verification"] as {
      recorded: boolean;
      report: { verdict: string; schemaVersion: number; unknowns: string[] };
    };
    expect(verification.recorded).toBe(true);
    expect(verification.report.schemaVersion).toBe(1);
    // The invariant-tagged function changed with no test recommending it: an honest BLOCK,
    // not a favorable rewrite.
    expect(verification.report.verdict).toBe("BLOCK");
    expect(result.code).toBe(3);
    // ADR 0025: recovery records the actual computation, so its unknowns are not silently
    // dropped to present a cleaner outcome than what was analyzed.
    expect(verification.report.unknowns).toEqual(expected.unknowns);

    const persisted = JSON.parse(readFileSync(EVIDENCE_PATH(root), "utf8")) as Record<string, unknown>;
    expect(persisted["version"]).toBe(3);
    expect(persisted["verdict"]).toBe("BLOCK");
  });

  test("both the sync and async index entry points honor --record consistently", async () => {
    const root = repository();
    writeFileSync(join(root, "src", "a.ts"), FEATURE);
    expectSemctxOk(root, ["index"]);
    const expected = JSON.parse(expectSemctxOk(root, ["verify", "diff", "--format", "json", "--fail-on", "none"]).stdout) as { unknowns: string[] };
    expect(expected.unknowns.length).toBeGreaterThan(0);

    const sync = captureStdout(() => runIndex(root, parseArgs(["index", "--record", "--root", root])));
    expect(sync.result).toBe(3);
    expect(sync.out).toContain("Recovery verification");
    expect(sync.out).toContain("recorded verification state ->");
    expect(sync.out).toContain("BLOCK");
    for (const unknown of expected.unknowns) expect(sync.out).toContain(unknown);

    // Revert, re-record a matching baseline, drift again, and prove the async entry point (the
    // one actually wired to `semctx index` in the compiled CLI) names the same outcome.
    writeFileSync(join(root, "src", "a.ts"), MAIN);
    expectSemctxOk(root, ["verify", "diff", "--record"]);
    writeFileSync(join(root, "src", "a.ts"), FEATURE);

    const asyncCode = await withoutStdoutAsync(() =>
      runIndexAsync(root, parseArgs(["index", "--record", "--json", "--root", root])),
    );
    expect(asyncCode).toBe(3);
  });
});
