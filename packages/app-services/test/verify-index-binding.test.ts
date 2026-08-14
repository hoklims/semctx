import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig } from "@semantic-context/core";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";
import { __setVerifyCaptureBarrierForTesting } from "../src/verify";
import { CONTROL_INDEX_SNAPSHOT_META_KEY } from "../src/freshness";

const roots: string[] = [];

/** Rewrite the persisted control snapshot in place. Each field forges exactly one binding family,
 *  so a gate that blocks for the wrong reason cannot satisfy the assertion. */
function forgeIndexSnapshot(root: string, mutate: (snapshot: Record<string, unknown>) => unknown): void {
  const store = openStore(root);
  try {
    const raw = store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY);
    if (raw === undefined) throw new Error("fixture has no persisted control index snapshot");
    const next = mutate(JSON.parse(raw) as Record<string, unknown>);
    store.setMeta(CONTROL_INDEX_SNAPSHOT_META_KEY, typeof next === "string" ? next : JSON.stringify(next));
  } finally {
    store.close();
  }
}

/**
 * Exercise the gate over a diff semctx computed itself. A caller-supplied diff would carry a source
 * identity break of its own, and every assertion below matches on substrings — so the vehicle would
 * satisfy them whatever happened to the binding family under test. Asserting the absence of a
 * `SOURCE_IDENTITY_` reason keeps that contamination from creeping back in.
 */
function blockingReasons(root: string): string {
  writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 2;\n}\n");
  const computation = runVerify(root, { kind: "working-tree" });
  expect(computation.result.verdict).toBe("BLOCK");
  const finding = computation.result.findings.find((item) => item.rule === "index_binding_stale");
  expect(finding).toBeDefined();
  expect(finding?.severity).toBe("block");
  expect(finding?.message).not.toContain("SOURCE_IDENTITY_");
  return finding?.message ?? "";
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", ...args],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

/** A v1-config repository indexed at its first commit. v1 is deliberate: the analysis-health
 *  preflight is gated on `config.version === 2`, so this fixture has no other freshness guard. */
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-verify-index-binding-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 1;\n}\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");
  initWorkspace(root, createDefaultConfig(root));
  indexRepository(root, "2026-08-11T11:00:00.000Z");
  return root;
}

const DIFF = [
  "diff --git a/src/service.ts b/src/service.ts",
  "index 1111111..2222222 100644",
  "--- a/src/service.ts",
  "+++ b/src/service.ts",
  "@@ -2 +2 @@",
  "-  return 1;",
  "+  return 2;",
  "",
].join("\n");

afterEach(() => {
  __setVerifyCaptureBarrierForTesting(undefined);
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("analysed source provenance", () => {
  // A diff semctx did not compute and nobody attributed is a set of hunks belonging to no known
  // source state. PASS would certify a join whose two halves were never shown to share coordinates.
  it("refuses a provided diff that carries no post-image identity", () => {
    const root = repository();

    const computation = runVerify(root, { kind: "provided", diffText: DIFF });

    expect(computation.result.verdict).toBe("BLOCK");
    expect(computation.result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "index_binding_stale",
          message: expect.stringContaining("SOURCE_IDENTITY_ABSENT"),
        }),
      ]),
    );
  });

  it("refuses a diff read from a file that carries no post-image identity", () => {
    const root = repository();
    const path = join(root, "supplied.diff");
    writeFileSync(path, DIFF);

    const computation = runVerify(root, { kind: "file", path });

    expect(computation.result.verdict).toBe("BLOCK");
    expect(computation.result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "index_binding_stale",
          message: expect.stringContaining("SOURCE_IDENTITY_ABSENT"),
        }),
      ]),
    );
  });

  // There is no escape hatch. Naming the indexed commit satisfies every coordinate check the gate
  // can make, which is exactly why it must not authorize: the caller supplied both the commit and
  // the post-image, so the check would only confirm the caller against itself.
  it("refuses a file diff attributed to the indexed commit, because attribution is not provenance", () => {
    const root = repository();
    const path = join(root, "supplied.diff");
    writeFileSync(path, DIFF);

    const computation = runVerify(root, { kind: "file", path, head: "HEAD" });

    expect(computation.result.verdict).toBe("BLOCK");
    expect(computation.result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "index_binding_stale",
          severity: "block",
          message: expect.stringContaining("SOURCE_IDENTITY_UNPROVEN"),
        }),
      ]),
    );
  });

  it("refuses a file diff whose declared identity is not the indexed commit", () => {
    const root = repository();
    const path = join(root, "supplied.diff");
    writeFileSync(path, DIFF);
    git(root, "commit", "-q", "--allow-empty", "-m", "later");
    git(root, "tag", "later");
    git(root, "reset", "-q", "--hard", "HEAD~1");

    const computation = runVerify(root, { kind: "file", path, head: "later" });

    expect(computation.result.verdict).toBe("BLOCK");
    expect(computation.result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "index_binding_stale",
          message: expect.stringContaining("ANALYZED_COMMIT_MISMATCH"),
        }),
      ]),
    );
  });

  it("fails explicitly when a requested head does not resolve", () => {
    const root = repository();

    expect(() => runVerify(root, { kind: "working-tree", head: "no-such-ref" })).toThrow(
      'head ref "no-such-ref" does not exist locally.',
    );
    expect(() => runVerify(root, { kind: "provided", diffText: DIFF, head: "no-such-ref" })).toThrow(
      'head ref "no-such-ref" does not exist locally.',
    );
  });
});

