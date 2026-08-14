import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, type SemctxConfigV2 } from "@semantic-context/core";
import type { RepositoryGraph } from "@semantic-context/core";
import { digestCanonical } from "@semantic-context/plane-a-internal";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import {
  fingerprintRepositoryFacts,
  indexHealth,
  indexRepository,
  runVerify,
} from "../src";
import {
  CONTROL_INDEX_SNAPSHOT_META_KEY,
  PLANE_A_INDEX_SNAPSHOT_META_KEY,
} from "../src/freshness";

const roots: string[] = [];

interface MutableScope {
  repositoryIdentity: string;
  sourceStateDigest: string;
  selectedPathSetDigest: string;
  selectedPaths: string[];
  workspaceUnitId?: string;
  language: string;
  dialectVersion?: string;
}

interface MutableProducer {
  identity: string;
  version: string;
}

interface MutablePlaneASidecar {
  producerConfigurationDigest: string;
  factSchemaDigest: string;
  capabilityProfiles: {
    profileId: string;
    scope: MutableScope;
    producer: MutableProducer;
    producerConfigurationDigest: string;
    factSchemaDigest: string;
    evidenceContract: string;
    resolutionSemantics: string;
    soundnessClaim: string;
    completenessClaim: string;
  }[];
  factBatches: {
    batchId: string;
    scope: MutableScope;
    producer: MutableProducer;
    producerConfigurationDigest: string;
    factSchemaDigest: string;
    evidenceContract: string;
  }[];
  producerResults: {
    scope: MutableScope;
    producer: MutableProducer;
  }[];
  discoveryLedger: {
    scope: MutableScope;
    selectedProducer?: MutableProducer;
  }[];
}

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

function repository(mode: "on" | "off" = "on"): {
  root: string;
  config: SemctxConfigV2;
} {
  const root = mkdtempSync(join(tmpdir(), "semctx-index-health-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "health-fixture" }, null, 2) + "\n",
  );
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(
    join(root, "src", "service.py"),
    [
      "# @invariant stable-service: Service behavior remains stable.",
      "def service():",
      "    return 1",
      "",
    ].join("\n"),
  );
  git(root, "init", "-q");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Semctx Test",
    "-c",
    "user.email=semctx@example.test",
    "commit",
    "-q",
    "-m",
    "fixture",
  );
  const config: SemctxConfigV2 = {
    ...createGlobSelectionConfig(root),
    include: ["src/**/*.py"],
    languages: {
      typescript: "on",
      python: mode,
      markdown: "on",
      sql: "on",
    },
  };
  initWorkspace(root, config);
  return { root, config };
}

function pythonDiff(): string {
  return [
    "diff --git a/src/service.py b/src/service.py",
    "index 1111111..2222222 100644",
    "--- a/src/service.py",
    "+++ b/src/service.py",
    "@@ -2,2 +2,3 @@",
    " def service():",
    "+    importlib.import_module('runtime_plugin')",
    "     return 1",
    "",
  ].join("\n");
}

