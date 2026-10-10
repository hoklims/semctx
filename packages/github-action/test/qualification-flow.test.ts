import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "@semantic-context/app-services";
import { replaceLocalReportFile } from "../../../apps/cli/src/report-output";

test("Action default report remains outside qualified inputs and reaches the adapter", () => {
  const parsed = Bun.YAML.parse(readFileSync(join(import.meta.dir, "../action.yml"), "utf8")) as { inputs: { "report-path": { default: string } }; runs: { steps: { id?: string; env?: Record<string, string>; run?: string }[] } };
  expect(parsed.inputs["report-path"].default).toBe(".semctx/verify.json");
  expect(parsed.runs.steps.find(step => step.id === "verify")?.env?.SEMCTX_REPORT).toBe("${{ inputs.report-path }}");
  expect(parsed.runs.steps.find(step => step.id === "adapter")?.env?.INPUT_REPORT_PATH).toBe("${{ inputs.report-path }}");
});

test("Action delegates a fresh qualified rejection to the adapter and preserves operational errors", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-action-qualified-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    writeFileSync(join(root, "hidden.mjs"), "export default () => 1;\n");
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) expect(Bun.spawnSync(["git", ...args], { cwd: root }).exitCode).toBe(0);
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
    indexRepository(root, "2026-10-10T10:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    expect(report.analysisAdmission?.status).toBe("rejected");
    const fixture = join(root, "fixture.json"); writeFileSync(fixture, JSON.stringify(report));
    const parsed = Bun.YAML.parse(readFileSync(join(import.meta.dir, "../action.yml"), "utf8")) as { runs: { steps: { id?: string; run?: string }[] } };
    const script = parsed.runs.steps.find(step => step.id === "verify")!.run!;
    const bash = process.platform === "win32" && existsSync("C:/Program Files/Git/bin/bash.exe") ? "C:/Program Files/Git/bin/bash.exe" : "bash";
    const output = join(root, ".semctx/verify.json");
    for (const [code, mode, expected] of [[3, "valid", 0], [1, "valid", 1], [2, "valid", 2], [3, "invalid", 3], [3, "missing", 3]] as const) {
      writeFileSync(output, JSON.stringify(report)); // A prior valid artifact must not substitute for this invocation.
      const stub = "bun() { if [ \"$2\" = verify ]; then case \"$FIXTURE_MODE\" in valid) cp \"$FIXTURE_REPORT\" \"$report.new\"; mv -f -- \"$report.new\" \"$report\" ;; invalid) printf '{}' > \"$report.new\"; mv -f -- \"$report.new\" \"$report\" ;; esac; return \"$FIXTURE_CODE\"; fi; return 0; }\n";
      const result = Bun.spawnSync([bash, "--noprofile", "--norc", "-c", stub + script], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, SEMCTX_CLI: "fixture-cli", SEMCTX_TARGET: root.replaceAll("\\", "/"), SEMCTX_CONFIG: "", SEMCTX_REPORT: ".semctx/verify.json", SEMCTX_BASE: "HEAD^", SEMCTX_HEAD: "HEAD", GITHUB_ACTION_PATH: join(import.meta.dir, "..").replaceAll("\\", "/"), FIXTURE_REPORT: fixture.replaceAll("\\", "/"), FIXTURE_CODE: String(code), FIXTURE_MODE: mode } });
      expect(result.exitCode).toBe(expected);
      if (expected === 0) {
        const outputs = join(root, "outputs"); const summary = join(root, "summary");
        const adapter = Bun.spawnSync(["node", join(import.meta.dir, "../src/adapter.mjs"), output], { stdout: "pipe", stderr: "pipe", env: { ...process.env, INPUT_FAIL_ON: "none", GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary } });
        expect(adapter.exitCode).toBe(1);
        expect(readFileSync(outputs, "utf8")).toContain("verdict=BLOCK");
        expect(readFileSync(summary, "utf8")).toContain("BLOCK");
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test("Action preserves an outside report behind a consumer-owned linked parent on verification failure", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-action-link-"));
  const outside = mkdtempSync(join(tmpdir(), "semctx-action-outside-"));
  const linked = join(root, "reports"); const target = join(outside, "report.json");
  try {
    writeFileSync(target, "outside sentinel"); symlinkSync(outside, linked, "junction");
    const parsed = Bun.YAML.parse(readFileSync(join(import.meta.dir, "../action.yml"), "utf8")) as { runs: { steps: { id?: string; run?: string }[] } };
    const script = parsed.runs.steps.find(step => step.id === "verify")!.run!;
    const bash = process.platform === "win32" && existsSync("C:/Program Files/Git/bin/bash.exe") ? "C:/Program Files/Git/bin/bash.exe" : "bash";
    const result = Bun.spawnSync([bash, "--noprofile", "--norc", "-c", "bun() { if [ \"$2\" = verify ]; then return 1; fi; return 0; }\n" + script], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, SEMCTX_CLI: "fixture-cli", SEMCTX_TARGET: root.replaceAll("\\", "/"), SEMCTX_CONFIG: "", SEMCTX_REPORT: "reports/report.json", SEMCTX_BASE: "HEAD^", SEMCTX_HEAD: "HEAD" } });
    expect(result.exitCode).toBe(1);
    expect(existsSync(target)).toBe(true);
    expect(() => replaceLocalReportFile(join(root, "reports/report.json"), "new report", root)).toThrow("existing symlink");
    expect(readFileSync(target, "utf8")).toBe("outside sentinel");
  } finally { if (existsSync(linked)) unlinkSync(linked); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