describe("frozen Git identity", () => {
  // The hunks must come from the commit that was resolved, not from whatever the ref names by the
  // time the diff runs. `feature` is redirected to a sibling commit between the two steps.
  it("diffs the resolved object id when the head ref moves before capture", () => {
    const root = repository();
    const indexedCommit = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 2;\n}\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "feature commit touches service.ts");
    git(root, "checkout", "-q", indexedCommit);
    git(root, "checkout", "-q", "-b", "sibling");
    writeFileSync(join(root, "src", "other.ts"), "export const other = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "sibling commit touches other.ts");
    git(root, "checkout", "-q", indexedCommit);
    __setVerifyCaptureBarrierForTesting(() => {
      git(root, "branch", "-f", "feature", "sibling");
    });

    const computation = runVerify(root, { kind: "range", base: indexedCommit, head: "feature" });

    expect(computation.result.changedFiles).toEqual(["src/service.ts"]);
    expect(computation.result.changedFiles).not.toContain("src/other.ts");
  });

  // Same guarantee on the working-tree path: the anchor is frozen before any hunk is measured, so
  // a branch moved under the analysis cannot re-base the working delta on another commit. The
  // later commit *modifies* an indexed file rather than adding one, because diff analysis drops
  // pure deletions — an added-file variant would read the same either way and prove nothing.
  it("diffs the resolved object id when HEAD moves before a working-tree capture", () => {
    const root = repository();
    const indexedCommit = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 5;\n}\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "rewrites service.ts");
    const laterCommit = git(root, "rev-parse", "HEAD");
    // Restore the indexed content on disk while leaving the branch free to move under the analysis.
    git(root, "reset", "-q", "--hard", indexedCommit);
    __setVerifyCaptureBarrierForTesting(() => {
      git(root, "reset", "-q", "--soft", laterCommit);
    });

    const computation = runVerify(root, { kind: "working-tree" });

    // Against the frozen commit the working tree is identical, so nothing changed. The moved HEAD
    // is a genuinely different answer, asserted here so the oracle cannot pass by both sides being
    // empty for an unrelated reason.
    expect(computation.result.changedFiles).toEqual([]);
    expect(git(root, "rev-parse", "HEAD")).toBe(laterCommit);
    expect(git(root, "diff", "--name-only", "HEAD", "--")).toBe("src/service.ts");
  });
});

