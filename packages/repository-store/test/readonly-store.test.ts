import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SqliteRepositoryReader, SqliteRepositoryStore } from "@semantic-context/repository-store";
import type { EvidenceRecord, RepositoryGraph } from "@semantic-context/core";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteRepositoryReader", () => {
  it("fails without creating an uninitialized repository store", () => {
    const directory = temporaryDirectory();
    const dbFile = join(directory, ".semctx", "index.db");
    const before = treeSnapshot(directory);

    expect(() => SqliteRepositoryReader.openExisting(dbFile)).toThrow("repository store does not exist");

    expect(treeSnapshot(directory)).toEqual(before);
    expect(existsSync(dbFile)).toBe(false);
  });

  it("reads an initialized store without changing files or creating WAL sidecars", () => {
    const directory = temporaryDirectory();
    const dbFile = join(directory, "index.db");
    const graph: RepositoryGraph = {
      nodes: [
        {
          id: "mod:reader.ts",
          kind: "module",
          name: "reader.ts",
          filePath: "reader.ts",
          evidence: [{ filePath: "reader.ts", sourceKind: "code" }],
          tags: [],
          metadata: {},
        },
      ],
      edges: [],
    };
    const evidence: EvidenceRecord[] = [
      { id: "ev:reader", filePath: "reader.ts", sourceKind: "code" },
    ];
    const writer = SqliteRepositoryStore.open(dbFile);
    writer.saveGraph(graph, evidence);
    writer.close();
    const before = treeSnapshot(directory);

    const reader = SqliteRepositoryReader.openExisting(dbFile);
    expect((reader as unknown as Record<string, unknown>)["saveGraph"]).toBeUndefined();
    expect((reader as unknown as Record<string, unknown>)["setMeta"]).toBeUndefined();
    expect(reader.loadGraph()).toEqual(graph);
    expect(reader.loadEvidence()).toEqual(evidence);
    expect(reader.loadClaims()).toEqual([]);
    expect(reader.getMeta("schema_version")).toBeDefined();
    expect(reader.isIndexed()).toBe(true);
    reader.close();

    expect(treeSnapshot(directory)).toEqual(before);
    expect(existsSync(`${dbFile}-wal`)).toBe(false);
    expect(existsSync(`${dbFile}-shm`)).toBe(false);
  });

  it("fails closed when WAL sidecars indicate a possibly active writer", () => {
    const directory = temporaryDirectory();
    const dbFile = join(directory, "index.db");
    const writer = SqliteRepositoryStore.open(dbFile);
    const before = treeSnapshot(directory);

    expect(() => SqliteRepositoryReader.openExisting(dbFile)).toThrow("active WAL sidecars");
    expect(treeSnapshot(directory)).toEqual(before);

    writer.close();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "semctx-readonly-store-"));
  directories.push(directory);
  return directory;
}

function treeSnapshot(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const path of walk(root)) {
    const key = relative(root, path).replaceAll("\\", "/");
    const stat = statSync(path);
    snapshot[key] = stat.isDirectory()
      ? "directory"
      : createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return snapshot;
}

function walk(root: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    paths.push(path);
    if (entry.isDirectory()) paths.push(...walk(path));
  }
  return paths.sort();
}
