import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
for (const extension of ["mjs", "ts"]) for (const expression of ["((value) => value + 1)", "(function (value) { return value + 1; })", "(true ? (() => 1) : (() => 2))"]) {
  test(`unmodeled default function expression refuses ${extension}: ${expression}`, () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-default-expression-")); roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    const leaf = `src/module.${extension}`;
    writeFileSync(join(root, leaf), `export default ${expression};\n`);
    writeFileSync(join(root, "src/entry.ts"), `import run from './module.${extension}'; export function entry() { return run(1); }\n`);
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    }
    initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
    writeFileSync(join(root, leaf), `export default ${expression.replace("+ 1", "+ 2")};\n`);
    const indexed = indexRepository(root, "2026-10-10T10:00:00.000Z");
    expect(indexed.analysis.graph.nodes.some(node => node.filePath === leaf && node.name === "default")).toBe(false);
    expect(indexed.analysis.graph.edges.filter(edge => edge.kind === "calls")).toEqual([]);
    const report = runVerify(root, { kind: "working-tree" }).report;
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.reasons.some(reason => reason.includes("DEFAULT_EXPRESSION_UNSUPPORTED"))).toBe(true);
    const cli = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../../apps/cli/src/index.ts"), "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none"], { stdout: "pipe", stderr: "pipe" });
    expect(cli.exitCode).toBe(3);
  }, 60_000);
}
