import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Git Bash on Windows, never the WSL `bash.exe` that System32 may put first on PATH. */
function bashExecutable(): string {
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  return process.platform === "win32" && existsSync(gitBash) ? gitBash : "bash";
}

// The composite action analyses a checkout it must not trust. Bun executes `$cwd/bunfig.toml`
// preload scripts and loads `$cwd/.env` before any entrypoint runs, so a `bun` step whose
// working directory is the consumer checkout lets a pull request run code on the runner
// (SEC-PPLUG-02). Every `bun` step therefore runs from the action's own checkout and names the
// analysed repository through an absolute `--root`.

const ACTION_YML = join(import.meta.dir, "..", "action.yml");
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.ts");
const TRUSTED_CWD = "${{ github.action_path }}/../..";
const CONSUMER_CWD = "${{ inputs.working-directory }}";

interface Step {
  name?: string;
  id?: string;
  run?: string;
  "working-directory"?: string;
  env?: Record<string, string>;
}

function steps(): Step[] {
  const parsed = Bun.YAML.parse(readFileSync(ACTION_YML, "utf8")) as { runs: { steps: Step[] } };
  return parsed.runs.steps;
}

const fixtures: string[] = [];

function hostileCheckout(): { root: string; marker: string } {
  const root = mkdtempSync(join(tmpdir(), "semctx-action-hostile-"));
  fixtures.push(root);
  const marker = join(root, "PRELOAD-RAN");
  writeFileSync(join(root, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  writeFileSync(join(root, "preload.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  return { root, marker };
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("action.yml never runs Bun inside the analysed checkout", () => {
  it("runs every bun step from the action's own checkout", () => {
    const bunSteps = steps().filter((step) => /(^|\s)bun\s/.test(step.run ?? ""));
    expect(bunSteps.length).toBeGreaterThanOrEqual(2);
    for (const step of bunSteps) {
      expect({ name: step.name, cwd: step["working-directory"] }).toEqual({ name: step.name, cwd: TRUSTED_CWD });
    }
  });

  it("resolves the consumer directory with node inside the workspace, then passes it to every CLI call as an absolute --root", () => {
    const target = steps().find((step) => step.id === "target");
    expect(target?.["working-directory"]).toBe(CONSUMER_CWD);
    expect(target?.run).toContain("node -e");
    expect(target?.run).toContain("fs.realpathSync.native(process.env.GITHUB_WORKSPACE)");
    expect(target?.run).toContain("working-directory resolves outside the workspace");
    // Multi-line output form: a path containing a newline cannot inject a second step output.
    expect(target?.run).toContain("printf 'root<<%s\\n%s\\n%s\\n'");
    expect(target?.run).not.toMatch(/(^|\s)bun\s/);

    const verify = steps().find((step) => step.id === "verify");
    expect(verify?.["working-directory"]).toBe(TRUSTED_CWD);
    expect(verify?.env?.SEMCTX_TARGET).toBe("${{ steps.target.outputs.root }}");
    const bunLines = (verify?.run ?? "").split("\n").filter((line) => /^\s*bun\s/.test(line));
    expect(bunLines).toHaveLength(3);
    for (const line of bunLines) expect(line).toContain('--root "$SEMCTX_TARGET"');
    expect(verify?.run).not.toContain("--root .");
    // The report path stays relative to the consumer directory, as documented for `report-path`.
    expect(verify?.run).toContain('report="$SEMCTX_TARGET/$SEMCTX_REPORT"');
  });

  it("witness: the target step accepts a workspace subdirectory and refuses a directory outside the workspace", () => {
    const target = steps().find((step) => step.id === "target");
    const workspace = mkdtempSync(join(tmpdir(), "semctx-action-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "semctx-action-outside-"));
    fixtures.push(workspace, outside);
    mkdirSync(join(workspace, "packages", "app"), { recursive: true });
    const run = (cwd: string) => {
      const output = join(cwd, "github-output.txt");
      writeFileSync(output, "");
      const result = Bun.spawnSync([bashExecutable(), "--noprofile", "--norc", "-c", target?.run ?? "exit 99"], {
        cwd,
        env: { ...process.env, GITHUB_WORKSPACE: workspace, GITHUB_OUTPUT: output },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { exitCode: result.exitCode, output: readFileSync(output, "utf8"), stderr: result.stderr.toString() };
    };

    const inside = run(join(workspace, "packages", "app"));
    expect(inside.exitCode).toBe(0);
    expect(inside.output).toMatch(/^root<<semctx-target-\d+\n.+\/packages\/app\nsemctx-target-\d+\n$/);
    expect(inside.output).not.toContain("\\");

    const escaped = run(outside);
    expect(escaped.exitCode).toBe(1);
    expect(escaped.stderr).toContain("working-directory resolves outside the workspace");
    expect(escaped.output).toBe("");
  });

  it("witness: the CLI started from the action checkout ignores the checkout's bunfig.toml", () => {
    const checkout = hostileCheckout();
    const armed = Bun.spawnSync([process.execPath, CLI_ENTRY, "version"], { cwd: checkout.root, stdout: "pipe", stderr: "pipe" });
    expect(armed.exitCode).toBe(0);
    expect(existsSync(checkout.marker)).toBe(true);
    rmSync(checkout.marker);

    const isolated = Bun.spawnSync([process.execPath, CLI_ENTRY, "version"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    expect(isolated.exitCode).toBe(0);
    expect(isolated.stdout.toString().trim()).toBe(armed.stdout.toString().trim());
    expect(existsSync(checkout.marker)).toBe(false);
  });
});
