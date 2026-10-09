import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexHealth, indexRepository, runVerify } from "../src";
import {
  REGISTERED_PLANE_A_AUTHORITY_COUNT,
  isPlaneAOperationAdmitted,
} from "../src/plane-a-authority-policy";

const scope = {
  repositoryIdentity: "repo:fixture",
  sourceStateDigest: "sha256:source",
  selectedPathSetDigest: "sha256:paths",
  selectedPaths: ["src/value.ts"],
  language: "typescript",
  dialectVersion: "5.9.3",
} as const;

function admitted(
  overrides: Partial<Parameters<typeof isPlaneAOperationAdmitted>[0]> = {},
): boolean {
  return isPlaneAOperationAdmitted({
    configVersion: 2,
    task: "verify",
    operation: "change",
    factKind: "function",
    scope,
    ...overrides,
  });
}

describe("independent Plane A task-relative authority policy", () => {
  it("admits only the explicit current policy surface", () => {
    expect(REGISTERED_PLANE_A_AUTHORITY_COUNT).toBe(107);
    expect(admitted()).toBe(true);
    expect(admitted({
      scope: {
        ...scope,
        selectedPaths: ["src/value.py"],
        language: "python",
        dialectVersion: "<=3.12",
      },
    })).toBe(true);
  });

  it("registers only the qualified JavaScript verify/change fact tuples", () => {
    const javascript = { ...scope, language: "javascript", selectedPaths: ["scripts/value.mjs"] };
    expect(admitted({ scope: javascript })).toBe(true);
    for (const overrides of [
      { configVersion: 1 as const }, { task: "execute" }, { operation: "approve" },
      { factKind: "runtime_execution" }, { scope: { ...javascript, dialectVersion: "5.8.0" } },
    ]) expect(admitted({ scope: javascript, ...overrides })).toBe(false);
  });

  it("admits genuinely indexed mixed ESM facts only after refreshing the changed sources", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-js-operation-admission-"));
    const git = (...args: string[]): void => {
      const process = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (process.exitCode !== 0) throw new Error(new TextDecoder().decode(process.stderr));
    };
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, ".gitignore"), ".semctx/\n");
      writeFileSync(join(root, "src/value.mjs"), "export function value() { return 1; }\n");
      writeFileSync(join(root, "src/consumer.ts"), "import { value } from './value.mjs'; export function consumer() { return value(); }\n");
      git("init", "-q"); git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
      initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*.ts", "src/**/*.mjs"], languages: { typescript: "on", javascript: "on" } });
      indexRepository(root, "2026-10-09T10:00:00.000Z");
      writeFileSync(join(root, "src/value.mjs"), "export function value() { return 2; }\n");
      expect(runVerify(root, { kind: "working-tree" }).report.analysisAdmission?.status).toBe("rejected");
      indexRepository(root, "2026-10-09T10:01:00.000Z");
      const report = runVerify(root, { kind: "working-tree" }).report;
      expect(report.analysisAdmission?.status).toBe("admitted");
      expect(report.analysisAdmission?.changeCoverage.analyzed).toEqual(["src/consumer.ts", "src/value.mjs"]);
      const health = indexHealth(root);
      const javascriptCandidate = health.candidates.find((candidate) => candidate.path === "src/value.mjs")!;
      const evaluations = health.evaluations.decisions.filter((decision) => decision.candidateIdentity === javascriptCandidate.candidateIdentity);
      expect(evaluations.length).toBeGreaterThan(0);
      expect(evaluations.every((decision) => decision.gates.taskRelativeAuthority === "passed")).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);

  it("denies unknown task, operation, language, dialect, fact kind, and config tuples", () => {
    expect(admitted({ task: "index-health", operation: "inspect" })).toBe(false);
    expect(admitted({ operation: "delete" })).toBe(false);
    expect(admitted({ scope: { ...scope, language: "ruby" } })).toBe(false);
    expect(admitted({ scope: { ...scope, dialectVersion: "5.8.0" } })).toBe(false);
    expect(admitted({ factKind: "analysis" })).toBe(false);
    expect(admitted({
      configVersion: 1,
      scope: {
        ...scope,
        selectedPaths: ["src/value.py"],
        language: "python",
        dialectVersion: "<=3.12",
      },
    })).toBe(false);
  });
});
