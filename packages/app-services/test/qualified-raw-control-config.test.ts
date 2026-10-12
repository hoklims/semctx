import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace, loadConfig } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";
import { captureQualifiedAnalysisInputs } from "../src/freshness";
import { __setVerifyAnalysisBarrierForTesting } from "../src/verify";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-raw-control-"));
  mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  }
  initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"] });
  writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
  return root;
}

test("equivalent raw control configuration bytes change the digest without joining source/Git inventory", () => {
  const root = fixture();
  try {
    const config = loadConfig(root); const before = captureQualifiedAnalysisInputs(config);
    const path = join(root, ".semctx/config.json"); const bytes = readFileSync(path);
    writeFileSync(path, ` \n${bytes.toString()}\n`);
    expect(loadConfig(root)).toEqual(config);
    expect(captureQualifiedAnalysisInputs(loadConfig(root)).digest).not.toBe(before.digest);
    expect(captureQualifiedAnalysisInputs(config).files.some(file => file.path.startsWith(".semctx/"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const boundary of ["indexed", "after-analysis"]) test(`raw control byte drift refuses at ${boundary}`, () => {
  const root = fixture();
  try {
    indexRepository(root, "2026-10-11T10:00:00.000Z");
    const path = join(root, ".semctx/config.json"); const bytes = readFileSync(path);
    const change = (): void => { writeFileSync(path, ` \n${bytes.toString()}\n`); };
    if (boundary === "indexed") change(); else __setVerifyAnalysisBarrierForTesting(change);
    const report = runVerify(root, { kind: "working-tree" }).report;
    console.info(JSON.stringify({ boundary, admission: report.analysisAdmission }));
    expect(report.analysisAdmission?.status).toBe("rejected");
    if (boundary === "after-analysis") expect(report.analysisAdmission?.checkFreshness.status).toBe("changed");
  } finally { __setVerifyAnalysisBarrierForTesting(undefined); rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test("missing and malformed raw configuration remain distinguishable and other controls stay excluded", () => {
  const root = fixture();
  try {
    const config = loadConfig(root); const path = join(root, ".semctx/config.json");
    const present = captureQualifiedAnalysisInputs(config);
    writeFileSync(join(root, ".semctx/report.json"), "changed report bytes");
    expect(captureQualifiedAnalysisInputs(config).digest).toBe(present.digest);
    writeFileSync(path, "malformed raw configuration");
    const malformed = captureQualifiedAnalysisInputs(config);
    expect(malformed.digest).not.toBe(present.digest);
    expect(malformed.configurationInput.state).toBe("present");
    expect(() => loadConfig(root)).toThrow();
    rmSync(path);
    const absent = captureQualifiedAnalysisInputs(config);
    expect(absent.configurationInput.state).toBe("absent");
    expect(absent.digest).not.toBe(malformed.digest);
    expect(() => loadConfig(root)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
