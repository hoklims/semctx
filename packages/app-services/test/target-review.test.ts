import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeAttestationSetHash,
  computeCanonicalProofAttestationDigest,
  type CanonicalProofAttestationV1,
} from "@semantic-context/control-model";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import {
  createTargetProposal,
  initSemanticScaffold,
  loadTargetArtifacts,
} from "@semantic-context/semantic-engine";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import {
  CONTROL_ATTESTATION_INDEX_META_KEY,
  indexRepository,
  reviewTargetProposal,
} from "../src";
import { CONTROL_INDEX_SNAPSHOT_META_KEY } from "../src/freshness";
import {
  hasSameFileIdentityForTesting,
  setAcceptedTargetWriteTestHookForTesting,
} from "../src/target-review";

const roots: string[] = [];
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "semctx-test",
  GIT_AUTHOR_EMAIL: "semctx-test@example.com",
  GIT_COMMITTER_NAME: "semctx-test",
  GIT_COMMITTER_EMAIL: "semctx-test@example.com",
};

afterEach(() => {
  setAcceptedTargetWriteTestHookForTesting(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: GIT_ENV,
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function trustedTarget(): {
  root: string;
  commit: string;
  attestation: CanonicalProofAttestationV1;
} {
  const root = mkdtempSync(join(tmpdir(), "semctx-target-review-"));
  roots.push(root);
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (source) => !source.includes(".semctx") && !source.includes("node_modules"),
  });
  git(root, "init", "-q");
  initWorkspace(root);
  initSemanticScaffold(root);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");

  const initial = indexRepository(root, "2026-07-23T09:00:00.000Z");
  const baseCommit = git(root, "rev-parse", "HEAD");
  const proposal = createTargetProposal(root, {
    targetId: "target.checkout",
    revision: 1,
    statement: "Split checkout from catalog",
    baseCommit,
    sourceGraphSeal: initial.freshnessSeal.repositoryGraphHash,
    elements: [
      { id: "repo:sym:checkout", level: 1, category: "code_entity", fingerprint: "code" },
      { id: "semantic:goal.checkout", level: 6, category: "goal", fingerprint: "goal" },
    ],
    relations: [
      { from: "semantic:goal.checkout", to: "repo:sym:checkout", relation: "realizes", fingerprint: "edge" },
    ],
    preservedInvariantIds: ["invariant.checkout.atomic"],
    authorshipOrigin: "agent",
  });
  git(root, "add", ".semctx/semantic/targets");
  git(root, "commit", "-qm", "propose target");
  const commit = git(root, "rev-parse", "HEAD");
  const payload = {
    schemaVersion: 1 as const,
    id: "attestation.target.checkout.review",
    obligation: "target_reviewed" as const,
    subject: proposal.artifactHash,
    epistemicStatus: "human_declared" as const,
    references: [{ kind: "architecture" as const, uri: "semctx://architecture/review", nonLlm: true }],
    commit,
    observedAt: "2026-07-23T10:00:00.000Z",
    expiresAt: "2026-07-24T10:00:00.000Z",
  };
  const attestation: CanonicalProofAttestationV1 = {
    ...payload,
    attestationDigest: computeCanonicalProofAttestationDigest(payload),
  };
  const store = openStore(root);
  store.setMeta(CONTROL_ATTESTATION_INDEX_META_KEY, JSON.stringify({
    schemaVersion: 1,
    entries: [attestation],
    attestationSetHash: computeAttestationSetHash([attestation.attestationDigest]),
  }));
  store.close();
  indexRepository(root, "2026-07-23T11:00:00.000Z");
  return { root, commit, attestation };
}

function command(commit: string, attestation: CanonicalProofAttestationV1) {
  return {
    targetId: "target.checkout",
    proposalRevision: 1,
    proposalContainingCommit: commit,
    attestationRef: attestation.id,
    evaluatedAt: "2026-07-23T12:00:00.000Z",
  } as const;
}

describe("trusted target review application boundary", () => {
  it("creates an accepted revision only from the fully fresh persisted control state", () => {
    const { root, commit, attestation } = trustedTarget();
    const before = readFileSync(join(root, ".semctx", "semantic", "targets", "target.checkout", "r1.target.json"));

    const accepted = reviewTargetProposal(root, command(commit, attestation));

    expect(accepted).toMatchObject({
      revision: 2,
      normativeStatus: "accepted",
      reviewAttestationRef: attestation.id,
    });
    expect(readFileSync(join(root, ".semctx", "semantic", "targets", "target.checkout", "r1.target.json"))).toEqual(before);
    expect(loadTargetArtifacts(root).map((artifact) => artifact.normativeStatus)).toEqual(["proposed", "accepted"]);
  });

  it("rejects caller-supplied proof bodies at the public boundary", () => {
    const { root, commit, attestation } = trustedTarget();
    expect(() => reviewTargetProposal(root, {
      ...command(commit, attestation),
      sealedAttestationIndex: { entries: [attestation] },
    } as never)).toThrow("invalid target review command");
    expect(loadTargetArtifacts(root)).toHaveLength(1);
  });

  it("does not delete a concurrently substituted accepted destination before identity proof", () => {
    const { root, commit, attestation } = trustedTarget();
    const acceptedPath = join(root, ".semctx", "semantic", "targets", "target.checkout", "r2.target.json");
    setAcceptedTargetWriteTestHookForTesting((stage, path) => {
      if (stage !== "after_link_before_identity") return;
      unlinkSync(path);
      writeFileSync(path, "attacker-owned\n");
    });

    expect(() => reviewTargetProposal(root, command(commit, attestation))).toThrow(
      "failed to create immutable accepted target artifact",
    );
    expect(readFileSync(acceptedPath, "utf8")).toBe("attacker-owned\n");
  });

  it("distinguishes exact 64-bit identities that collapse to the same Number", () => {
    const leftInode = 9_007_199_254_740_992n;
    const rightInode = leftInode + 1n;
    expect(Number(leftInode)).toBe(Number(rightInode));
    expect(
      hasSameFileIdentityForTesting(
        { dev: 1n, ino: leftInode },
        { dev: 1n, ino: rightInode },
      ),
    ).toBe(false);
  });

  it("removes an identity-verified accepted destination after post-write validation failure", () => {
    const { root, commit, attestation } = trustedTarget();
    const acceptedPath = join(root, ".semctx", "semantic", "targets", "target.checkout", "r2.target.json");
    setAcceptedTargetWriteTestHookForTesting((stage, path) => {
      if (stage === "before_post_write_validation") writeFileSync(path, "{invalid");
    });

    expect(() => reviewTargetProposal(root, command(commit, attestation))).toThrow(
      "failed to create immutable accepted target artifact",
    );
    expect(existsSync(acceptedPath)).toBe(false);
  });

  it("preserves a destination replaced after its initial identity proof", () => {
    const { root, commit, attestation } = trustedTarget();
    const acceptedPath = join(root, ".semctx", "semantic", "targets", "target.checkout", "r2.target.json");
    setAcceptedTargetWriteTestHookForTesting((stage, path) => {
      if (stage !== "before_post_write_validation") return;
      unlinkSync(path);
      writeFileSync(path, "post-identity replacement\n");
    });

    expect(() => reviewTargetProposal(root, command(commit, attestation))).toThrow(
      "failed to create immutable accepted target artifact",
    );
    expect(readFileSync(acceptedPath, "utf8")).toBe("post-identity replacement\n");
  });

  for (const testCase of driftCases()) {
    it(`refuses ${testCase.name} drift`, () => {
      const { root, commit, attestation } = trustedTarget();
      testCase.mutate(root);
      expect(
        () => reviewTargetProposal(root, command(commit, attestation)),
        testCase.name,
      ).toThrow();
      expect(loadTargetArtifacts(root), testCase.name).toHaveLength(1);
    });
  }
});

function driftCases(): ReadonlyArray<{
  name: string;
  mutate: (root: string) => void;
}> {
  return [
  {
    name: "working diff",
    mutate: (root) => writeFileSync(
      join(root, "src", "domain", "capacity.ts"),
      `${readFileSync(join(root, "src", "domain", "capacity.ts"), "utf8")}\n// drift\n`,
    ),
  },
  {
    name: "semantic model",
    mutate: (root) => writeFileSync(
      join(root, ".semctx", "semantic", "goals.sem"),
      `${readFileSync(join(root, ".semctx", "semantic", "goals.sem"), "utf8")}\n# drift\n`,
    ),
  },
  {
    name: "analyzer config",
    mutate: (root) => {
      const path = join(root, ".semctx", "config.json");
      const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      writeFileSync(path, `${JSON.stringify({ ...config, include: ["src/**/*.ts", "extra/**/*.ts"] }, null, 2)}\n`);
    },
  },
  {
    name: "HEAD",
    mutate: (root) => {
      writeFileSync(join(root, "head-drift.txt"), "drift\n");
      git(root, "add", "head-drift.txt");
      git(root, "commit", "-qm", "head drift");
    },
  },
  {
    name: "tool",
    mutate: (root) => mutateSnapshot(root, (snapshot) => ({ ...snapshot, toolVersion: "forged@9.9.9" })),
  },
  {
    name: "store schema",
    mutate: (root) => mutateSnapshot(root, (snapshot) => ({ ...snapshot, storeSchemaVersion: 999 })),
  },
  {
    name: "observed hunk index seal",
    mutate: (root) => mutateSnapshot(root, (snapshot) => ({
      ...snapshot,
      observedHunkIndexHash: `sha256:${"b".repeat(64)}`,
    })),
  },
  {
    name: "repository root",
    mutate: (root) => mutateSnapshot(root, (snapshot) => ({ ...snapshot, repositoryRoot: join(root, "other") })),
  },
  {
    name: "attestation seal",
    mutate: (root) => mutateSnapshot(root, (snapshot) => ({
      ...snapshot,
      attestationSetHash: `sha256:${"a".repeat(64)}`,
    })),
  },
  ];
}

function mutateSnapshot(
  root: string,
  mutate: (snapshot: Record<string, unknown>) => Record<string, unknown>,
): void {
  const store = openStore(root);
  try {
    const current = JSON.parse(store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY)!) as Record<string, unknown>;
    store.setMeta(CONTROL_INDEX_SNAPSHOT_META_KEY, JSON.stringify(mutate(current)));
  } finally {
    store.close();
  }
}
