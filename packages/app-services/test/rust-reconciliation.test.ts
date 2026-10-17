import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, type TaskFrame } from "@semantic-context/core";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import { newChangeContract, writeChangeFile, writeKindFile } from "@semantic-context/semantic-engine";
import { indexRepository } from "../src";
import { captureControlHandoffV2, resumeControlHandoffV2 } from "../src/control-handoff";
import { explainControlHandoffV2 } from "../src/control-continuation";
import { buildPlanningBundle, reconcileWorkingTreeDetailed } from "../src/reconciliation-index";

test("Rust post-image reconciliation binds a planned edit to reanalyzed source without granting execution", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-reconcile-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "reconcile"\nversion = "0.1.0"\nedition = "2021"\n');
    const sourcePath = "src/lib.rs";
    const source = join(root, sourcePath);
    writeFileSync(source, "pub mod other;\npub fn value() -> u32 { 1 }\n");
    const other = join(root, "src/other.rs");
    writeFileSync(other, "pub fn separate() -> u32 { 3 }\n");
    writeFileSync(join(root, ".gitignore"), ".semctx/\ntarget/\n");
    git("init", "-q");
    initWorkspace(root, { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" } });
    const change = newChangeContract({ id: "change.rust-reconcile", statement: "Adjust Rust value", lifecycle: "draft" });
    writeChangeFile(root, change);
    writeKindFile(root, "goal", [{ id: "goal.rust-reconcile", kind: "goal", statement: "Keep Rust value explicit",
      status: "declared", provenance: "author", sourceRefs: [], repositoryLinks: [], relations: [], tags: [],
      appliesAtLevel: 2 }]);
    git("add", "-A");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    indexRepository(root, "2026-10-17T10:00:00.000Z");
    const frame: TaskFrame = { id: "task.rust-reconcile", rawTask: "Adjust Rust value", mode: "bugfix",
      capabilities: [], observedBehavior: [], expectedBehavior: [], boundedContexts: [], hardInvariants: [],
      softConstraints: [], acceptanceEvidence: [], nonGoals: [], riskSurfaces: [], hypotheses: [],
      createdAt: "2026-10-17T09:00:00.000Z" };
    const store = openStore(root);
    const node = store.loadGraph().nodes.find((item) => item.id === "sym:function:src/lib.rs:value");
    store.saveTaskFrame(frame);
    store.close();
    expect(node).toBeDefined();
    const coordinateId = `repo:${node!.id}` as const;
    const expectation = { schemaVersion: 1 as const, expectationId: "expectation.rust-value",
      kind: "behavior" as const, level: 2 as const, required: true,
      subjectId: "goal.rust-reconcile", statement: "Keep Rust value explicit", acceptanceEvidenceIds: [] };
    const bundle = buildPlanningBundle(root, { schemaVersion: 1, taskFrameId: frame.id, changeId: change.id,
      explicitDiscoveries: [{ coordinateId, repositoryPath: sourcePath, evidenceId: "discovery:rust-value",
        evidenceProvenance: "test", scope: { kind: "file", path: sourcePath } }],
      rollbackDescription: "Restore the committed value", semanticExpectations: [expectation],
      repositoryEditExpectations: [{ schemaVersion: 1, editId: "edit.rust-value", kind: "modify", required: true,
        path: sourcePath, coordinateIds: [coordinateId], expectedLiftedExpectationIds: [expectation.expectationId], acceptanceEvidenceIds: [] }] });
    expect(bundle.executionAuthority).toBe("none");
    writeFileSync(source, readFileSync(source, "utf8").replace("{ 1 }", "{ 2 }"));
    const snapshot = reconcileWorkingTreeDetailed(root, { schemaVersion: 1, planningBundle: bundle });
    expect(snapshot.report.matchedPlannedEdits).toContainEqual(expect.objectContaining({ editId: "edit.rust-value" }));
    expect(snapshot.report.scopeEscapes).toEqual([]);
    expect(snapshot.candidateGraph.nodes).toContainEqual(expect.objectContaining({ id: coordinateId,
      sourceKind: "function" }));
    expect(snapshot.sealedAnalysis.hunkBindings.some((binding) => binding.coordinateIds.includes(coordinateId))).toBe(true);
    expect(snapshot.sealedAnalysis.executionAuthority).toBe("none");
    const handoff = captureControlHandoffV2(root, { schemaVersion: 2, planningBundle: bundle,
      progress: { state: "not_started", currentCoordinateId: "semantic:goal.rust-reconcile" } });
    expect(handoff.status, JSON.stringify(handoff)).toBe("CAPTURED");
    expect(handoff.capsule?.executionAuthority).toBe("none");
    const hash = handoff.capsule?.capsuleHash;
    expect(hash).toBeDefined();
    if (hash === undefined) throw new Error("Rust handoff was not captured");
    expect(resumeControlHandoffV2(root, { schemaVersion: 2, capsuleHash: hash }).status).toBe("RESUMED");
    expect(explainControlHandoffV2(root, { schemaVersion: 1, capsuleHash: hash }).report?.executionAuthority).toBe("none");
    writeFileSync(other, readFileSync(other, "utf8").replace("{ 3 }", "{ 4 }"));
    const escaped = reconcileWorkingTreeDetailed(root, { schemaVersion: 1, planningBundle: bundle });
    expect(escaped.report.scopeEscapes.length).toBeGreaterThan(0);
    expect(escaped.report.terminalStatus).not.toBe("REALIZED");
    expect(explainControlHandoffV2(root, { schemaVersion: 1, capsuleHash: hash }).report?.dependencies)
      .toContainEqual(expect.objectContaining({ dependencyKind: "diff", status: "STALE" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
