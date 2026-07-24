import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  sha256HashUtf8,
} from "@semantic-context/control-model";
import {
  computeTargetArchitecturePayloadHash,
  computeTargetArtifactHash,
  createTargetProposal,
  discoverTargetArtifacts,
  loadTargetArtifacts,
  targetArtifactPath,
  type TargetArchitectureArtifactV1,
  type TargetArchitectureProposalInputV1,
} from "../src/index";
import {
  loadTargetArtifact as loadTargetArtifactForReconciliation,
} from "../src/reconciliation-read";
import { setTargetArtifactWriteTestHookForTesting } from "../src/targets";

const roots: string[] = [];
const hash = (value: string) => sha256HashUtf8(value);

afterEach(() => {
  setTargetArtifactWriteTestHookForTesting(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-targets-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Semctx Test"]);
  return root;
}

function proposalInput(targetId = "target.checkout"): TargetArchitectureProposalInputV1 {
  return {
    targetId,
    revision: 1,
    statement: "Split checkout from catalog",
    baseCommit: "baseline",
    sourceGraphSeal: hash("graph"),
    elements: [
      { id: "repo:sym:checkout", level: 1 as const, category: "code_entity" as const, fingerprint: "code" },
      { id: "semantic:goal.checkout", level: 6 as const, category: "goal" as const, fingerprint: "goal" },
    ],
    relations: [
      { from: "semantic:goal.checkout", to: "repo:sym:checkout", relation: "realizes", fingerprint: "edge" },
    ],
    preservedInvariantIds: ["invariant.checkout.atomic"],
    authorshipOrigin: "agent" as const,
  };
}

describe("immutable target architecture artifacts", () => {
  it("creates, discovers and loads canonical proposals without overwrite", () => {
    const root = newRoot();
    const proposal = createTargetProposal(root, proposalInput());
    expect(proposal.elements.map((element) => element.id)).toEqual([
      "repo:sym:checkout",
      "semantic:goal.checkout",
    ]);
    expect(discoverTargetArtifacts(root).map(({ targetId, revision }) => ({ targetId, revision }))).toEqual([
      { targetId: "target.checkout", revision: 1 },
    ]);
    expect(loadTargetArtifacts(root)).toEqual([proposal]);
    expect(() => createTargetProposal(root, proposalInput())).toThrow("already exists");
  });

  it("rejects traversal and a symlinked tracked target directory", () => {
    const root = newRoot();
    expect(() => createTargetProposal(root, proposalInput("../escape"))).toThrow();
    expect(() => createTargetProposal(root, proposalInput("target.Uppercase"))).toThrow();
    expect(() => createTargetProposal(root, proposalInput("target_under_score"))).toThrow();

    const targets = join(root, ".semctx", "semantic", "targets");
    mkdirSync(dirname(targets), { recursive: true });
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, targets, "junction");
    expect(() => createTargetProposal(root, proposalInput())).toThrow("symlink");
  });

  it("refuses a target-directory junction and leaves the outside directory untouched", () => {
    const root = newRoot();
    const targetRoot = join(root, ".semctx", "semantic", "targets");
    mkdirSync(targetRoot, { recursive: true });
    const outside = join(root, "outside-target");
    mkdirSync(outside);
    symlinkSync(outside, join(targetRoot, "target.checkout"), "junction");

    expect(() => createTargetProposal(root, proposalInput())).toThrow("symlink");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("domain-separates artifact identity from architecture payload identity", () => {
    const root = newRoot();
    const proposal = createTargetProposal(root, proposalInput());
    expect(computeTargetArtifactHash(proposal)).not.toBe(computeTargetArchitecturePayloadHash(proposal));
  });

  it("does not delete a concurrently substituted destination before identity is proven", () => {
    const root = newRoot();
    setTargetArtifactWriteTestHookForTesting((stage, path) => {
      if (stage !== "after_link_before_identity") return;
      unlinkSync(path);
      writeFileSync(path, "attacker-owned\n", "utf8");
    });

    expect(() => createTargetProposal(root, proposalInput())).toThrow("failed to create immutable target artifact");
    const path = targetArtifactPath(root, "target.checkout", 1);
    expect(readFileSync(path, "utf8")).toBe("attacker-owned\n");
  });

  it("cleans a verified destination when post-write validation fails", () => {
    const root = newRoot();
    setTargetArtifactWriteTestHookForTesting((stage, path) => {
      if (stage === "before_post_write_validation") writeFileSync(path, "{invalid", "utf8");
    });

    expect(() => createTargetProposal(root, proposalInput())).toThrow("failed to create immutable target artifact");
    expect(existsSync(targetArtifactPath(root, "target.checkout", 1))).toBe(false);
  });

  it("refuses path identity drift, tampered hashes and duplicate-equivalent revision names", () => {
    const root = newRoot();
    const proposal = createTargetProposal(root, proposalInput());
    const path = targetArtifactPath(root, proposal.targetId, proposal.revision);
    writeFileSync(path, `${JSON.stringify({ ...proposal, targetId: "target.other" }, null, 2)}\n`);
    expect(() => loadTargetArtifacts(root)).toThrow();

    const secondRoot = newRoot();
    const second = createTargetProposal(secondRoot, proposalInput());
    const canonical = targetArtifactPath(secondRoot, second.targetId, second.revision);
    writeFileSync(join(dirname(canonical), "r01.target.json"), readFileSync(canonical));
    expect(() => loadTargetArtifacts(secondRoot)).toThrow("invalid target artifact filename");
  });

  it("makes the load-bearing reader reject correctly rehashed noncanonical artifacts", () => {
    const adversaries: Array<{
      name: string;
      mutate: (artifact: Record<string, unknown>) => void;
    }> = [
      {
        name: "unknown nested field",
        mutate: (artifact) => {
          const elements = artifact.elements as Array<Record<string, unknown>>;
          elements[0] = { ...elements[0], unexpected: true };
        },
      },
      {
        name: "duplicate relation identity",
        mutate: (artifact) => {
          const relations = artifact.relations as Array<Record<string, unknown>>;
          relations.push({ ...relations[0], fingerprint: "edge-z" });
        },
      },
      {
        name: "dangling relation endpoint",
        mutate: (artifact) => {
          const relations = artifact.relations as Array<Record<string, unknown>>;
          relations[0] = { ...relations[0], to: "repo:sym:missing" };
        },
      },
      {
        name: "noncanonical element order",
        mutate: (artifact) => {
          const elements = artifact.elements as Array<Record<string, unknown>>;
          artifact.elements = [...elements].reverse();
        },
      },
    ];

    for (const adversary of adversaries) {
      const root = newRoot();
      const proposal = createTargetProposal(root, proposalInput());
      const path = targetArtifactPath(root, proposal.targetId, proposal.revision);
      const artifact = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      adversary.mutate(artifact);
      artifact.artifactHash = computeTargetArtifactHash(
        artifact as unknown as TargetArchitectureArtifactV1,
      );
      writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

      expect(
        () => loadTargetArtifactForReconciliation(root, proposal.targetId, proposal.revision),
        adversary.name,
      ).toThrow("target artifact failed its read-only schema checks");
    }
  });

});
