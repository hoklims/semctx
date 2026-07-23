import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "@semantic-context/repository-store";
import {
  activeChangePath,
  newChangeContract,
  writeActiveChange,
  writeChangeFile,
} from "@semantic-context/semantic-engine";
import { captureVerificationGitState, checkSemanticState, indexRepository } from "../src";

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "semctx-lifecycle-"));
  roots.push(dir);
  writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  writeFileSync(join(dir, ".gitignore"), ".semctx/\n", "utf8");
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  Bun.spawnSync(["git", "add", "README.md"], { cwd: dir });
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"], { cwd: dir });
  initWorkspace(dir);
  return dir;
}

function change(id: string, lifecycle: "active" | "verified" | "superseded" = "active", statement = id) {
  return newChangeContract({ id, statement, lifecycle, provenance: "author" });
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("semantic lifecycle hygiene", () => {
  it("checks an unprepared repository without creating readiness state", () => {
    const dir = mkdtempSync(join(tmpdir(), "semctx-lifecycle-unprepared-"));
    roots.push(dir);

    const report = checkSemanticState(dir);

    expect(report.graphIndexed).toBe(false);
    expect(report.ok).toBe(true);
    expect(existsSync(join(dir, ".semctx"))).toBe(false);
  });

  it("treats terminal contracts without a pointer as normal closed history", () => {
    const dir = root();
    writeChangeFile(dir, change("change.closed", "verified"));
    writeChangeFile(dir, change("change.replaced", "superseded"));

    const report = checkSemanticState(dir);
    expect(report.schemaVersion).toBe(1);
    expect(report.kind).toBe("semantic_check");
    expect(report.reasonCodes).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("distinguishes missing, invalid and mismatched active pointers", () => {
    const missingRoot = root();
    const active = change("change.current");
    writeChangeFile(missingRoot, active);
    expect(checkSemanticState(missingRoot).reasonCodes).toEqual(["ACTIVE_CHANGE_POINTER_MISSING"]);

    const invalidRoot = root();
    writeChangeFile(invalidRoot, active);
    writeActiveChange(invalidRoot, active);
    writeFileSync(activeChangePath(invalidRoot), "not a semantic block\n", "utf8");
    expect(checkSemanticState(invalidRoot).reasonCodes).toEqual(["ACTIVE_CHANGE_POINTER_INVALID"]);

    const mismatchRoot = root();
    writeChangeFile(mismatchRoot, active);
    writeActiveChange(mismatchRoot, { ...active, statement: "working copy drifted" });
    expect(checkSemanticState(mismatchRoot).reasonCodes).toEqual(["ACTIVE_CHANGE_POINTER_MISMATCH"]);
  });

  it("reports obsolete non-selected or closed active state", () => {
    const extraRoot = root();
    const selected = change("change.selected");
    writeChangeFile(extraRoot, selected);
    writeChangeFile(extraRoot, change("change.forgotten"));
    writeActiveChange(extraRoot, selected);
    const extra = checkSemanticState(extraRoot);
    expect(extra.reasonCodes).toEqual(["ACTIVE_CHANGE_OBSOLETE"]);
    expect(extra.lifecycleFindings[0]?.subjectIds).toEqual(["change.forgotten"]);

    const closedRoot = root();
    const closed = change("change.closed", "verified");
    writeChangeFile(closedRoot, closed);
    writeActiveChange(closedRoot, closed);
    expect(checkSemanticState(closedRoot).reasonCodes).toEqual(["ACTIVE_CHANGE_OBSOLETE"]);
  });

  it("detects invalid and stale evidence baselines with canonical reason ordering", () => {
    const invalidRoot = root();
    writeFileSync(join(invalidRoot, ".semctx", "verification-state.json"), "{broken", "utf8");
    expect(checkSemanticState(invalidRoot).reasonCodes).toEqual(["EVIDENCE_BASELINE_INVALID"]);

    const legacyRoot = root();
    writeFileSync(
      join(legacyRoot, ".semctx", "verification-state.json"),
      `${JSON.stringify({
        version: 1,
        diffHash: `sha256:${"0".repeat(64)}`,
        verdict: "PASS",
        recordedAt: "2026-07-23T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    expect(checkSemanticState(legacyRoot).reasonCodes).toEqual(["EVIDENCE_BASELINE_INVALID"]);

    const staleRoot = root();
    mkdirSync(join(staleRoot, ".semctx", "working"), { recursive: true });
    writeFileSync(activeChangePath(staleRoot), "not a semantic block\n", "utf8");
    writeFileSync(
      join(staleRoot, ".semctx", "verification-state.json"),
      `${JSON.stringify({
        version: 2,
        ...captureVerificationGitState(staleRoot),
        workingStateHash: `sha256:${"0".repeat(64)}`,
        verdict: "PASS",
        recordedAt: "2026-07-23T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    const report = checkSemanticState(staleRoot);
    expect(report.reasonCodes).toEqual(["ACTIVE_CHANGE_POINTER_INVALID", "EVIDENCE_BASELINE_STALE"]);
    expect(report.lifecycleFindings.map((finding) => finding.code)).toEqual([
      "ACTIVE_CHANGE_POINTER_INVALID",
      "EVIDENCE_BASELINE_STALE",
    ]);
    expect(report.lifecycleFindings.find((finding) => finding.code === "EVIDENCE_BASELINE_STALE")?.message)
      .toBe("The recorded verification baseline does not match the current commit-bound working state.");
  });

  it("invalidates evidence baselines after HEAD movement or an untracked source change", () => {
    const movedHead = root();
    writeFileSync(
      join(movedHead, ".semctx", "verification-state.json"),
      `${JSON.stringify({
        version: 2,
        ...captureVerificationGitState(movedHead),
        verdict: "PASS",
        recordedAt: "2026-07-23T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    expect(checkSemanticState(movedHead).reasonCodes).toEqual([]);
    writeFileSync(join(movedHead, "NEXT.md"), "next\n", "utf8");
    Bun.spawnSync(["git", "add", "NEXT.md"], { cwd: movedHead });
    Bun.spawnSync(
      ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "next"],
      { cwd: movedHead },
    );
    expect(checkSemanticState(movedHead).reasonCodes).toEqual(["EVIDENCE_BASELINE_STALE"]);

    const untracked = root();
    writeFileSync(
      join(untracked, ".semctx", "verification-state.json"),
      `${JSON.stringify({
        version: 2,
        ...captureVerificationGitState(untracked),
        verdict: "PASS",
        recordedAt: "2026-07-23T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    writeFileSync(join(untracked, "untracked-source.ts"), "export const value = 1;\n", "utf8");
    expect(checkSemanticState(untracked).reasonCodes).toEqual(["EVIDENCE_BASELINE_STALE"]);
  });

  it("refuses to seal an index while lifecycle inputs are invalid", () => {
    const dir = root();
    const active = change("change.current");
    writeChangeFile(dir, active);
    writeActiveChange(dir, { ...active, statement: "pointer drift" });

    expect(() => indexRepository(dir, "2026-07-23T00:00:00.000Z")).toThrow(
      "semantic model cannot be sealed during indexing",
    );
  });
});
