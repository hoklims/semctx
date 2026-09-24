import { afterAll, describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig } from "@semantic-context/core";
import { digestCanonical } from "@semantic-context/plane-a-internal";
import { initWorkspace, loadConfig, openStore } from "@semantic-context/repository-store";
import { REPO_ROOT } from "@semantic-context/test-fixtures";
import {
  fingerprintRepositoryFacts,
  indexRepository,
  runVerify,
  type VerifyComputation,
  type VerifySource,
} from "../src";
import { CONTROL_INDEX_SNAPSHOT_META_KEY, captureGitState, captureGitStateEntries, hashGitStateEntries } from "../src/freshness";

/**
 * Characterization of the complete `VerifyComputation`, not only its ADR-0008 report. The index
 * recovery path compares the input hashes, the hook records the source hash, and every transport
 * projects the report: an internal refactor of `runVerify` must leave all of them byte-identical.
 * The fixture has non-zero impact so the pinned values exercise the join, not an empty result.
 */

const FIXTURE = join(REPO_ROOT, "examples", "change-impact-replay");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Semctx Test",
  GIT_AUTHOR_EMAIL: "semctx@example.test",
  GIT_COMMITTER_NAME: "Semctx Test",
  GIT_COMMITTER_EMAIL: "semctx@example.test",
  GIT_AUTHOR_DATE: "2026-09-01T10:00:00Z",
  GIT_COMMITTER_DATE: "2026-09-01T10:00:00Z",
};
const parents: string[] = [];

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "core.autocrlf=false", ...args], {
    cwd: root,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

/** A fixed leaf name keeps the repository node id stable; fixed Git dates keep the commit ids stable. */
function repository(): string {
  const parent = mkdtempSync(join(tmpdir(), "semctx-verify-characterization-"));
  parents.push(parent);
  const root = join(parent, "fixture");
  mkdirSync(root);
  cpSync(FIXTURE, root, { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");
  initWorkspace(root, createDefaultConfig(root));
  indexRepository(root, "2026-09-01T10:00:00.000Z");
  return root;
}

const EDIT = [
  ["packages/protocol/src/pins.ts", "  const name = recorded.trim();", "  const name = recorded.trim().toLowerCase();"],
] as const;

function applyEdit(root: string): void {
  for (const [path, before, after] of EDIT) {
    const file = join(root, path);
    const current = readFileSync(file, "utf8");
    if (!current.includes(before)) throw new Error(`fixture drifted: ${path}`);
    writeFileSync(file, current.replace(before, after));
  }
}

/** Root-independent fields, pinned by value. */
function fingerprint(computation: VerifyComputation): Record<string, string> {
  return {
    result: digestCanonical(computation.result),
    report: digestCanonical(computation.report),
    git: digestCanonical(computation.git),
    coChanges: digestCanonical(computation.coChanges),
    analyzedSourceHash: String(computation.analyzedSourceHash),
    analyzedSemanticInputHashes: digestCanonical(computation.analyzedSemanticInputHashes),
  };
}

/** Root-dependent input hashes embed the absolute repository root, so they are pinned by relation. */
function expectInputHashesBoundToStore(root: string, computation: VerifyComputation): void {
  const store = openStore(root);
  try {
    expect(computation.analyzedRepositoryFactsHash).toBe(fingerprintRepositoryFacts({
      graph: store.loadGraph(),
      claims: store.loadClaims(),
      evidence: store.loadEvidence(),
    }));
    expect(computation.analyzedIndexSnapshotHash).toBe(
      digestCanonical(store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY) ?? null),
    );
  } finally {
    store.close();
  }
  expect(computation.analyzedConfigHash).toBe(digestCanonical(loadConfig(root)));
}

function scenario(kind: "working-tree" | "staged" | "range" | "provided"): Record<string, string> {
  const root = repository();
  let source: VerifySource;
  if (kind === "range") {
    git(root, "checkout", "-q", "-b", "change");
    applyEdit(root);
    git(root, "commit", "-q", "-am", "edit");
    indexRepository(root, "2026-09-01T10:05:00.000Z");
    source = { kind: "range", base: "main", head: "change" };
  } else {
    applyEdit(root);
    if (kind === "staged") git(root, "add", ".");
    source = kind === "provided"
      ? { kind: "provided", diffText: git(root, "diff", "HEAD") + "\n" }
      : { kind };
  }
  const computation = runVerify(root, source);
  expectInputHashesBoundToStore(root, computation);
  return fingerprint(computation);
}

afterAll(() => {
  for (const parent of parents.splice(0)) rmSync(parent, { recursive: true, force: true });
});

/** Captured from `runVerify` at origin/main a7cd55c, before any ChangeImpact refactor. */
const PINNED: Record<"working-tree" | "staged" | "range" | "provided", Record<string, string>> = {
  "working-tree": {
    result: "sha256:baef620490bb8b5adfb1c602675afaa5e672274458d2e85cb82e9d0f2ba3ebac",
    report: "sha256:0280ea900cd9d8dc8d67d02269f63203b601e5f69b25b2d99ee0f9a0726170c2",
    git: "sha256:176247a80ae314cb85782681c54f272947e18e6ab846014a1eae2a3567734c6b",
    coChanges: "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    analyzedSourceHash: "sha256:57dbb26f06920712a908dab797dc769c79b90c05a8bd1825ce2e0c766d29338b",
    analyzedSemanticInputHashes: "sha256:c7eea95dbd3a9444e7bfcd909c76dacf529d74bcb2173965ed27fb5bec96ae59",
  },
  staged: {
    result: "sha256:baef620490bb8b5adfb1c602675afaa5e672274458d2e85cb82e9d0f2ba3ebac",
    report: "sha256:0280ea900cd9d8dc8d67d02269f63203b601e5f69b25b2d99ee0f9a0726170c2",
    git: "sha256:176247a80ae314cb85782681c54f272947e18e6ab846014a1eae2a3567734c6b",
    coChanges: "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    analyzedSourceHash: "null",
    analyzedSemanticInputHashes: "sha256:c7eea95dbd3a9444e7bfcd909c76dacf529d74bcb2173965ed27fb5bec96ae59",
  },
  range: {
    result: "sha256:2fec9c51334c55380ca89173e2255e70a2a79fcec679d33c8d8ca7353e5dda84",
    report: "sha256:2b808648f1aedfcc246626294d60a0f68b25df7fcd9937adacfafcb856e584c8",
    git: "sha256:b5f3ae8dd02812b998959c78c37fa63e7ce64c30d19a56591de5e0d0df474195",
    coChanges: "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    analyzedSourceHash: "null",
    analyzedSemanticInputHashes: "sha256:c7eea95dbd3a9444e7bfcd909c76dacf529d74bcb2173965ed27fb5bec96ae59",
  },
  provided: {
    result: "sha256:eb02243eef230fd334edec1fbad9020549bbda398d1a3b1cce28eea513e5812c",
    report: "sha256:793505a1c988e6fd96f819a77e01bfcd719a4857c8e53c74a62be24a992842ec",
    git: "sha256:3b034284abeca9626eb5ff8e2717036eb463975980f692574fccb93ab8780d8f",
    coChanges: "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    analyzedSourceHash: "null",
    analyzedSemanticInputHashes: "sha256:c7eea95dbd3a9444e7bfcd909c76dacf529d74bcb2173965ed27fb5bec96ae59",
  },
};

describe("VerifyComputation characterization (refactor guard)", () => {
  for (const kind of ["working-tree", "staged", "range", "provided"] as const) {
    it(`${kind} computation is unchanged`, () => {
      const observed = scenario(kind);
      if (process.env.SEMCTX_PRINT_CHARACTERIZATION === "1") console.log(`CHARACTERIZATION ${kind} ${JSON.stringify(observed)}`);
      expect(observed).toEqual(PINNED[kind]);
    }, 60_000);
  }

  it("seals a non-empty local delta to the value a7cd55c computed", () => {
    const root = repository();
    applyEdit(root);
    writeFileSync(join(root, "packages/protocol/src/staged.ts"), "export const STAGED = 1;\n");
    git(root, "add", "packages/protocol/src/staged.ts");
    writeFileSync(join(root, "packages/protocol/src/untracked.ts"), "export const UNTRACKED = 1;\n");
    // Computed by `captureGitState` at a7cd55c on this same scenario (unstaged edit, staged file,
    // untracked file). Indexing seals with the wrapper; change impact matches subsets of the entries.
    const sealed = "sha256:12013c60267a565a696a70e8063c675d5c472f371bcb04171932c395babc8f52";
    expect(captureGitState(root).workingDiffHash).toBe(sealed);
    expect(hashGitStateEntries(captureGitStateEntries(root).entries!)).toBe(sealed);
  }, 60_000);

  it("exercises a non-empty impact, not a vacuous join", () => {
    const root = repository();
    applyEdit(root);
    const computation = runVerify(root, { kind: "working-tree" });
    expect(computation.report.changedSymbols.map((symbol) => symbol.name)).toEqual(["canonicalReplayName"]);
    expect(computation.report.impactedInvariants.length).toBeGreaterThan(0);
  }, 60_000);
});
