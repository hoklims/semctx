import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sha256HashBytes, type Sha256Hash } from "@semantic-context/control-model";
import { parseObservedDiffHunks } from "@semantic-context/context-engine";
import { initSemanticScaffold } from "@semantic-context/semantic-engine";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import {
  controlRepositoryIdentity,
  indexRepository,
  queryControlGraph,
  queryControlRefinementCoverage,
} from "../src";
import { CONTROL_OBSERVED_HUNK_INDEX_META_KEY } from "../src/control-evidence";
import { CONTROL_INDEX_SNAPSHOT_META_KEY } from "../src/freshness";

const SOURCE_ROOT = resolve(import.meta.dir, "..", "..", "..");
const DOCUMENT_EVIDENCE = [
  "docs/architecture/semantic-layer-v1.md",
  "docs/architecture/semantic-model.md",
].map((locator) => ({
  locator,
  digest: sha256HashBytes(
    new Uint8Array(readFileSync(join(SOURCE_ROOT, ...locator.split("/")))),
  ),
}));
const GOAL = "semantic:goal.semctx.reconstructive-control";
const HUNK_ID =
  "sha256:0cef0c7583115223271b46cbbe70a91b7f783884c5ef60c840649b51780815bd" as Sha256Hash;
const LOAD_BEARING_RELATIONS = [
  "refinement.01.strategy-to-product",
  "refinement.02.product-to-invariant",
  "refinement.03.capability-realizes-invariant",
  "refinement.04.component-implements-capability",
  "refinement.05.contract-implements-component",
  "refinement.06.hunk-implements-contract",
];
const EXPECTED_VERIFIED_EVIDENCE = ([
  HUNK_ID,
  "sha256:12138c433a48aa3123593b44b01a9de91d9b71c11dee9a107f648741b437049c",
  "sha256:212f92327d1debf6079eba2fcfc0bf6a0ac202427a1516f73bb3413a45e2bbc2",
  "sha256:258e8e1e0efcd327af26a15d3804d975a44868baa030e3058a4314fd1509dcb8",
  "sha256:3b395f70d7f4fd8442befebfa2b55db4bf2c1a202d98bf55074c3e8e2b99dea2",
  ...DOCUMENT_EVIDENCE.map(({ digest }) => digest),
  "sha256:e2ecde8b57f3b33198522aa69b9cd78f7e26ef9c80b765f3049ecbd46ff07b9b",
] satisfies Sha256Hash[]).sort();
const TRACKED_INPUTS = [
  ".semctx/semantic/project/control-plane.sem",
  "docs/architecture/semantic-layer-v1.md",
  "docs/architecture/semantic-model.md",
  "packages/control-engine/test/fixtures/l6-l0-refinement.patch",
  "packages/control-engine/test/l6-l0-refinement-round-trip.test.ts",
] as const;
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "semctx-test",
  GIT_AUTHOR_EMAIL: "semctx-test@example.com",
  GIT_COMMITTER_NAME: "semctx-test",
  GIT_COMMITTER_EMAIL: "semctx-test@example.com",
};

let parent: string;
let root: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "semctx-public-roundtrip-"));
  root = join(parent, "semctx");
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (source) => !source.includes(".semctx") && !source.includes("node_modules"),
  });
  git("init", "-q");
  initWorkspace(root);
  initSemanticScaffold(root);
  for (const relative of TRACKED_INPUTS) copyTrackedInput(relative);
  refreshDocumentEvidenceDigests();
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  expect(git("status", "--porcelain")).toBe("");
  expect(controlRepositoryIdentity(root)).toBe("repo:semctx");
  indexRepository(root, "2026-07-23T12:00:00.000Z");
});

afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

