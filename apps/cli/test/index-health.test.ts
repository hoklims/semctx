import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUnresolvedReferenceIndex,
  fingerprintRepositoryFacts,
  indexHealth,
  indexRepository,
} from "@semantic-context/app-services";
import { digestCanonical, type PlaneASidecarV1 } from "@semantic-context/plane-a-internal";
import { openStore, initWorkspace, loadConfig } from "@semantic-context/repository-store";
import { initSemanticScaffold } from "@semantic-context/semantic-engine";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { TYPESCRIPT_DIALECT_VERSION } from "@semantic-context/ts-analyzer";
import type { WorkspaceProjection } from "@semantic-context/workspace-analyzer-internal";
import {
  createPlaneAIndexSnapshot,
} from "../../../packages/app-services/src/index-health";
import {
  CONTROL_INDEX_SNAPSHOT_META_KEY,
  PLANE_A_INDEX_SNAPSHOT_META_KEY,
} from "../../../packages/app-services/src/freshness";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const CAPTURED_AT = "2026-07-28T00:00:00.000Z";
let root: string;

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

function run(args: string[]): { code: number; out: string } {
  const result = Bun.spawnSync(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? 1,
    out: new TextDecoder().decode(result.stdout),
  };
}

function workspace(): WorkspaceProjection {
  return {
    schemaVersion: 1,
    repositoryId: "repository:test",
    nodes: [],
    edges: [],
    candidates: [],
    diagnostics: [],
  };
}

function sidecar(partial: boolean): PlaneASidecarV1 {
  const producer = {
    identity: "@semantic-context/ts-analyzer",
    version: "0.1.0",
  };
  const sourceDigest = digestCanonical({ fixture: "source" });
  const selectedPathSetDigest = digestCanonical(["src/booking/confirmation.ts"]);
  const producerConfigurationDigest = digestCanonical(loadConfig(root));
  const factSchemaDigest = digestCanonical({
    schemaVersion: 1,
    facts: ["node", "edge"],
    evidence: "source-lines-v1",
  });
  const scope = {
    repositoryIdentity: "repository:test",
    sourceStateDigest: sourceDigest,
    selectedPathSetDigest,
    selectedPaths: ["src/booking/confirmation.ts"],
    language: "typescript",
    dialectVersion: TYPESCRIPT_DIALECT_VERSION,
  };
  const profile = {
    profileId: "profile:test",
    factKind: "module",
    scope,
    producer,
    producerConfigurationDigest,
    factSchemaDigest,
    evidenceContract: "source-lines-v1",
    resolutionSemantics: "typescript-static-v1",
    soundnessClaim: "best-effort-static",
    completenessClaim: "producer-declared",
    negativeEvidenceEligible: !partial,
    label: "structural",
  };
  const batchId = "batch:test";
  return {
    schemaVersion: 1,
    scope,
    producerConfigurationDigest,
    factSchemaDigest,
    sourceDigest,
    capabilityProfiles: [profile],
    discoveryLedger: [{
      candidateIdentity: "typescript:src/booking/confirmation.ts",
      scope,
      selectionDecision: "selected",
      analysisOutcome: "analyzed",
      selectionReasons: [],
      analysisReasons: [],
      selectedProducer: producer,
    }],
    producerResults: [{
      resultId: "result:test",
      status: "completed",
      producer,
      scope,
      factBatchId: batchId,
    }],
    factBatches: [{
      schemaVersion: 1,
      batchId,
      scope,
      producer,
      producerConfigurationDigest,
      factSchemaDigest,
      sourceDigest,
      factKinds: ["module"],
      capabilityProfileIds: [profile.profileId],
      evidenceContract: profile.evidenceContract,
      facts: [],
    }],
  };
}

function writeSnapshot(partial: boolean): void {
  const store = openStore(root);
  try {
    const repositoryGraphHash = fingerprintRepositoryFacts({
      graph: store.loadGraph(),
      evidence: store.loadEvidence(),
      claims: store.loadClaims(),
    });
    const snapshot = createPlaneAIndexSnapshot({
      capturedAt: CAPTURED_AT,
      repositoryGraphHash,
      unresolvedReferenceIndexHash: createUnresolvedReferenceIndex([]).indexHash,
      sidecar: sidecar(partial),
      workspace: workspace(),
    });
    store.setMeta(PLANE_A_INDEX_SNAPSHOT_META_KEY, JSON.stringify(snapshot));
    // Authorize the substituted snapshot from the control snapshot as indexing would: this fixture
    // simulates a partially analysed index, not a rewritten one, and an unauthorized Plane-A
    // snapshot is refused at either config version.
    const controlSnapshot = JSON.parse(
      store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY)!,
    ) as { planeAIndexSnapshotHash?: string };
    controlSnapshot.planeAIndexSnapshotHash = digestCanonical(snapshot);
    store.setMeta(CONTROL_INDEX_SNAPSHOT_META_KEY, JSON.stringify(controlSnapshot));
  } finally {
    store.close();
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-index-health-cli-"));
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
  });
  git(root, "init");
  initWorkspace(root);
  initSemanticScaffold(root);
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Semctx Test",
    "-c",
    "user.email=semctx@example.test",
    "commit",
    "-m",
    "fixture",
  );
  indexRepository(root, CAPTURED_AT);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("index-health CLI", () => {
  it("lists the additive command in help without changing status routing", () => {
    const result = run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("index-health [--json]");
    expect(result.out).toContain("status [--json]");
  });

  it("emits the shared report unchanged as JSON and exits 2 for valid partial coverage", () => {
    writeSnapshot(true);
    const expected = indexHealth(root);
    const result = run(["index-health", "--root", root, "--json"]);

    expect(expected.binding.status).toBe("valid");
    expect(expected.freshness.canRunHighRiskControl).toBe(true);
    expect(expected.coverage.status).toBe("partial");
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out)).toEqual(expected);
  });

  it("keeps freshness and coverage separate in concise text", () => {
    writeSnapshot(true);
    const result = run(["index-health", "--root", root]);

    expect(result.code).toBe(2);
    expect(result.out).toContain("binding              valid");
    expect(result.out).toContain("freshness            FRESH");
    expect(result.out).toContain("coverage             partial");
    expect(result.out).toContain("outcomes             analyzed 1");
    expect(result.out).toContain("workspace diagnostics 0");
    expect(result.out).toContain("top coverage reasons");
    expect(result.out).toContain("top freshness reasons");
  });

  it("exits 0 only when binding, freshness, and coverage all admit it", () => {
    writeSnapshot(false);
    const report = indexHealth(root);
    const result = run(["index-health", "--root", root, "--json"]);

    expect(report).toMatchObject({
      binding: { status: "valid" },
      freshness: { canRunHighRiskControl: true },
      coverage: { status: "complete" },
    });
    expect(result.code).toBe(0);
  });

  it("exits 3 for an absent or otherwise insufficient index health binding", () => {
    const uninitialized = mkdtempSync(join(tmpdir(), "semctx-index-health-empty-"));
    try {
      const result = run(["index-health", "--root", uninitialized, "--json"]);
      expect(result.code).toBe(3);
      expect(JSON.parse(result.out)).toMatchObject({
        binding: { status: "absent" },
        coverage: { status: "insufficient" },
      });
    } finally {
      rmSync(uninitialized, { recursive: true, force: true });
    }
  });
});
