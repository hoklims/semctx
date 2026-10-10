import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig, SemctxError } from "@semantic-context/core";
import { initWorkspace, openStore, verificationStatePath } from "@semantic-context/repository-store";
import { ensureSemanticGitignore } from "@semantic-context/semantic-engine";
import { captureRecordableVerificationGitState, checkSemanticState, controlStatusExplained, indexRepository } from "../src";
import { CONTROL_INDEX_SNAPSHOT_META_KEY } from "../src/freshness";
import { __setIndexRepositoryCaptureBarrierForTesting } from "../src/indexing";
import { recoverIndexEvidence, recoverIndexEvidenceAsync } from "../src/index-recovery";
import { recordVerificationState, __setVerificationTemporaryNameForTesting } from "../src/verification-recording";
import { __setVerifyCaptureBarrierForTesting, __setVerifyAnalysisBarrierForTesting, __setVerifyControlBarrierForTesting } from "../src/verify";

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", ...args],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-index-recovery-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 1;\n}\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");
  initWorkspace(root, createDefaultConfig(root));
  indexRepository(root, "2026-09-13T00:00:00.000Z");
  return root;
}

/** Record a v3 baseline that matches the repository's current state (not yet stale). */
function recordCurrentBaseline(root: string, recordedAt: string): void {
  recordVerificationState(root, "PASS", captureRecordableVerificationGitState(root), recordedAt);
}

