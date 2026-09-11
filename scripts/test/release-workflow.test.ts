import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const workflowPath = join(root, ".github", "workflows", "release.yml");
const workflow = Bun.YAML.parse(readFileSync(workflowPath, "utf8")) as {
  jobs: Record<string, {
    needs?: string;
    permissions?: Record<string, string>;
    "timeout-minutes"?: number;
    steps: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, unknown> }>;
  }>;
};
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function releaseScript(job: string, name: string): string {
  const step = workflow.jobs[job]?.steps.find((candidate) => candidate.name === name);
  if (step?.run === undefined) {
    throw new Error(`release workflow script not found: ${job}/${name}`);
  }
  return step.run;
}

const publishScript = releaseScript(
  "publish",
  "Publish semctx to npm or prove the existing version is this commit",
);
const stableScript = releaseScript(
  "promote",
  "Advance the stable plugin channel after npm is public",
);
const githubReleaseScript = releaseScript(
  "promote",
  "Create the GitHub Release after npm is public",
);

function runRegistry(mode: string): ShellResult {
  const script = releaseScript("registry-ready", "Wait for the accepted npm package to become public");
  return runShell(script, `
SECONDS=0
sleep() { SECONDS=$((SECONDS + $1)); printf 'SLEEP %s\\n' "$1" >> "$TEST_LOG"; }
npm() {
  printf '%s\\n' "$*" >> "$TEST_LOG"
  if [[ "$1" != "view" || "$2" != "semctx@1.2.3" || "$3" != "gitHead" ]]; then return 99; fi
  case "$NPM_SCENARIO" in
    delayed) if [[ "$SECONDS" -lt 450 ]]; then printf 'E404 pending\\n' >&2; return 1; fi ;;
    timeout) printf 'E404 pending\\n' >&2; return 1 ;;
    wrong) printf 'different-sha\\n'; return 0 ;;
    empty) return 0 ;;
    denied) printf 'E403 forbidden\\n' >&2; return 23 ;;
  esac
  printf '%s\\n' "$GITHUB_SHA"
}
`, { NPM_SCENARIO: mode });
}

describe("registry availability gate", () => {
  test("promotion checks out the exact release commit before reading curated notes", () => {
    const checkout = workflow.jobs.promote?.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.uses).toBe("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(checkout?.with).toEqual({
      ref: "${{ github.sha }}",
      "fetch-depth": 1,
      "persist-credentials": false,
    });
  });

  test("promotion depends on a separate read-only, bounded availability job", () => {
    expect(workflow.jobs["registry-ready"]?.needs).toBe("publish");
    expect(workflow.jobs["registry-ready"]?.permissions).toEqual({});
    expect(workflow.jobs["registry-ready"]?.["timeout-minutes"]).toBe(35);
    expect(workflow.jobs.promote?.needs).toBe("registry-ready");
    expect(workflow.jobs.deliver?.needs).toBe("promote");
  });

  test("accepted publication survives a 7.5-minute delay without republishing", () => {
    const result = runRegistry("delayed");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("NPM_AVAILABLE");
    expect(result.log.match(/^SLEEP /gm)?.length).toBe(15);
    expect(result.log).not.toContain("publish");
    expect(result.log).toContain("--fetch-retries=0 --fetch-timeout=10000");
  });

  test("failed-job retry checks the same version and commit without publication", () => {
    const result = runRegistry("same");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("expected-sha");
    expect(result.log).not.toContain("publish");
    expect(result.log).not.toContain("SLEEP");
  });

  for (const mode of ["wrong", "empty"]) {
    test(`blocks immediately on ${mode} visible identity`, () => {
      const result = runRegistry(mode);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("NPM_IDENTITY_MISMATCH");
      expect(result.log).not.toContain("SLEEP");
    });
  }

  test("preserves registry access failure without retry or publication", () => {
    const result = runRegistry("denied");
    expect(result.exitCode).toBe(23);
    expect(result.stderr).toContain("E403");
    expect(result.log).not.toContain("SLEEP");
    expect(result.log).not.toContain("publish");
  });

  test("expires at thirty minutes with pending distinct from publish failure", () => {
    const result = runRegistry("timeout");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("NPM_AVAILABILITY_TIMEOUT");
    expect(result.stdout).toContain("rerun failed jobs");
    expect(result.log.match(/^SLEEP /gm)?.length).toBe(60);
    expect(result.log).not.toContain("publish");
  });
});