describe("index binding gate", () => {
  it("passes while the index is still bound to HEAD", () => {
    const root = repository();
    writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 2;\n}\n");

    const computation = runVerify(root, { kind: "working-tree" });

    expect(computation.result.findings.map((finding) => finding.rule)).not.toContain(
      "index_binding_stale",
    );
  });

  // Impacted nodes are a join between line ranges frozen at indexing time and hunks measured
  // against the current HEAD. Once HEAD moves, that join silently mixes two coordinate systems.
  it("blocks once HEAD moves away from the indexed commit", () => {
    const root = repository();
    git(root, "commit", "-q", "--allow-empty", "-m", "move HEAD past the indexed commit");
    writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 2;\n}\n");

    const computation = runVerify(root, { kind: "working-tree" });

    expect(computation.result.verdict).toBe("BLOCK");
    expect(computation.result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "index_binding_stale",
          severity: "block",
          message: expect.stringContaining("HEAD_MISMATCH"),
        }),
      ]),
    );
  });

  // `HEAD_MISMATCH` compares the index against the checked-out HEAD, which stays A here. Only the
  // commit the diff was actually taken against exposes the mixed coordinate systems.
  it("blocks when the analysed head is not the indexed commit, with HEAD still on the indexed one", () => {
    const root = repository();
    const indexedCommit = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 2;\n}\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "second commit");
    git(root, "checkout", "-q", "-");
    expect(git(root, "rev-parse", "HEAD")).toBe(indexedCommit);

    const computation = runVerify(root, { kind: "range", base: indexedCommit, head: "feature" });

    expect(computation.result.verdict).toBe("BLOCK");
    expect(computation.result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "index_binding_stale",
          severity: "block",
          message: expect.stringContaining("ANALYZED_COMMIT_MISMATCH"),
        }),
      ]),
    );
  });

  it("passes a range whose analysed head is the indexed commit", () => {
    const root = repository();
    const indexedCommit = git(root, "rev-parse", "HEAD");

    const computation = runVerify(root, { kind: "range", base: indexedCommit, head: indexedCommit });

    expect(computation.result.findings.map((finding) => finding.rule)).not.toContain(
      "index_binding_stale",
    );
  });

  // One case per binding family. Each forges a single field, so a gate that blocks on the wrong
  // reason fails the assertion instead of passing by accident.
  // Wiping the control snapshot destroys the only field that authorizes a Plane-A snapshot, so the
  // record chain reports it before the seal ever gets a chance to be built.
  it("blocks when the index carries no binding snapshot at all", () => {
    const root = repository();
    forgeIndexSnapshot(root, () => "");

    const reasons = blockingReasons(root);
    expect(reasons).toContain("UNRESOLVED_REFERENCE_CONTROL_SNAPSHOT_ABSENT");
    expect(reasons).not.toContain("ANALYZED_COMMIT_MISMATCH");
  });

  it("blocks when the persisted binding snapshot does not parse", () => {
    const root = repository();
    forgeIndexSnapshot(root, () => "{ not json");

    const reasons = blockingReasons(root);
    expect(reasons).toContain("INDEX_SNAPSHOT_INVALID");
    expect(reasons).not.toContain("ANALYZED_COMMIT_MISMATCH");
  });

  it("blocks when the index was built against a different repository root", () => {
    const root = repository();
    forgeIndexSnapshot(root, (snapshot) => ({ ...snapshot, repositoryRoot: "/elsewhere/repository" }));

    expect(blockingReasons(root)).toContain("REPOSITORY_ROOT_MISMATCH");
  });

  it("blocks when the indexed repository graph no longer matches the stored facts", () => {
    const root = repository();
    forgeIndexSnapshot(root, (snapshot) => ({
      ...snapshot,
      repositoryGraphHash: `sha256:${"a".repeat(64)}`,
    }));

    expect(blockingReasons(root)).toContain("REPOSITORY_GRAPH_MISMATCH");
  });

  it("blocks when the index was written under a different store schema", () => {
    const root = repository();
    forgeIndexSnapshot(root, (snapshot) => ({ ...snapshot, storeSchemaVersion: 999 }));

    expect(blockingReasons(root)).toContain("STORE_SCHEMA_MISMATCH");
  });

  // The probe annotates the verdict rather than driving it, so it must not throw through. It must
  // also not be silently forgiven: a binding that cannot be probed is a binding that is not proven.
  it("blocks when the freshness probe itself fails", () => {
    const root = repository();
    writeFileSync(join(root, ".gitmodules"), '[submodule "vendor"]\n\tpath = vendor\n');

    expect(blockingReasons(root)).toContain("FRESHNESS_PROBE_FAILED");
  });

  // Verifying uncommitted work is what `verify diff` is for. Treating the working delta as a
  // coordinate break would refuse every working-tree verification in the product.
  it("verifies a working-tree diff taken after indexing without calling it a coordinate break", () => {
    const root = repository();
    const indexedCommit = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 3;\n}\n");

    const computation = runVerify(root, { kind: "working-tree" });

    expect(git(root, "rev-parse", "HEAD")).toBe(indexedCommit);
    expect(computation.result.verdict).not.toBe("BLOCK");
    expect(computation.result.findings.map((finding) => finding.rule)).not.toContain(
      "index_binding_stale",
    );
  });

  // The gate must stay narrow. A reason that does not invalidate a line range must never block,
  // or a repository whose semantic lifecycle is momentarily invalid would be unable to run the
  // very command that repairs it — and `semctx index` refuses a stale evidence baseline, so the
  // two would deadlock.
  it("records an unknown but never blocks on a reason that preserves coordinates", () => {
    const root = repository();
    writeFileSync(
      join(root, ".semctx", "verification-state.json"),
      `${JSON.stringify(
        {
          version: 2,
          headCommit: "0000000000000000000000000000000000000000",
          workingStateHash: `sha256:${"0".repeat(64)}`,
          verdict: "PASS",
          recordedAt: "2026-08-11T10:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );

    writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 2;\n}\n");

    const computation = runVerify(root, { kind: "working-tree" });

    expect(computation.result.verdict).not.toBe("BLOCK");
    expect(computation.result.findings.map((finding) => finding.rule)).not.toContain(
      "index_binding_stale",
    );
    expect(computation.result.unknowns.join("\n")).toContain("index binding");
  });
});