function mutateAndResealPlaneA(
  root: string,
  mutate: (sidecar: MutablePlaneASidecar) => void,
): void {
  const store = openStore(root);
  try {
    const planeSnapshot = JSON.parse(
      store.getMeta(PLANE_A_INDEX_SNAPSHOT_META_KEY)!,
    ) as {
      sidecarDigest: string;
      sidecar: MutablePlaneASidecar;
    };
    mutate(planeSnapshot.sidecar);
    planeSnapshot.sidecarDigest = digestCanonical(planeSnapshot.sidecar);
    store.setMeta(
      PLANE_A_INDEX_SNAPSHOT_META_KEY,
      JSON.stringify(planeSnapshot),
    );

    const controlSnapshot = JSON.parse(
      store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY)!,
    ) as { planeAIndexSnapshotHash?: string };
    controlSnapshot.planeAIndexSnapshotHash = digestCanonical(planeSnapshot);
    store.setMeta(
      CONTROL_INDEX_SNAPSHOT_META_KEY,
      JSON.stringify(controlSnapshot),
    );
  } finally {
    store.close();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("IndexHealth persistence and verification preflight", () => {
  it("reports binding, freshness, coverage, candidates, and manifest workspaces separately", () => {
    const { root } = repository();
    indexRepository(root, "2026-07-28T10:00:00.000Z");

    const report = indexHealth(root);

    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: "index_health",
      binding: { status: "valid" },
      freshness: { verdict: "FRESH", canRunHighRiskControl: true },
      coverage: {
        status: "partial",
        selected: 1,
        analyzed: 1,
        disabled: 0,
        unsupported: 0,
        failed: 0,
      },
    });
    expect(report.candidates.find((candidate) => candidate.path === "src/service.py"))
      .toMatchObject({
        selectionDecision: "selected",
        analysisOutcome: "analyzed",
        language: "python",
        negativeEvidenceEligible: false,
      });
    expect(report.workspace?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "package", identity: "health-fixture" }),
    ]));
    expect(report.reasonSummary).toContain("NEGATIVE_COMPLETENESS_MISSING");
  });

  it("fails closed when the atomically persisted sidecar binding is tampered", () => {
    const { root } = repository();
    indexRepository(root, "2026-07-28T10:01:00.000Z");
    const store = openStore(root);
    try {
      const raw = JSON.parse(store.getMeta(PLANE_A_INDEX_SNAPSHOT_META_KEY)!) as {
        sidecarDigest: string;
      };
      store.setMeta(
        PLANE_A_INDEX_SNAPSHOT_META_KEY,
        JSON.stringify({ ...raw, sidecarDigest: `sha256:${"0".repeat(64)}` }),
      );
    } finally {
      store.close();
    }

    expect(indexHealth(root)).toMatchObject({
      binding: { status: "invalid" },
      coverage: { status: "insufficient" },
      reasonSummary: expect.arrayContaining(["BINDING_INVALID"]),
    });
  });

  it("reports an invalid binding for a malformed persisted control snapshot", () => {
    const { root } = repository();
    indexRepository(root, "2026-07-28T10:01:05.000Z");
    const store = openStore(root);
    try {
      store.setMeta(CONTROL_INDEX_SNAPSHOT_META_KEY, "{");
    } finally {
      store.close();
    }

    expect(indexHealth(root)).toMatchObject({
      binding: { status: "invalid" },
      freshness: { verdict: "UNSEALED", canRunHighRiskControl: false },
      coverage: { status: "insufficient" },
      reasonSummary: expect.arrayContaining(["BINDING_INVALID"]),
    });
  });

  it("rejects a deeply malformed sidecar even when its digest is recomputed", () => {
    const { root } = repository();
    indexRepository(root, "2026-07-28T10:01:10.000Z");
    const store = openStore(root);
    try {
      const raw = JSON.parse(store.getMeta(PLANE_A_INDEX_SNAPSHOT_META_KEY)!) as {
        sidecarDigest: string;
        sidecar: {
          discoveryLedger: { scope: { selectedPaths: unknown[] } }[];
        };
      };
      raw.sidecar.discoveryLedger[0]!.scope.selectedPaths = [42];
      raw.sidecarDigest = digestCanonical(raw.sidecar);
      store.setMeta(PLANE_A_INDEX_SNAPSHOT_META_KEY, JSON.stringify(raw));
    } finally {
      store.close();
    }

    expect(indexHealth(root)).toMatchObject({
      binding: { status: "invalid" },
      coverage: { status: "insufficient" },
      reasonSummary: expect.arrayContaining(["BINDING_INVALID"]),
    });
  });

  it("rejects deeply malformed workspace evidence even when its digest is recomputed", () => {
    const { root } = repository();
    indexRepository(root, "2026-07-28T10:01:20.000Z");
    const store = openStore(root);
    try {
      const raw = JSON.parse(store.getMeta(PLANE_A_INDEX_SNAPSHOT_META_KEY)!) as {
        workspaceDigest: string;
        workspace: {
          nodes: { evidence: { value: unknown }[] }[];
        };
      };
      raw.workspace.nodes[0]!.evidence[0]!.value = [42];
      raw.workspaceDigest = digestCanonical(raw.workspace);
      store.setMeta(PLANE_A_INDEX_SNAPSHOT_META_KEY, JSON.stringify(raw));
    } finally {
      store.close();
    }

    expect(indexHealth(root)).toMatchObject({
      binding: { status: "invalid" },
      coverage: { status: "insufficient" },
      reasonSummary: expect.arrayContaining(["BINDING_INVALID"]),
    });
  });

  it("rejects analyzed candidates without exactly one result and corresponding fact batch", () => {
    const { root } = repository();
    indexRepository(root, "2026-07-28T10:01:30.000Z");
    const store = openStore(root);
    try {
      const raw = JSON.parse(store.getMeta(PLANE_A_INDEX_SNAPSHOT_META_KEY)!) as {
        sidecarDigest: string;
        sidecar: {
          producerResults: unknown[];
          factBatches: unknown[];
        };
      };
      raw.sidecar.producerResults = [];
      raw.sidecar.factBatches = [];
      raw.sidecarDigest = digestCanonical(raw.sidecar);
      store.setMeta(PLANE_A_INDEX_SNAPSHOT_META_KEY, JSON.stringify(raw));
    } finally {
      store.close();
    }

    expect(indexHealth(root)).toMatchObject({
      binding: { status: "invalid" },
      coverage: { status: "insufficient" },
      reasonSummary: expect.arrayContaining(["BINDING_INVALID"]),
    });
  });

  it("keeps a bound snapshot insufficient when a mandatory capability gate fails", () => {
    const { root } = repository();
    indexRepository(root, "2026-07-28T10:01:35.000Z");
    const store = openStore(root);
    try {
      const planeSnapshot = JSON.parse(
        store.getMeta(PLANE_A_INDEX_SNAPSHOT_META_KEY)!,
      ) as {
        sidecarDigest: string;
        sidecar: {
          capabilityProfiles: {
            factSchemaDigest: string;
            scope: { language: string };
          }[];
        };
      };
      const pythonProfile = planeSnapshot.sidecar.capabilityProfiles.find(
        (profile) => profile.scope.language === "python",
      );
      expect(pythonProfile).toBeDefined();
      pythonProfile!.factSchemaDigest =
        digestCanonical({ mismatched: "fact-schema" });
      planeSnapshot.sidecarDigest = digestCanonical(planeSnapshot.sidecar);
      store.setMeta(
        PLANE_A_INDEX_SNAPSHOT_META_KEY,
        JSON.stringify(planeSnapshot),
      );

      const controlSnapshot = JSON.parse(
        store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY)!,
      ) as { planeAIndexSnapshotHash?: string };
      controlSnapshot.planeAIndexSnapshotHash = digestCanonical(planeSnapshot);
      store.setMeta(
        CONTROL_INDEX_SNAPSHOT_META_KEY,
        JSON.stringify(controlSnapshot),
      );
    } finally {
      store.close();
    }

    expect(indexHealth(root)).toMatchObject({
      binding: { status: "valid" },
      freshness: { verdict: "FRESH", canRunHighRiskControl: true },
      coverage: { status: "insufficient" },
      evaluations: {
        reasonSummary: expect.arrayContaining(["SCHEMA_DIGEST_MISMATCH"]),
      },
      reasonSummary: expect.arrayContaining(["SCHEMA_DIGEST_MISMATCH"]),
    });
  });

  it.each([
    {
      coordinate: "producer version",
      expectedReason: "PRODUCER_VERSION_MISMATCH",
      mutate: (sidecar: MutablePlaneASidecar) => {
        for (const profile of sidecar.capabilityProfiles) profile.producer.version = "9.9.9";
        for (const batch of sidecar.factBatches) batch.producer.version = "9.9.9";
        for (const result of sidecar.producerResults) result.producer.version = "9.9.9";
        for (const entry of sidecar.discoveryLedger) {
          if (entry.selectedProducer !== undefined) entry.selectedProducer.version = "9.9.9";
        }
      },
    },
    {
      coordinate: "producer configuration",
      expectedReason: "CONFIG_DIGEST_MISMATCH",
      mutate: (sidecar: MutablePlaneASidecar) => {
        const digest = digestCanonical({ forged: "configuration" });
        sidecar.producerConfigurationDigest = digest;
        for (const profile of sidecar.capabilityProfiles) {
          profile.producerConfigurationDigest = digest;
        }
        for (const batch of sidecar.factBatches) {
          batch.producerConfigurationDigest = digest;
        }
      },
    },
    {
      coordinate: "fact schema",
      expectedReason: "SCHEMA_DIGEST_MISMATCH",
      mutate: (sidecar: MutablePlaneASidecar) => {
        const digest = digestCanonical({ forged: "fact-schema" });
        sidecar.factSchemaDigest = digest;
        for (const profile of sidecar.capabilityProfiles) profile.factSchemaDigest = digest;
        for (const batch of sidecar.factBatches) batch.factSchemaDigest = digest;
      },
    },
    {
      coordinate: "evidence contract",
      expectedReason: "EVIDENCE_CONTRACT_MISMATCH",
      mutate: (sidecar: MutablePlaneASidecar) => {
        for (const profile of sidecar.capabilityProfiles) {
          profile.evidenceContract = "producer-self-attested-v9";
        }
        for (const batch of sidecar.factBatches) {
          batch.evidenceContract = "producer-self-attested-v9";
        }
      },
    },
    {
      coordinate: "resolution semantics",
      expectedReason: "CAPABILITY_MISSING",
      mutate: (sidecar: MutablePlaneASidecar) => {
        for (const profile of sidecar.capabilityProfiles) {
          profile.resolutionSemantics = "path-only-self-attested";
        }
      },
    },
    {
      coordinate: "soundness claim",
      expectedReason: "CAPABILITY_MISSING",
      mutate: (sidecar: MutablePlaneASidecar) => {
        for (const profile of sidecar.capabilityProfiles) {
          profile.soundnessClaim = "producer-says-sound";
        }
      },
    },
    {
      coordinate: "completeness claim",
      expectedReason: "CAPABILITY_MISSING",
      mutate: (sidecar: MutablePlaneASidecar) => {
        for (const profile of sidecar.capabilityProfiles) {
          profile.completenessClaim = "complete";
        }
      },
    },
  ])(
    "rejects coordinated $coordinate self-attestation despite a freshly resealed binding",
    ({ expectedReason, mutate }) => {
      const { root } = repository();
      indexRepository(root, "2026-07-28T10:01:37.000Z");
      mutateAndResealPlaneA(root, mutate);

      const report = indexHealth(root);
      expect(report).toMatchObject({
        binding: { status: "valid" },
        freshness: { verdict: "FRESH", canRunHighRiskControl: true },
        coverage: { status: "insufficient" },
        evaluations: {
          reasonSummary: expect.arrayContaining([expectedReason]),
        },
        reasonSummary: expect.arrayContaining([expectedReason]),
      });
      expect(report.evaluations.decisions.some((decision) =>
        decision.decisionKind === "exact_subject"
        && decision.gates.capabilityMatch === "failed")).toBe(true);
    },
  );

  it("rejects a malformed persisted graph even when the Plane-A graph hash is recomputed", () => {
    const { root } = repository();
    indexRepository(root, "2026-07-28T10:01:40.000Z");
    const store = openStore(root);
    try {
      const graph = store.loadGraph() as unknown as {
        nodes: { kind: string }[];
        edges: unknown[];
      };
      graph.nodes[0]!.kind = "not-a-node-kind";
      const evidence = store.loadEvidence();
      const claims = store.loadClaims();
      store.saveGraph(graph as unknown as RepositoryGraph, evidence);
      const raw = JSON.parse(store.getMeta(PLANE_A_INDEX_SNAPSHOT_META_KEY)!) as {
        repositoryGraphHash: string;
      };
      raw.repositoryGraphHash = fingerprintRepositoryFacts({
        graph: graph as unknown as RepositoryGraph,
        evidence,
        claims,
      });
      store.setMeta(PLANE_A_INDEX_SNAPSHOT_META_KEY, JSON.stringify(raw));
    } finally {
      store.close();
    }

    expect(indexHealth(root)).toMatchObject({
      binding: { status: "invalid" },
      coverage: { status: "insufficient" },
      reasonSummary: expect.arrayContaining(["BINDING_INVALID"]),
    });
  });

  it("blocks a selected changed scope whose configured analyzer is disabled", () => {
    const { root } = repository("off");
    indexRepository(root, "2026-07-28T10:02:00.000Z");

    const computation = runVerify(root, { kind: "provided", diffText: pythonDiff(), head: "HEAD" });

    expect(computation.result.verdict).toBe("BLOCK");
    expect(computation.result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "analysis_scope_incomplete",
        severity: "block",
      }),
    ]));
    expect(computation.report.verdict).toBe("BLOCK");
  });

  it("turns an explicit Python invariant into an actionable verification finding", () => {
    const { root } = repository();
    indexRepository(root, "2026-07-28T10:02:30.000Z");

    const computation = runVerify(root, {
      kind: "provided",
      diffText: [
        "diff --git a/src/service.py b/src/service.py",
        "index 1111111..2222222 100644",
        "--- a/src/service.py",
        "+++ b/src/service.py",
        "@@ -2,2 +2,2 @@",
        " def service():",
        "-    return 1",
        "+    return 2",
        "",
      ].join("\n"),
      head: "HEAD",
    });

    expect(computation.result.impactedInvariants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        statement: "Service behavior remains stable.",
      }),
    ]));
    expect(computation.result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "invariant_touched_without_test",
        severity: "block",
      }),
    ]));
    expect(computation.result.verdict).toBe("BLOCK");
  });

  it("returns WARN instead of PASS for incomplete Python negative conclusions", () => {
    const { root } = repository();
    writeFileSync(
      join(root, "src", "service.py"),
      [
        "def service():",
        "    importlib.import_module('runtime_plugin')",
        "    return 1",
        "",
      ].join("\n"),
    );
    indexRepository(root, "2026-07-28T10:03:00.000Z");

    const computation = runVerify(root, { kind: "working-tree" });

    expect(computation.result.verdict).toBe("WARN");
    expect(computation.result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "analysis_scope_incomplete",
        severity: "warn",
      }),
    ]));
    expect(computation.result.unknowns.some((unknown) =>
      unknown.includes("No complete negative reference"))).toBe(true);
  });

  it("withdraws historical Python admissibility after current source mutation", () => {
    const { root } = repository();
    indexRepository(root, "2026-07-28T10:04:00.000Z");
    writeFileSync(
      join(root, "src", "service.py"),
      [
        "# @invariant stable-service: Service behavior remains stable.",
        "def service():",
        "    return 2",
        "",
      ].join("\n"),
    );

    const computation = runVerify(root, { kind: "working-tree" });

    expect(indexHealth(root).freshness.canRunHighRiskControl).toBe(false);
    expect(computation.result.verdict).toBe("BLOCK");
    expect(computation.result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "analysis_scope_incomplete",
        severity: "block",
      }),
    ]));
  });
});
