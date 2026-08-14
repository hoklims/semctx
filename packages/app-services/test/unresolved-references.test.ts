import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultConfig,
  createGlobSelectionConfig,
  documentId,
  type SemctxConfig,
} from "@semantic-context/core";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import { digestCanonical } from "@semantic-context/plane-a-internal";
import {
  UNRESOLVED_REFERENCE_INDEX_META_KEY,
  controlStatus,
  createUnresolvedReferenceIndex,
  indexHealth,
  indexRepository,
  parseUnresolvedReferenceIndex,
  runVerify,
} from "../src";
import { CONTROL_INDEX_SNAPSHOT_META_KEY, PLANE_A_INDEX_SNAPSHOT_META_KEY } from "../src/freshness";
import { parsePlaneAIndexSnapshot } from "../src/index-health";

const roots: string[] = [];
const ABSENT = documentId("docs/absent.md");

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", ...args],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

/** A repository whose own documentation names a target the repository does not contain. */
function repository(configFor: (root: string) => SemctxConfig = createDefaultConfig): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-unresolved-references-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 1;\n}\n");
  writeFileSync(join(root, "docs", "notes.md"), "---\ntype: doc\ncontradicts: [docs/absent.md]\n---\n\n# Notes\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");
  initWorkspace(root, configFor(root));
  return root;
}

/** Both selection modes, because the authorization chain must not depend on the config version. */
const CONFIG_VERSIONS: readonly (readonly [string, (root: string) => SemctxConfig])[] = [
  ["v1", createDefaultConfig],
  ["v2", (root) => ({ ...createGlobSelectionConfig(root), include: ["src/**/*.ts", "docs/**/*.md"] })],
];

function readMeta(root: string, key: string): string | undefined {
  const store = openStore(root);
  try {
    return store.getMeta(key);
  } finally {
    store.close();
  }
}

function writeMeta(root: string, key: string, value: string): void {
  const store = openStore(root);
  try {
    store.setMeta(key, value);
  } finally {
    store.close();
  }
}

function readRecord(root: string): string | undefined {
  return readMeta(root, UNRESOLVED_REFERENCE_INDEX_META_KEY);
}

