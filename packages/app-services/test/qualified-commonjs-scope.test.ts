import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

for (const [path, content, reason] of [
  ["hidden.ts", "const { main } = require('./src/main.ts'); export const value = main();", "COMMONJS_UNSUPPORTED"],
  ["hidden.mjs", "module.exports = require('./src/main.ts');", "COMMONJS_UNSUPPORTED"],
  ["hidden-import-equals.ts", "import value = require('./src/main.ts'); export const hidden = value.main();", "COMMONJS_UNSUPPORTED"],
  ["hidden-import-type.ts", "export type Hidden = typeof import('./src/main').main;", "IMPORT_TYPE_UNSUPPORTED"],
]) test(`excluded ${path} unsupported dependency cannot silently escape scope`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-hidden-commonjs-"));
  const git = (...args: string[]): void => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
    writeFileSync(join(root, path!), content!);
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*.ts"], languages: { typescript: "on", javascript: "on" } });
    indexRepository(root, "2026-10-09T10:00:00.000Z");
    writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
    indexRepository(root, "2026-10-09T10:01:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    const cli = Bun.spawnSync(["bun", join(import.meta.dir, "../../../apps/cli/src/index.ts"), "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { stdout: "pipe", stderr: "pipe" });
    console.info(JSON.stringify({ case: path, status: report.analysisAdmission?.status, cliExit: cli.exitCode }));
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.reasons).toContain(`DEPENDENCY_SCOPE_${reason}:${path}`);
    expect(cli.exitCode).toBe(3);
    expect(JSON.parse(new TextDecoder().decode(cli.stdout)).analysisAdmission.status).toBe("rejected");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
