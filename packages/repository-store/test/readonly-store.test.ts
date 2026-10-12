import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
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

  it("removes WAL sidecars when the writer closes", () => {
    const directory = temporaryDirectory();
    const dbFile = join(directory, "index.db");
    const writer = SqliteRepositoryStore.open(dbFile);

    expect(existsSync(`${dbFile}-wal`)).toBe(true);
    expect(existsSync(`${dbFile}-shm`)).toBe(true);

    writer.close();

    expect(existsSync(`${dbFile}-wal`)).toBe(false);
    expect(existsSync(`${dbFile}-shm`)).toBe(false);
  });

  it("can close an already closed writer", () => {
    const directory = temporaryDirectory();
    const writer = SqliteRepositoryStore.open(join(directory, "index.db"));

    writer.close();

    expect(() => writer.close()).not.toThrow();
  });

  it("closes a writer after a busy checkpoint and allows cleanup through a later writer", () => {
    const directory = temporaryDirectory();
    const dbFile = join(directory, "index.db");
    const writer = SqliteRepositoryStore.open(dbFile);
    writer.setMeta("checkpoint_probe", "before");
    const blocker = new Database(dbFile, { readonly: true });
    blocker.exec("BEGIN;");
    blocker.query("SELECT value FROM meta WHERE key = ?").get("checkpoint_probe");
    writer.setMeta("checkpoint_probe", "after");

    expect(() => writer.close()).toThrow("repository store checkpoint is busy");
    expect(() => writer.close()).not.toThrow();

    blocker.exec("ROLLBACK;");
    blocker.close();
    SqliteRepositoryStore.open(dbFile).close();

    const reader = SqliteRepositoryReader.openExisting(dbFile);
    expect(reader.getMeta("checkpoint_probe")).toBe("after");
    reader.close();
  });

  it("closes a writer after a concurrent write and allows cleanup through a later writer", () => {
    const directory = temporaryDirectory();
    const dbFile = join(directory, "index.db");
    const writer = SqliteRepositoryStore.open(dbFile);
    const blocker = new Database(dbFile);
    blocker.exec("BEGIN IMMEDIATE;");
    blocker.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("checkpoint_probe", "concurrent");

    expect(() => writer.close()).toThrow("repository store checkpoint is busy");
    expect(() => writer.close()).not.toThrow();

    blocker.exec("COMMIT;");
    blocker.close();
    SqliteRepositoryStore.open(dbFile).close();

    const reader = SqliteRepositoryReader.openExisting(dbFile);
    expect(reader.getMeta("checkpoint_probe")).toBe("concurrent");
    reader.close();
  });

  it("closes a writer when an idle reader blocks WAL cleanup and permits later cleanup", () => {
    const directory = temporaryDirectory();
    const dbFile = join(directory, "index.db");
    const writer = SqliteRepositoryStore.open(dbFile);
    writer.setMeta("checkpoint_probe", "ready");
    const blocker = new Database(dbFile, { readonly: true });
    blocker.query("SELECT value FROM meta WHERE key = ?").get("checkpoint_probe");

    expect(() => writer.close()).toThrow("repository store cannot leave WAL mode");
    expect(() => writer.close()).not.toThrow();

    blocker.close();
    SqliteRepositoryStore.open(dbFile).close();

    const reader = SqliteRepositoryReader.openExisting(dbFile);
    expect(reader.getMeta("checkpoint_probe")).toBe("ready");
    reader.close();
  });

  it("cleans up after multiple managed writers close in either order", () => {
    for (const reverseCloseOrder of [false, true]) {
      const directory = temporaryDirectory();
      const dbFile = join(directory, "index.db");
      const first = SqliteRepositoryStore.open(dbFile);
      const second = SqliteRepositoryStore.open(dbFile);
      first.setMeta("first_writer", "closed");
      second.setMeta("second_writer", "closed");

      if (reverseCloseOrder) {
        second.close();
        first.close();
      } else {
        first.close();
        second.close();
      }

      expect(existsSync(`${dbFile}-wal`)).toBe(false);
      expect(existsSync(`${dbFile}-shm`)).toBe(false);
      const reader = SqliteRepositoryReader.openExisting(dbFile);
      expect(reader.getMeta("first_writer")).toBe("closed");
      expect(reader.getMeta("second_writer")).toBe("closed");
      reader.close();
    }
  });

  it("tracks managed writers by canonical path through a filesystem alias", () => {
    for (const reverseCloseOrder of [false, true]) {
      const directory = temporaryDirectory();
      const realDirectory = join(directory, "real");
      const aliasDirectory = join(directory, "alias");
      mkdirSync(realDirectory);
      symlinkSync(realDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
      const dbFile = join(realDirectory, "index.db");
      const aliasedDbFile = join(aliasDirectory, "index.db");
      const first = SqliteRepositoryStore.open(dbFile);
      const second = SqliteRepositoryStore.open(aliasedDbFile);

      if (reverseCloseOrder) {
        second.close();
        first.close();
      } else {
        first.close();
        second.close();
      }

      expect(existsSync(`${dbFile}-wal`)).toBe(false);
      expect(existsSync(`${dbFile}-shm`)).toBe(false);
      expect(() => SqliteRepositoryReader.openExisting(dbFile).close()).not.toThrow();
    }
  });

  it("does not poison later cleanup when opening a store fails", () => {
    const directory = temporaryDirectory();
    const dbFile = join(directory, "index.db");
    SqliteRepositoryStore.open(dbFile).close();
    const blocker = new Database(dbFile);
    blocker.exec(`
      CREATE TRIGGER reject_schema_version
      BEFORE INSERT ON meta
      WHEN NEW.key = 'schema_version'
      BEGIN
        SELECT RAISE(ABORT, 'schema version rejected');
      END;
    `);

    expect(() => SqliteRepositoryStore.open(dbFile)).toThrow("schema version rejected");
    blocker.exec("DROP TRIGGER reject_schema_version;");
    blocker.close();

    const recovered = SqliteRepositoryStore.open(dbFile);
    recovered.close();

    expect(existsSync(`${dbFile}-wal`)).toBe(false);
    expect(existsSync(`${dbFile}-shm`)).toBe(false);
    expect(() => SqliteRepositoryReader.openExisting(dbFile).close()).not.toThrow();
  });

  it("leaves the existing database readable when writer initialization fails", () => {
    const directory = temporaryDirectory();
    const dbFile = join(directory, "index.db");
    const writer = SqliteRepositoryStore.open(dbFile);
    writer.setMeta("initialization_probe", "preserved");
    writer.close();
    const db = new Database(dbFile);
    db.exec(`
      CREATE TRIGGER reject_schema_version
      BEFORE INSERT ON meta
      WHEN NEW.key = 'schema_version'
      BEGIN
        SELECT RAISE(ABORT, 'schema version rejected');
      END;
    `);
    db.close();

    expect(() => SqliteRepositoryStore.open(dbFile)).toThrow("schema version rejected");
    expect(existsSync(`${dbFile}-wal`)).toBe(false);
    expect(existsSync(`${dbFile}-shm`)).toBe(false);
    const reader = SqliteRepositoryReader.openExisting(dbFile);
    try {
      expect(reader.getMeta("initialization_probe")).toBe("preserved");
    } finally {
      reader.close();
    }
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