function writeRecord(root: string, value: string): void {
  writeMeta(root, UNRESOLVED_REFERENCE_INDEX_META_KEY, value);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("unresolved authored references", () => {
  it("survives indexing, persistence and a fresh read of the closed index", () => {
    const root = repository();
    const indexed = indexRepository(root, "2026-08-12T09:00:00.000Z");
    expect(indexed.analysis.unresolvedReferences.map((reference) => reference.missing)).toEqual([ABSENT]);

    const reread = parseUnresolvedReferenceIndex(readRecord(root));

    expect(reread).toEqual(createUnresolvedReferenceIndex(indexed.analysis.unresolvedReferences));
    expect(reread?.schemaVersion).toBe(1);
    expect(reread?.references.map((reference) => reference.missing)).toEqual([ABSENT]);
  });

  it("records the same versioned bytes for the same repository state", () => {
    const root = repository();
    const first = indexRepository(root, "2026-08-12T09:00:00.000Z");
    const firstRecord = readRecord(root);
    const second = indexRepository(root, "2026-08-12T10:00:00.000Z");

    expect(readRecord(root)).toBe(firstRecord);
    expect(second.analysis.unresolvedReferences).toEqual(first.analysis.unresolvedReferences);
  });

  // Sealed, not merely stored: the record's hash is part of the Plane-A snapshot digest, which the
  // control freshness seal binds, so the record cannot drift from the index that produced it.
  it("binds its hash into the Plane-A index snapshot", () => {
    const root = repository();
    indexRepository(root, "2026-08-12T09:00:00.000Z");
    const store = openStore(root);
    let snapshotRaw: string | undefined;
    try {
      snapshotRaw = store.getMeta(PLANE_A_INDEX_SNAPSHOT_META_KEY);
    } finally {
      store.close();
    }

    const snapshot = parsePlaneAIndexSnapshot(snapshotRaw);

    expect(snapshot?.unresolvedReferenceIndexHash).toBe(
      parseUnresolvedReferenceIndex(readRecord(root))?.indexHash,
    );
  });

  it("keeps the gap visible in every verdict drawn from that index", () => {
    const root = repository();
    indexRepository(root, "2026-08-12T09:00:00.000Z");

    const computation = runVerify(root, { kind: "working-tree" });

    expect(computation.report.unknowns.join("\n")).toContain(ABSENT);
    expect(computation.report.unknowns.join("\n")).toContain("targets this repository does not contain");
  });

  // A record whose hash no longer covers its contents proves nothing, so it must read as absent
  // rather than as an edited but trusted list.
  it("refuses a tampered record and names the resulting gap instead of reading it as clean", () => {
    const root = repository();
    indexRepository(root, "2026-08-12T09:00:00.000Z");
    const record = parseUnresolvedReferenceIndex(readRecord(root));
    expect(record).toBeDefined();
    writeRecord(root, JSON.stringify({ ...record, references: [] }));

    expect(parseUnresolvedReferenceIndex(readRecord(root))).toBeUndefined();
    const computation = runVerify(root, { kind: "working-tree" });
    expect(computation.report.unknowns.join("\n")).toContain("not bound to it (REGISTRY_INVALID)");
  });
});

// The substitution the self-hash alone cannot catch: an empty record that hashes itself correctly.
// Whoever can edit the store can also compute a valid hash, so the record must be tied to the index
// that claims to have produced it, not merely to itself.
describe.each(CONFIG_VERSIONS)("authored record sealing at config %s", (_label, configFor) => {
  it("refuses an empty but self-consistent record substituted for the recorded one", () => {
    const root = repository(configFor);
    indexRepository(root, "2026-08-12T09:00:00.000Z");
    const substitute = createUnresolvedReferenceIndex([]);
    expect(parseUnresolvedReferenceIndex(JSON.stringify(substitute))).toEqual(substitute);

    writeRecord(root, JSON.stringify(substitute));

    expect(controlStatus(root).verdict).not.toBe("FRESH");
    expect(indexHealth(root).binding.status).not.toBe("valid");
    const computation = runVerify(root, { kind: "working-tree" });
    expect(computation.result.verdict).toBe("BLOCK");
    expect(computation.result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "index_binding_stale",
          message: expect.stringContaining("UNRESOLVED_REFERENCE_REGISTRY_NOT_IN_SNAPSHOT"),
        }),
      ]),
    );
  });

  // Rewriting the Plane-A snapshot too repairs the record→snapshot link, but the snapshot is then
  // no longer the one the control snapshot authorized.
  it("refuses a substituted record even when the Plane-A snapshot is rewritten to match it", () => {
    const root = repository(configFor);
    indexRepository(root, "2026-08-12T09:00:00.000Z");
    const substitute = createUnresolvedReferenceIndex([]);
    const snapshot = JSON.parse(readMeta(root, PLANE_A_INDEX_SNAPSHOT_META_KEY) ?? "{}") as Record<string, unknown>;

    writeRecord(root, JSON.stringify(substitute));
    writeMeta(
      root,
      PLANE_A_INDEX_SNAPSHOT_META_KEY,
      JSON.stringify({ ...snapshot, unresolvedReferenceIndexHash: substitute.indexHash }),
    );

    expect(controlStatus(root).verdict).not.toBe("FRESH");
    expect(indexHealth(root).binding.status).not.toBe("valid");
    const computation = runVerify(root, { kind: "working-tree" });
    expect(computation.result.verdict).toBe("BLOCK");
    expect(computation.result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "index_binding_stale",
          message: expect.stringContaining("UNRESOLVED_REFERENCE_SNAPSHOT_UNAUTHORIZED"),
        }),
      ]),
    );
  });

  it("refuses an index whose authored record was removed outright", () => {
    const root = repository(configFor);
    indexRepository(root, "2026-08-12T09:00:00.000Z");

    writeRecord(root, "");

    expect(controlStatus(root).verdict).not.toBe("FRESH");
    expect(indexHealth(root).binding.status).not.toBe("valid");
    expect(runVerify(root, { kind: "working-tree" }).result.verdict).toBe("BLOCK");
  });

  // Positive control: the nominal chain must actually authorize, or every refusal above is vacuous.
  it("binds the untouched record to its own index", () => {
    const root = repository(configFor);
    indexRepository(root, "2026-08-12T09:00:00.000Z");

    const snapshotRaw = readMeta(root, PLANE_A_INDEX_SNAPSHOT_META_KEY);
    const controlRaw = readMeta(root, CONTROL_INDEX_SNAPSHOT_META_KEY);
    const control = JSON.parse(controlRaw ?? "{}") as { planeAIndexSnapshotHash?: string };

    expect(control.planeAIndexSnapshotHash).toBe(digestCanonical(JSON.parse(snapshotRaw ?? "{}")));
    expect(indexHealth(root).binding.status).toBe("valid");
    expect(runVerify(root, { kind: "working-tree" }).result.findings.map((f) => f.rule))
      .not.toContain("index_binding_stale");
  });
});