describe("public indexed L6-to-L0 round trip", () => {
  it("resolves real evidence and round-trips through public graph and coverage services", () => {
    const fixtureBytes = readFileSync(
      join(root, "packages", "control-engine", "test", "fixtures", "l6-l0-refinement.patch"),
    );
    const observed = parseObservedDiffHunks({
      repositoryIdentity: controlRepositoryIdentity(root),
      diffBytes: fixtureBytes,
    });
    expect(observed.map((hunk) => hunk.identity)).toEqual([HUNK_ID]);

    const graph = queryControlGraph(root);
    expect(graph).toMatchObject({
      terminalStatus: "success",
      reasonCodes: [],
      freshness: {
        verdict: "FRESH",
        reasons: [],
        seal: {
          sealSchemaVersion: 2,
          attestationSetHash: null,
        },
      },
    });
    expect(graph.freshness.seal?.sealHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(graph.payload?.verifiedEvidenceDigests).toEqual([...EXPECTED_VERIFIED_EVIDENCE]);
    expect(graph.payload?.structuralEdges.some((edge) => edge.sourceRelation === "imports")).toBe(
      true,
    );

    const lower = queryControlRefinementCoverage(root, {
      sourceId: GOAL,
      targetLevel: 0,
      direction: "lower",
    });
    expect(lower).toMatchObject({
      terminalStatus: "success",
      reasonCodes: [],
      freshness: { verdict: "FRESH" },
      payload: {
        terminalStatus: "success",
        coveredLevels: [0, 1, 2, 3, 4, 5, 6],
        missingLevels: [],
      },
    });
    expect(lower.payload?.sourceSeal).toBe(graph.freshness.seal?.sealHash);
    expect(lower.payload?.indexSeal).toBe(graph.freshness.seal?.sealHash);
    expect(lower.payload?.loadBearingSteps.map((step) => step.relation.id)).toEqual(
      LOAD_BEARING_RELATIONS,
    );
    expect(lower.payload?.advisorySteps.map((step) => step.relation.id)).toEqual([
      "refinement.90.llm-advisory",
      "refinement.91.multilevel-advisory",
    ]);

    const lifted = queryControlRefinementCoverage(root, {
      sourceId: HUNK_ID,
      targetLevel: 6,
      direction: "lift",
    });
    expect(lifted).toMatchObject({
      terminalStatus: "success",
      reasonCodes: [],
      freshness: { verdict: "FRESH" },
      payload: {
        terminalStatus: "success",
        levelSpan: { from: 0, to: 6 },
        coveredLevels: [0, 1, 2, 3, 4, 5, 6],
        missingLevels: [],
      },
    });
    expect(lifted.payload?.visitedCoordinates).toContain(GOAL);
    expect(lifted.payload?.governingConstraints.map((relation) => relation.id)).toEqual([
      "refinement.07.plane-separation-constraint",
      "refinement.08.fail-closed-constraint",
    ]);
  });

  it("refuses public coverage after the indexed patch evidence changes", () => {
    const fixture = join(
      root,
      "packages",
      "control-engine",
      "test",
      "fixtures",
      "l6-l0-refinement.patch",
    );
    writeFileSync(fixture, Buffer.concat([readFileSync(fixture), Buffer.from("# drift\n")]));

    expect(queryControlRefinementCoverage(root, {
      sourceId: GOAL,
      targetLevel: 0,
      direction: "lower",
    })).toMatchObject({
      terminalStatus: "refused",
      reasonCodes: ["INDEX_STALE"],
      payload: null,
      freshness: {
        verdict: "STALE",
        reasons: expect.arrayContaining(["WORKING_DIFF_MISMATCH"]),
      },
    });
  });

  it("refuses public coverage after indexed document evidence changes", () => {
    const evidence = join(root, "docs", "architecture", "semantic-layer-v1.md");
    writeFileSync(evidence, Buffer.concat([readFileSync(evidence), Buffer.from("\nEvidence drift.\n")]));

    expect(queryControlRefinementCoverage(root, {
      sourceId: GOAL,
      targetLevel: 0,
      direction: "lower",
    })).toMatchObject({
      terminalStatus: "refused",
      reasonCodes: ["INDEX_STALE"],
      payload: null,
      freshness: {
        verdict: "STALE",
        reasons: expect.arrayContaining(["WORKING_DIFF_MISMATCH"]),
      },
    });
  });

  it("keeps legacy v1 snapshots without L0 and reports the missing mapping", () => {
    const store = openStore(root);
    const snapshot = JSON.parse(
      store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY)!,
    ) as Record<string, unknown>;
    const {
      observedHunkIndexHash: _observedHunkIndexHash,
      attestationSetHash: _attestationSetHash,
      ...legacy
    } = snapshot;
    store.setMeta(
      CONTROL_INDEX_SNAPSHOT_META_KEY,
      JSON.stringify({ ...legacy, schemaVersion: 1 }),
    );
    store.setMeta(CONTROL_OBSERVED_HUNK_INDEX_META_KEY, "not-a-readable-observed-hunk-index");
    store.close();

    const graph = queryControlGraph(root);
    expect(graph).toMatchObject({
      terminalStatus: "success",
      freshness: { verdict: "FRESH" },
    });
    expect(graph.payload?.nodes.some((node) => node.plane === "observed")).toBe(false);
    expect(graph.payload?.refinementRelations.some((relation) =>
      relation.source.kind === "observed_diff_hunk"
      || relation.target.kind === "observed_diff_hunk"
    )).toBe(true);
    expect(queryControlRefinementCoverage(root, {
      sourceId: GOAL,
      targetLevel: 0,
      direction: "lower",
    })).toMatchObject({
      terminalStatus: "empty",
      reasonCodes: ["MAPPING_MISSING"],
      payload: {
        terminalStatus: "empty",
        reasonCode: "MAPPING_MISSING",
      },
    });
  });
});

function copyTrackedInput(relative: string): void {
  const target = join(root, ...relative.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(SOURCE_ROOT, ...relative.split("/")), target);
}

function refreshDocumentEvidenceDigests(): void {
  const semanticPath = join(root, ".semctx", "semantic", "project", "control-plane.sem");
  let semanticSource = readFileSync(semanticPath, "utf8");
  for (const { locator, digest } of DOCUMENT_EVIDENCE) {
    const prefix = `evidenceRef document_span ${locator} `;
    const pattern = new RegExp(`^${escapeRegExp(prefix)}sha256:[0-9a-f]{64}$`, "m");
    if (!pattern.test(semanticSource)) {
      throw new Error(`missing document evidence reference for ${locator}`);
    }
    semanticSource = semanticSource.replace(pattern, `${prefix}${digest}`);
  }
  writeFileSync(semanticPath, semanticSource);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function git(...args: string[]): string {
  const process = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: GIT_ENV,
  });
  if (process.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(process.stderr));
  }
  return new TextDecoder().decode(process.stdout).trim();
}
