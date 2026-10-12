import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

for (const method of ["join", "toLocaleString"]) for (const extension of ["ts", "mjs"]) for (const selected of [true, false]) {
  test(`qualified mutated array ${method} ${extension} selected=${selected}`, () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-array-coercion-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, ".gitignore"), ".semctx/\n");
      const hidden = join(root, `src/hidden.${extension}`);
      writeFileSync(hidden, "export function hidden() { return 1; }");
      const hook = method === "join" ? "toString" : "toLocaleString";
      const assertion = extension === "ts" ? " as any" : "";
      writeFileSync(join(root, `src/consumer.${extension}`), `import { hidden } from './hidden.${extension}'; const values = [1]; values[0] = { ${hook}: hidden }${assertion}; export function run() { return values.${method}(); }`);
      writeFileSync(join(root, `src/consumer.test.${extension}`), `import { run } from './consumer.${extension}'; export function check() { return run(); }`);
      for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
        const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
        if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
      }
      initWorkspace(root, {
        ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1",
        include: selected ? ["src/**/*"] : [`src/hidden.${extension}`], languages: { typescript: "on", javascript: "on" },
      });
      writeFileSync(hidden, "export function hidden() { return 2; }");
      indexRepository(root, "2026-10-12T00:00:00.000Z");
      const report = runVerify(root, { kind: "working-tree" }).report;
      const cli = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../../apps/cli/src/index.ts"), "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      console.info(JSON.stringify({ method, extension, selected, admission: report.analysisAdmission, cliExit: cli.exitCode, cliStdout: new TextDecoder().decode(cli.stdout), cliStderr: new TextDecoder().decode(cli.stderr) }));
      expect(report.analysisAdmission?.binding.status).toBe("valid");
      expect(report.analysisAdmission?.status).toBe("rejected");
      expect(report.analysisAdmission?.reasons).toContain(`DEPENDENCY_SCOPE_CONFIGURATION:src/consumer.${extension}:SOURCE_COERCION_UNSUPPORTED`);
      if (selected) expect(report.analysisAdmission?.changeCoverage.files.find(file => file.path === `src/consumer.${extension}`)?.reasons).toContain("SOURCE_COERCION_UNSUPPORTED");
      expect(cli.exitCode).toBe(3);
      const cliReport = JSON.parse(new TextDecoder().decode(cli.stdout)) as { verdict: string; analysisAdmission: { status: string; reasons: string[] } };
      expect(cliReport.verdict).toBe("BLOCK");
      expect(cliReport.analysisAdmission.status).toBe("rejected");
      expect(cliReport.analysisAdmission.reasons).toContain(`DEPENDENCY_SCOPE_CONFIGURATION:src/consumer.${extension}:SOURCE_COERCION_UNSUPPORTED`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
}