function bashExecutable(): string {
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  return process.platform === "win32" && existsSync(gitBash) ? gitBash : "bash";
}

function shellPath(path: string): string {
  return path.replaceAll("\\", "/");
}

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  log: string;
}

function runShell(script: string, prelude: string, environment: Record<string, string>): ShellResult {
  const cwd = mkdtempSync(join(tmpdir(), "semctx-release-workflow-"));
  temporaryDirectories.push(cwd);
  const scriptPath = join(cwd, "step.sh");
  const logPath = join(cwd, "calls.log");
  writeFileSync(scriptPath, `${prelude}\n${script}\n`);
  const result = Bun.spawnSync(
    [bashExecutable(), "--noprofile", "--norc", "-e", "-o", "pipefail", shellPath(scriptPath)],
    {
      cwd,
      env: {
        ...process.env,
        GITHUB_REF_NAME: "v1.2.3",
        GITHUB_REPOSITORY: "hoklims/semctx",
        GITHUB_SHA: "expected-sha",
        RUNNER_TEMP: shellPath(cwd),
        TEST_LOG: shellPath(logPath),
        ...environment,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    log: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
  };
}

function runPublish(mode: "absent" | "same" | "other" | "lookup-error"): ShellResult {
  const cwd = mkdtempSync(join(tmpdir(), "semctx-release-package-"));
  temporaryDirectories.push(cwd);
  writeFileSync(join(cwd, "semctx-1.2.3.tgz"), "archive");
  writeFileSync(join(cwd, "semctx-1.2.3.tgz.sha256"), "checksum");
  const scriptPath = join(cwd, "step.sh");
  const logPath = join(cwd, "calls.log");
  const prelude = `
sha256sum() { return 0; }
tar() { printf '%s\\n' '{"name":"semctx","version":"1.2.3","gitHead":"expected-sha"}'; }
node() { return 0; }
sleep() { return 0; }
npm() {
  if [[ "$1" == "publish" ]]; then
    printf '%s\\n' PUBLISH >> "$TEST_LOG"
    : > "$RUNNER_TEMP/published"
    return 0
  fi
  if [[ "$1" != "view" ]]; then
    return 99
  fi
  field="$3"
  case "$NPM_SCENARIO:$field" in
    absent:version) printf '%s\\n' E404 >&2; return 1 ;;
    absent:gitHead)
      if [[ -f "$RUNNER_TEMP/published" ]]; then printf '%s\\n' "$GITHUB_SHA"; return 0; fi
      printf '%s\\n' E404 >&2; return 1 ;;
    same:version|other:version) printf '%s\\n' '1.2.3'; return 0 ;;
    same:gitHead) printf '%s\\n' "$GITHUB_SHA"; return 0 ;;
    other:gitHead) printf '%s\\n' 'different-sha'; return 0 ;;
    lookup-error:version) printf '%s\\n' 'E500 registry unavailable' >&2; return 23 ;;
    *) return 98 ;;
  esac
}
`;
  writeFileSync(scriptPath, `${prelude}\n${publishScript}\n`);
  const result = Bun.spawnSync(
    [bashExecutable(), "--noprofile", "--norc", "-e", "-o", "pipefail", shellPath(scriptPath)],
    {
      cwd,
      env: {
        ...process.env,
        GITHUB_REF_NAME: "v1.2.3",
        GITHUB_SHA: "expected-sha",
        NPM_SCENARIO: mode,
        RUNNER_TEMP: shellPath(cwd),
        TEST_LOG: shellPath(logPath),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    log: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
  };
}

const stablePrelude = `
gh() {
  if [[ "$1" != "api" ]]; then return 99; fi
  case "$STABLE_SCENARIO" in
    absent)
      if [[ "$*" == *"--method POST"* ]]; then printf '%s\\n' POST >> "$TEST_LOG"; return 0; fi
      printf '%s\\n' 'HTTP 404: Not Found' >&2; return 22 ;;
    same) printf '%s\\n' "$GITHUB_SHA"; return 0 ;;
    other)
      if [[ "$*" == *"--method PATCH"* ]]; then printf '%s\\n' "$*" >> "$TEST_LOG"; return 0; fi
      printf '%s\\n' 'previous-sha'; return 0 ;;
    lookup-error) printf '%s\\n' 'HTTP 500: unavailable' >&2; return 17 ;;
    *) return 98 ;;
  esac
}
`;

const releasePrelude = `
mkdir -p docs/releases
printf '%s\n' '# Semctx 1.2.3' > docs/releases/v1.2.3.md
gh() {
  if [[ "$1" == "release" && "$2" == "create" ]]; then
    printf '%s\\n' CREATE >> "$TEST_LOG"
    return 0
  fi
  case "$RELEASE_SCENARIO" in
    absent) printf '%s\\n' 'HTTP 404: Not Found' >&2; return 22 ;;
    present) return 0 ;;
    lookup-error) printf '%s\\n' 'HTTP 502: unavailable' >&2; return 19 ;;
    *) return 98 ;;
  esac
}
`;

describe("release workflow shell syntax", () => {
  for (const [name, script] of [
    ["npm publication", publishScript],
    ["stable promotion", stableScript],
    ["GitHub release", githubReleaseScript],
  ] as const) {
    test(`${name} script passes bash syntax validation`, () => {
      const result = Bun.spawnSync([bashExecutable(), "--noprofile", "--norc", "-n"], {
        stdin: Buffer.from(script),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    });
  }
});

describe("npm publication fallback", () => {
  test("publishes and succeeds when the version is absent", () => {
    const result = runPublish("absent");
    expect(result.exitCode).toBe(0);
    expect(result.log).toBe("PUBLISH\n");
  });

  test("succeeds without publishing when the existing version has the expected commit", () => {
    const result = runPublish("same");
    expect(result.exitCode).toBe(0);
    expect(result.log).toBe("");
  });

  test("fails without publishing when the existing version has another commit", () => {
    const result = runPublish("other");
    expect(result.exitCode).toBe(1);
    expect(result.log).toBe("");
  });

  test("preserves a non-404 lookup failure and does not publish", () => {
    const result = runPublish("lookup-error");
    expect(result.exitCode).toBe(23);
    expect(result.log).toBe("");
  });
});

describe("stable branch fallback", () => {
  test("creates the stable ref when it is absent", () => {
    const result = runShell(stableScript, stablePrelude, { STABLE_SCENARIO: "absent" });
    expect(result.exitCode).toBe(0);
    expect(result.log).toBe("POST\n");
  });

  test("does not mutate the stable ref when it already targets the release commit", () => {
    const result = runShell(stableScript, stablePrelude, { STABLE_SCENARIO: "same" });
    expect(result.exitCode).toBe(0);
    expect(result.log).toBe("");
  });

  test("updates another stable commit without force", () => {
    const result = runShell(stableScript, stablePrelude, { STABLE_SCENARIO: "other" });
    expect(result.exitCode).toBe(0);
    expect(result.log).toContain("--method PATCH");
    expect(result.log).toContain("force=false");
  });

  test("preserves a non-404 lookup failure and does not mutate the stable ref", () => {
    const result = runShell(stableScript, stablePrelude, { STABLE_SCENARIO: "lookup-error" });
    expect(result.exitCode).toBe(17);
    expect(result.log).toBe("");
  });
});

describe("GitHub Release fallback", () => {
  test("creates the release when lookup returns 404", () => {
    const result = runShell(githubReleaseScript, releasePrelude, {
      RELEASE_SCENARIO: "absent",
    });
    expect(result.exitCode).toBe(0);
    expect(result.log).toBe("CREATE\n");
    expect(githubReleaseScript).toContain('--notes-file "$notes_file"');
  });

  test("does not create the release when it already exists", () => {
    const result = runShell(githubReleaseScript, releasePrelude, {
      RELEASE_SCENARIO: "present",
    });
    expect(result.exitCode).toBe(0);
    expect(result.log).toBe("");
  });

  test("preserves a non-404 lookup failure and does not create a release", () => {
    const result = runShell(githubReleaseScript, releasePrelude, {
      RELEASE_SCENARIO: "lookup-error",
    });
    expect(result.exitCode).toBe(19);
    expect(result.log).toBe("");
  });
});
