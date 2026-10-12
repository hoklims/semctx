import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexHealth, indexRepository, runVerify } from "../src";
import { __setVerifyAnalysisBarrierForTesting } from "../src/verify";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-template-capture-"));
  mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  }
  initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
  writeFileSync(join(root, "src/main.ts"), "export function main() { return 2; }\n");
  return root;
}
for (const language of ["ts", "js"]) for (const selected of [true, false]) test(`qualified tagged template ${language}, selected ${selected}, cannot claim complete invocation analysis`, () => {
  const root = fixture();
  try {
    const path = `${selected ? "src/" : ""}render.${language}`;
    writeFileSync(join(root, path), "export function tag(parts) { return parts[0]; } export function render() { return tag`value`; }\n");
    indexRepository(root, "2026-10-10T10:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    console.info(JSON.stringify({ path, status: report.analysisAdmission?.status, reasons: report.analysisAdmission?.reasons }));
    expect(report.analysisAdmission?.status).toBe("rejected");
    expect(report.analysisAdmission?.reasons.some(reason => reason.includes("TAGGED_TEMPLATE_UNSUPPORTED"))).toBe(true);
    if (selected) expect(indexHealth(root).candidates.find(candidate => candidate.path === path)?.analysisReasons.some(reason => reason.includes("TAGGED_TEMPLATE_UNSUPPORTED"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test("qualified verification keeps three fresh boundaries and only its useful selected discovery", () => {
  const root = fixture(); const spawn = Bun.spawnSync;
  indexRepository(root, "2026-10-10T10:00:00.000Z");
  let directDiscoveries = 0; let directCaptures = 0;
  const processSpy = spyOn(Bun, "spawnSync").mockImplementation(((...args: Parameters<typeof spawn>) => {
    const command = args[0];
    if (Array.isArray(command) && command.includes("--exclude-per-directory=.gitignore")) {
      const frames = new Error().stack?.split("\n") ?? [];
      const discoverFrame = frames.findIndex(frame => frame.includes("at discoverRepository "));
      const captureFrame = frames.findIndex(frame => frame.includes("at captureQualifiedAnalysisInputs "));
      if (discoverFrame >= 0 && frames[discoverFrame + 1]?.includes("at runVerify ")) directDiscoveries++;
      if (captureFrame >= 0 && frames[captureFrame + 1]?.includes("at runVerify ")) directCaptures++;
    }
    return spawn(...args);
  }) as typeof spawn);
  try {
    expect(runVerify(root, { kind: "working-tree" }).report.analysisAdmission?.status).toBe("admitted");
    console.info(JSON.stringify({ directDiscoveries, directCaptures }));
    expect(directDiscoveries).toBe(1);
    expect(directCaptures).toBe(3);
  } finally { processSpy.mockRestore(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
for (const mutation of ["source", "config", "inventory"]) test(`fresh qualified after-analysis capture refuses ${mutation} drift`, () => {
  const root = fixture();
  try {
    indexRepository(root, "2026-10-10T10:00:00.000Z");
    __setVerifyAnalysisBarrierForTesting(() => {
      if (mutation === "source") writeFileSync(join(root, "src/main.ts"), "export function main() { return 3; }\n");
      else if (mutation === "inventory") writeFileSync(join(root, "hidden.ts"), "export function hidden() { return 1; }\n");
      else writeFileSync(join(root, ".semctx/config.json"), JSON.stringify({ ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], exclude: ["src/unused.ts"], languages: { typescript: "on", javascript: "on" } }));
    });
    const admission = runVerify(root, { kind: "working-tree" }).report.analysisAdmission;
    expect(admission?.status).toBe("rejected"); expect(admission?.checkFreshness.reasons).toContain("CHECK_INPUT_CHANGED");
  } finally { __setVerifyAnalysisBarrierForTesting(undefined); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
test("final qualified capture detects drift after admission instead of reusing an earlier snapshot", () => {
  const root = fixture(); const spawn = Bun.spawnSync;
  indexRepository(root, "2026-10-10T10:00:00.000Z");
  let directCaptures = 0; let mutated = false;
  const processSpy = spyOn(Bun, "spawnSync").mockImplementation(((...args: Parameters<typeof spawn>) => {
    if (Array.isArray(args[0]) && args[0].includes("--exclude-per-directory=.gitignore")) {
      const frames = new Error().stack?.split("\n") ?? [];
      const captureFrame = frames.findIndex(frame => frame.includes("at captureQualifiedAnalysisInputs "));
      if (captureFrame >= 0 && frames[captureFrame + 1]?.includes("at runVerify ") && ++directCaptures === 3) {
        writeFileSync(join(root, "src/main.ts"), "export function main() { return 3; }\n"); mutated = true;
      }
    }
    return spawn(...args);
  }) as typeof spawn);
  try {
    const admission = runVerify(root, { kind: "working-tree" }).report.analysisAdmission;
    expect(mutated).toBe(true); expect(admission?.status).toBe("rejected");
    expect(admission?.checkFreshness.reasons).toContain("CHECK_INPUT_CHANGED");
  } finally { processSpy.mockRestore(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
