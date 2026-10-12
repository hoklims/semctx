import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRepositoryReader, SqliteRepositoryStore } from "@semantic-context/repository-store";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "semctx-contention-"));
  directories.push(directory);
  return join(directory, "index.db");
}

async function lockDatabase(path: string, mode = "writer") {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "locked-store.ts"), path, mode], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  const reader = child.stdout.getReader();
  const ready = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(ready.value).trim()).toBe("locked");
  return child;
}

async function finish(child: Awaited<ReturnType<typeof lockDatabase>>): Promise<void> {
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stderr).text()).toBe("");
}

function readProbe(path: string): string | undefined {
  expect(existsSync(`${path}-wal`)).toBe(false);
  expect(existsSync(`${path}-shm`)).toBe(false);
  const reader = SqliteRepositoryReader.openExisting(path);
  try {
    return reader.getMeta("probe");
  } finally {
    reader.close();
  }
}

describe("repository store contention across processes", () => {
  for (const operation of ["open", "write"]) {
    it(`bounds ${operation} contention and leaves the database recoverable`, async () => {
      const path = databasePath();
      const store = SqliteRepositoryStore.open(path);
      if (operation === "open") store.close();
      const holder = await lockDatabase(path);
      const startedAt = performance.now();
      try {
        expect(() => operation === "open" ? SqliteRepositoryStore.open(path) : store.setMeta("probe", "lost"))
          .toThrow(expect.objectContaining({ code: "SQLITE_BUSY" }));
        const elapsed = performance.now() - startedAt;
        expect(elapsed).toBeGreaterThanOrEqual(800);
        expect(elapsed).toBeLessThan(4_000);
      } finally {
        await holder.stdin.write("release\n");
        await holder.stdin.end();
        await finish(holder);
        store.close();
      }
      expect(readProbe(path)).toBeUndefined();
      const reader = SqliteRepositoryReader.openExisting(path);
      try {
        expect(reader.getMeta("holder")).toBe("committed");
      } finally {
        reader.close();
      }
    });
  }

  it("opens a writer after a concurrent transaction releases its lock", async () => {
    const path = databasePath();
    SqliteRepositoryStore.open(path).close();
    const holder = await lockDatabase(path);
    await holder.stdin.write("delayed\n");
    await holder.stdin.flush();
    await holder.stdin.end();
    try {
      const startedAt = performance.now();
      const store = SqliteRepositoryStore.open(path);
      try {
        expect(performance.now() - startedAt).toBeGreaterThanOrEqual(100);
        store.setMeta("probe", "opened");
      } finally {
        await finish(holder);
        store.close();
      }
      expect(readProbe(path)).toBe("opened");
    } finally {
      if (holder.exitCode === null) await finish(holder);
    }
  });

  it("waits for a concurrent writer before persisting a value", async () => {
    const path = databasePath();
    const store = SqliteRepositoryStore.open(path);
    const holder = await lockDatabase(path);
    await holder.stdin.write("delayed\n");
    await holder.stdin.flush();
    await holder.stdin.end();
    try {
      const startedAt = performance.now();
      store.setMeta("probe", "written");
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(100);
    } finally {
      await finish(holder);
      store.close();
    }
    expect(readProbe(path)).toBe("written");
  });

  it("waits for a transient reader before checkpointing and removing sidecars", async () => {
    const path = databasePath();
    const store = SqliteRepositoryStore.open(path);
    store.setMeta("probe", "before");
    const holder = await lockDatabase(path, "reader");
    store.setMeta("probe", "after");
    await holder.stdin.write("delayed\n");
    await holder.stdin.flush();
    await holder.stdin.end();
    try {
      const startedAt = performance.now();
      store.close();
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(100);
    } finally {
      await finish(holder);
      store.close();
    }
    expect(readProbe(path)).toBe("after");
  });
});