afterEach(() => {
  __setVerificationTemporaryNameForTesting(undefined);
  __setVerifyCaptureBarrierForTesting(undefined);
  __setVerifyAnalysisBarrierForTesting(undefined);
  __setVerifyControlBarrierForTesting(undefined);
  __setIndexRepositoryCaptureBarrierForTesting(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("EVIDENCE_BASELINE_STALE is repairable by ordinary indexing", () => {
  it("rebuilds through a stale baseline without touching the recorded evidence", () => {
    const root = repository();
    recordCurrentBaseline(root, "2026-09-13T00:01:00.000Z");
    expect(checkSemanticState(root).reasonCodes).toEqual([]);

    writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 2;\n}\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "drift");
    expect(checkSemanticState(root).reasonCodes).toEqual(["EVIDENCE_BASELINE_STALE"]);

    const priorEvidence = readFileSync(verificationStatePath(root));
    expect(() => indexRepository(root, "2026-09-13T00:02:00.000Z")).not.toThrow();
    expect(readFileSync(verificationStatePath(root))).toEqual(priorEvidence);
    // The finding still stands: ordinary index repairs the binding, not the evidence.
    expect(checkSemanticState(root).reasonCodes).toEqual(["EVIDENCE_BASELINE_STALE"]);
  });

  it("still refuses to index while a non-staleness lifecycle error is present", () => {
    const root = repository();
    recordCurrentBaseline(root, "2026-09-13T00:01:00.000Z");
    writeFileSync(verificationStatePath(root), "{broken");
    expect(checkSemanticState(root).reasonCodes).toEqual(["EVIDENCE_BASELINE_INVALID"]);

    expect(() => indexRepository(root, "2026-09-13T00:02:00.000Z")).toThrow(
      "semantic model cannot be sealed during indexing",
    );
    // `status` must not prescribe the sealing command that has just refused to run.
    const explanation = controlStatusExplained(root).explanation.find((entry) => entry.code === "EVIDENCE_BASELINE_INVALID");
    expect(explanation).toMatchObject({ reason: "SEMANTIC_LIFECYCLE_INVALID", remedy: null });
  });
});

describe("recoverIndexEvidence / recoverIndexEvidenceAsync", () => {
  it("recovers a dirty (uncommitted) stale baseline in one command and records the actual verdict", () => {
    const root = repository();
    recordCurrentBaseline(root, "2026-09-13T00:01:00.000Z");
    writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 2;\n}\n");
    expect(checkSemanticState(root).reasonCodes).toEqual(["EVIDENCE_BASELINE_STALE"]);

    const outcome = recoverIndexEvidence(root, "2026-09-13T00:02:00.000Z");

    expect(outcome.recordedPath).toBe(verificationStatePath(root));
    expect(outcome.verification.report.verdict).not.toBe("BLOCK");
    expect(checkSemanticState(root).reasonCodes).toEqual([]);

    const persisted = JSON.parse(readFileSync(verificationStatePath(root), "utf8")) as Record<string, unknown>;
    expect(persisted["version"]).toBe(3);
    expect(persisted["recordedAt"]).toBe("2026-09-13T00:02:00.000Z");
    expect(persisted["verdict"]).toBe(outcome.verification.report.verdict);
  });

  it("recovers a baseline made stale only by a moved HEAD (clean working tree), via the async entry point", async () => {
    const root = repository();
    recordCurrentBaseline(root, "2026-09-13T00:01:00.000Z");
    writeFileSync(join(root, "src", "extra.ts"), "export const value = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "moved head");
    expect(checkSemanticState(root).reasonCodes).toEqual(["EVIDENCE_BASELINE_STALE"]);

    const outcome = await recoverIndexEvidenceAsync(root, "2026-09-13T00:03:00.000Z");

    expect(outcome.verification.report.verdict).not.toBe("BLOCK");
    expect(checkSemanticState(root).reasonCodes).toEqual([]);
  }, 30_000);

  it("refuses to record and preserves old evidence when the working tree drifts mid-recovery", () => {
    const root = repository();
    recordCurrentBaseline(root, "2026-09-13T00:01:00.000Z");
    writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 2;\n}\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "drift");
    const priorEvidence = readFileSync(verificationStatePath(root));

    __setVerifyCaptureBarrierForTesting(() => {
      writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 3;\n}\n");
    });

    let thrown: unknown;
    try {
      recoverIndexEvidence(root, "2026-09-13T00:02:00.000Z");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SemctxError);
    expect((thrown as SemctxError).details).toMatchObject({ indexRebuilt: true, evidenceRecorded: false });
    expect((thrown as SemctxError).message).toContain("index rebuilt but evidence was not recorded");
    expect(readFileSync(verificationStatePath(root))).toEqual(priorEvidence);
  });

  it("preserves old evidence and reports no partial marker when the rebuild itself fails (TOCTOU)", () => {
    const root = repository();
    recordCurrentBaseline(root, "2026-09-13T00:01:00.000Z");
    // `assume-unchanged` hides the coming mutation from Git's own diff, so only indexRepository's
    // content-hash TOCTOU guard (unrelated to this ADR, already proven in indexing-toctou.test.ts)
    // can catch it — proving recovery inherits that guard rather than racing past it.
    git(root, "update-index", "--assume-unchanged", "src/service.ts");
    const priorEvidence = readFileSync(verificationStatePath(root));

    __setIndexRepositoryCaptureBarrierForTesting(() => {
      writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 9;\n}\n");
    });

    let thrown: unknown;
    try {
      recoverIndexEvidence(root, "2026-09-13T00:02:00.000Z");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SemctxError);
    expect((thrown as SemctxError).code).toBe("GIT_ERROR");
    expect((thrown as SemctxError).message).toBe("repository inputs changed while the index was being built");
    // The rebuild never completed, so this is not the recovery's own partial-outcome shape.
    expect((thrown as SemctxError).details["indexRebuilt"]).toBeUndefined();
    expect(readFileSync(verificationStatePath(root))).toEqual(priorEvidence);
  });

  it("refuses to record when a second writer replaces the persisted index mid-recovery", () => {
    const root = repository();
    recordCurrentBaseline(root, "2026-09-13T00:01:00.000Z");
    writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 2;\n}\n");
    const priorEvidence = readFileSync(verificationStatePath(root));

    __setVerifyCaptureBarrierForTesting(() => {
      const store = openStore(root);
      try {
        const raw = store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY);
        if (raw === undefined) throw new Error("fixture has no persisted control index snapshot");
        const forged = { ...JSON.parse(raw), capturedAt: "1999-01-01T00:00:00.000Z" };
        store.setMeta(CONTROL_INDEX_SNAPSHOT_META_KEY, JSON.stringify(forged));
      } finally {
        store.close();
      }
    });

    let thrown: unknown;
    try {
      recoverIndexEvidence(root, "2026-09-13T00:02:00.000Z");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SemctxError);
    expect((thrown as SemctxError).message).toContain("index rebuilt but evidence was not recorded");
    expect((thrown as SemctxError).details["indexRebuilt"]).toBe(true);
    expect((thrown as SemctxError).details["evidenceRecorded"]).toBe(false);
    expect(readFileSync(verificationStatePath(root))).toEqual(priorEvidence);
  });

  it("refuses to record when the tracked .semctx/config.json drifts mid-recovery", () => {
    const root = repository();
    recordCurrentBaseline(root, "2026-09-13T00:01:00.000Z");
    // Track .semctx/config.json (#82) so a config edit is part of the analyzed content state,
    // proving the drift check is not source-file-specific.
    ensureSemanticGitignore(root);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "track config");
    const priorEvidence = readFileSync(verificationStatePath(root));

    __setVerifyCaptureBarrierForTesting(() => {
      const configFile = join(root, ".semctx", "config.json");
      const config = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
      writeFileSync(configFile, `${JSON.stringify({ ...config, driftedForTest: true }, null, 2)}\n`);
    });

    let thrown: unknown;
    try {
      recoverIndexEvidence(root, "2026-09-13T00:02:00.000Z");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SemctxError);
    expect((thrown as SemctxError).details).toMatchObject({ indexRebuilt: true, evidenceRecorded: false });
    expect((thrown as SemctxError).message).toContain("index rebuilt but evidence was not recorded");
    expect(readFileSync(verificationStatePath(root))).toEqual(priorEvidence);
  });

  it("refuses analyzed index content drift even when snapshot metadata is unchanged", () => {
    const root = repository();
    recordCurrentBaseline(root, "2026-09-13T00:01:00.000Z");
    writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 2;\n}\n");
    const previous = readFileSync(verificationStatePath(root));
    __setVerifyCaptureBarrierForTesting(() => {
      const store = openStore(root);
      try {
        const snapshot = store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY);
        const repositoryNodes = store.loadGraph().nodes.filter((node) => node.kind === "repository");
        expect(repositoryNodes.length).toBeGreaterThan(0);
        store.saveGraph({ nodes: repositoryNodes, edges: [] }, []);
        expect(store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY)).toBe(snapshot);
      } finally {
        store.close();
      }
    });
    expect(() => recoverIndexEvidence(root, "2026-09-13T00:02:00.000Z"))
      .toThrow("index rebuilt but evidence was not recorded");
    expect(readFileSync(verificationStatePath(root))).toEqual(previous);
  });

  it("preserves the previous evidence when the atomic writer cannot claim its temporary file", () => {
    const root = repository();
    recordCurrentBaseline(root, "2026-09-13T00:01:00.000Z");
    writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 2;\n}\n");
    const previous = readFileSync(verificationStatePath(root));
    // Invoke the real O_EXCL writer against an existing file: no mocked success or platform ACL.
    __setVerificationTemporaryNameForTesting((path) => path);
    let failure: unknown;
    try {
      recoverIndexEvidence(root, "2026-09-13T00:02:00.000Z");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SemctxError);
    expect((failure as SemctxError).details).toMatchObject({ indexRebuilt: true, evidenceRecorded: false });
    expect((failure as SemctxError).message).toContain("EEXIST");
    expect(readFileSync(verificationStatePath(root))).toEqual(previous);
  });

  it("refuses an index A-B-A race even after the original persisted graph is restored", () => {
    const root = repository();
    recordCurrentBaseline(root, "2026-09-13T00:01:00.000Z");
    writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 2;\n}\n");
    const previous = readFileSync(verificationStatePath(root));
    __setVerifyCaptureBarrierForTesting(() => {
      const store = openStore(root);
      try {
        const originalGraph = store.loadGraph();
        const originalEvidence = store.loadEvidence();
        store.saveGraph({ nodes: originalGraph.nodes.filter((node) => node.kind === "repository"), edges: [] }, []);
        __setVerifyAnalysisBarrierForTesting(() => {
          const writer = openStore(root);
          try { writer.saveGraph(originalGraph, originalEvidence); } finally { writer.close(); }
        });
      } finally { store.close(); }
    });
    let failure: unknown;
    try { recoverIndexEvidence(root, "2026-09-13T00:02:00.000Z"); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SemctxError);
    expect((failure as SemctxError).details.reason).toBe("RECOVERY_ANALYZED_INDEX_MISMATCH");
    expect(readFileSync(verificationStatePath(root))).toEqual(previous);
  });

  it("refuses a baseline A-B-A race after the lifecycle probe consumes different evidence", () => {
    const root = repository();
    recordCurrentBaseline(root, "2026-09-13T00:01:00.000Z");
    writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 2;\n}\n");
    const baselinePath = verificationStatePath(root);
    const previous = readFileSync(baselinePath);
    __setVerifyCaptureBarrierForTesting(() => {
      rmSync(baselinePath);
      __setVerifyControlBarrierForTesting(() => writeFileSync(baselinePath, previous));
    });
    let failure: unknown;
    try { recoverIndexEvidence(root, "2026-09-13T00:02:00.000Z"); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SemctxError);
    expect((failure as SemctxError).details.reason).toBe("RECOVERY_ANALYZED_SEMANTIC_INPUT_MISMATCH");
    expect(readFileSync(baselinePath)).toEqual(previous);
  });

  it("leaves no evidence and no partial-rebuild marker when the pre-rebuild snapshot itself refuses (untracked file)", () => {
    const root = repository();
    recordCurrentBaseline(root, "2026-09-13T00:01:00.000Z");
    writeFileSync(join(root, "src", "untracked.ts"), "export const value = 1;\n");

    let thrown: unknown;
    try {
      recoverIndexEvidence(root, "2026-09-13T00:02:00.000Z");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SemctxError);
    expect((thrown as SemctxError).code).toBe("INVALID_TASK_INPUT");
    // Refused before any rebuild started: no partial-outcome marker to report.
    expect((thrown as SemctxError).details["indexRebuilt"]).toBeUndefined();
  });
});
