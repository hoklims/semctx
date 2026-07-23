import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, initWorkspace } from "@semantic-context/repository-store";
import { initSemanticScaffold } from "@semantic-context/semantic-engine";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { parseObservedDiffHunks } from "@semantic-context/context-engine";
import { compareIds } from "@semantic-context/core";
import type { SemanticModel } from "@semantic-context/semantic-model";
import {
  CONTROL_OBSERVED_HUNK_INDEX_META_KEY,
  indexRepository,
  loadControlState,
  materializeReferencedObservedHunks,
  queryControlGraph,
} from "../src";
import { CONTROL_INDEX_SNAPSHOT_META_KEY, controlRepositoryIdentity } from "../src/freshness";

let root: string;

function git(...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "semctx-test",
      GIT_AUTHOR_EMAIL: "semctx-test@example.com",
      GIT_COMMITTER_NAME: "semctx-test",
      GIT_COMMITTER_EMAIL: "semctx-test@example.com",
    },
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-indexed-hunks-"));
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (source) => !source.includes(".semctx") && !source.includes("node_modules"),
  });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  initWorkspace(root);
  initSemanticScaffold(root);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("indexed observed hunks", () => {
  it("materializes exact tracked hunks only from a valid v2 snapshot and refuses tampered metadata", () => {
    const tracked = join(root, "src", "domain", "capacity.ts");
    writeFileSync(tracked, `${readFileSync(tracked, "utf8")}\n// observed working hunk\n`, "utf8");
    indexRepository(root, "2026-07-23T12:00:00.000Z");

    const current = loadControlState(root);
    expect(current.graph.nodes.filter((node) => node.plane === "observed")).toHaveLength(1);

    const store = openStore(root);
    const snapshotValue = store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY)!;
    const observedValue = store.getMeta(CONTROL_OBSERVED_HUNK_INDEX_META_KEY)!;
    const snapshot = JSON.parse(snapshotValue) as Record<string, unknown>;
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.observedHunkIndexHash).toBeString();

    const { observedHunkIndexHash: _hunks, attestationSetHash: _attestations, ...legacy } = snapshot;
    store.setMeta(CONTROL_INDEX_SNAPSHOT_META_KEY, JSON.stringify({ ...legacy, schemaVersion: 1 }));
    store.close();
    expect(loadControlState(root).graph.nodes.some((node) => node.plane === "observed")).toBe(false);

    const tamper = openStore(root);
    tamper.setMeta(CONTROL_INDEX_SNAPSHOT_META_KEY, snapshotValue);
    const observed = JSON.parse(observedValue) as { hunks: Array<{ rawHunkBytes: { value: string } }> };
    observed.hunks[0]!.rawHunkBytes.value = Buffer.from("tampered").toString("base64");
    tamper.setMeta(CONTROL_OBSERVED_HUNK_INDEX_META_KEY, JSON.stringify(observed));
    tamper.close();

    expect(queryControlGraph(root)).toMatchObject({
      terminalStatus: "refused",
      reasonCodes: ["INDEX_STALE"],
      payload: null,
      freshness: { verdict: "UNSEALED", reasons: ["INDEX_SNAPSHOT_INVALID"] },
    });
  });

  it("materializes a clean-worktree patch fixture only when its authored coordinate digest matches", () => {
    const fixture = join(root, "plane-a.patch");
    const bytes = new TextEncoder().encode(
      "diff --git a/src/demo.ts b/src/demo.ts\n"
      + "index 1111111..2222222 100644\n"
      + "--- a/src/demo.ts\n"
      + "+++ b/src/demo.ts\n"
      + "@@ -1 +1 @@\n"
      + "-old\n"
      + "+new\n",
    );
    writeFileSync(fixture, bytes);
    const identity = controlRepositoryIdentity(root);
    const hunk = parseObservedDiffHunks({ repositoryIdentity: identity, diffBytes: bytes })[0]!;
    const model: SemanticModel = {
      nodes: [],
      changes: [],
      refinementRelations: [{
        schemaVersion: 1,
        id: "refinement.fixture",
        kind: "implements",
        source: { plane: "A", kind: "observed_diff_hunk", coordinateDigest: hunk.identity },
        target: { plane: "B", kind: "semantic_node", nodeId: "decision.fixture" },
        epistemicStatus: "statically_observed",
        provenance: "author",
        evidenceRefs: [{
          schemaVersion: 1,
          kind: "observed_diff_hunk",
          locator: "plane-a.patch",
          digest: { algorithm: "sha256", value: hunk.identity.slice("sha256:".length) },
        }],
      }],
    };
    expect(materializeReferencedObservedHunks(root, identity, model, [])).toEqual([hunk]);
    writeFileSync(fixture, Buffer.from(bytes).subarray(0, bytes.byteLength - 2));
    expect(materializeReferencedObservedHunks(root, identity, model, [])).toEqual([]);
  });

  it("materializes every referenced hunk when several identities share one patch locator", () => {
    const fixture = join(root, "multi-hunk.patch");
    const bytes = new TextEncoder().encode(
      "diff --git a/src/demo.ts b/src/demo.ts\n"
      + "index 1111111..2222222 100644\n"
      + "--- a/src/demo.ts\n"
      + "+++ b/src/demo.ts\n"
      + "@@ -1 +1 @@\n"
      + "-old\n"
      + "+new\n"
      + "@@ -10 +10 @@\n"
      + "-older\n"
      + "+newer\n",
    );
    writeFileSync(fixture, bytes);
    const identity = controlRepositoryIdentity(root);
    const hunks = parseObservedDiffHunks({ repositoryIdentity: identity, diffBytes: bytes });
    expect(hunks).toHaveLength(2);
    const model: SemanticModel = {
      nodes: [],
      changes: [],
      refinementRelations: hunks.map((hunk, index) => ({
        schemaVersion: 1,
        id: `refinement.multi.${index}`,
        kind: "implements",
        source: { plane: "A", kind: "observed_diff_hunk", coordinateDigest: hunk.identity },
        target: { plane: "B", kind: "semantic_node", nodeId: `decision.multi.${index}` },
        epistemicStatus: "statically_observed",
        provenance: "author",
        evidenceRefs: [{
          schemaVersion: 1,
          kind: "observed_diff_hunk",
          locator: "multi-hunk.patch",
          digest: { algorithm: "sha256", value: hunk.identity.slice("sha256:".length) },
        }],
      })),
    };

    expect(materializeReferencedObservedHunks(root, identity, model, []))
      .toEqual([...hunks].sort((left, right) => compareIds(left.identity, right.identity)));
  });
});
