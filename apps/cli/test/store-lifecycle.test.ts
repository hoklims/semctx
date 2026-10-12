import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dbPath, initWorkspace, loadConfig, saveConfig, openStore, SqliteRepositoryReader } from "@semantic-context/repository-store";
import { defaultTaskExtractor, extractionContext } from "@semantic-context/context-engine";
import { SemctxError } from "@semantic-context/core";
import { parseArgs } from "../src/args";
import { withStore, withStoreAsync } from "../src/store";
import { runContextPrepare } from "../src/commands/context";
import { runBenchCmd } from "../src/commands/bench";
import { runInspect } from "../src/commands/inspect";
import { runTaskCreate } from "../src/commands/task";
import { runSemantic } from "../src/commands/semantic";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-cli-store-"));
  directories.push(root);
  initWorkspace(root);
  const store = openStore(root);
  try {
    store.saveGraph({ nodes: [{ id: "mod:probe.ts", kind: "module", name: "probe.ts", filePath: "probe.ts", tags: [], evidence: [], metadata: {} }], edges: [] }, []);
  } finally {
    store.close();
  }
  return root;
}

function assertReadable(root: string): void {
  const path = dbPath(root);
  expect(existsSync(`${path}-wal`)).toBe(false);
  expect(existsSync(`${path}-shm`)).toBe(false);
  const reader = SqliteRepositoryReader.openExisting(path);
  try {
    expect(reader.isIndexed()).toBe(true);
  } finally {
    reader.close();
  }
}

function corruptClaims(root: string): void {
  const db = new Database(dbPath(root));
  try {
    db.exec("INSERT INTO claims VALUES ('broken', 'behavior', 'probe', '[]', '[]', 1, 1, 1, 'invalid', NULL, NULL, '[]');");
  } finally {
    db.close();
  }
}

describe("CLI writer lifecycle", () => {
  it("closes context preparation after an available provider fails, before the process exits", () => {
    const root = workspace();
    saveConfig(root, { ...loadConfig(root), semanticProvider: "cocoindex" });
    const frame = withStore(root, (store) => {
      const task = defaultTaskExtractor.extract({ rawTask: "probe" }, extractionContext(store.loadGraph(), "2026-10-10T00:00:00Z"));
      store.saveTaskFrame(task);
      return task;
    });
    const executable = join(root, process.platform === "win32" ? "ccc.cmd" : "ccc");
    writeFileSync(executable, process.platform === "win32"
      ? '@echo off\r\nif "%1"=="version" (\r\n echo 1.0.0\r\n exit /b 0\r\n)\r\nexit /b 9\r\n'
      : '#!/bin/sh\nif [ "$1" = "version" ]; then echo 1.0.0; exit 0; fi\nexit 9\n');
    if (process.platform !== "win32") chmodSync(executable, 0o755);
    const contextModule = pathToFileURL(join(import.meta.dir, "../src/commands/context.ts")).href;
    const script = `
      import { runContextPrepare } from ${JSON.stringify(contextModule)};
      import { dbPath, SqliteRepositoryReader } from "@semantic-context/repository-store";
      import { existsSync } from "node:fs";
      let failure;
      try {
        await runContextPrepare(${JSON.stringify(root)}, { positionals: ["context", "prepare", ${JSON.stringify(frame.id)}], flags: new Map([["json", true]]) });
      } catch (error) { failure = { name: error.name, code: error.code }; }
      const path = dbPath(${JSON.stringify(root)});
      const sidecars = [existsSync(path + "-wal"), existsSync(path + "-shm")];
      let nodes = null;
      try {
        const reader = SqliteRepositoryReader.openExisting(path);
        try { nodes = reader.loadGraph().nodes.length; } finally { reader.close(); }
      } catch {}
      console.log(JSON.stringify({ failure, sidecars, nodes }));
    `;
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
    const result = Bun.spawnSync([process.execPath, "--eval", script], {
      cwd: join(import.meta.dir, "../../.."), env: { ...environment, PATH: root },
      stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
      failure: { name: "CocoIndexProviderError", code: "PROCESS_FAILURE" }, sidecars: [false, false], nodes: 1,
    });
  });

  for (const asynchronous of [false, true]) {
    it(`retains both operation and cleanup failures (${asynchronous ? "async" : "sync"})`, async () => {
      const root = workspace();
      let blocker: Database | undefined;
      const operation = () => {
        blocker = new Database(dbPath(root), { readonly: true });
        blocker.query("SELECT * FROM meta").all();
        throw new SemctxError("TASK_NOT_FOUND", "primary failure");
      };
      let failure: unknown;
      try {
        if (asynchronous) await withStoreAsync(root, async () => operation());
        else withStore(root, operation);
      } catch (error) {
        failure = error;
      } finally {
        blocker?.close();
      }
      expect(failure).toMatchObject({
        code: "TASK_NOT_FOUND", message: "primary failure",
        suppressed: [expect.objectContaining({ code: "STORE_ERROR", message: "repository store cannot leave WAL mode" })],
      });
      openStore(root).close();
      assertReadable(root);
    });
  }

  it("closes context preparation after persisted task validation throws", async () => {
    const root = workspace();
    const db = new Database(dbPath(root));
    db.exec("INSERT INTO task_frames VALUES ('broken', 'probe', '{}', '2026-10-10T00:00:00Z');");
    db.close();
    const failure = await runContextPrepare(root, parseArgs(["context", "prepare", "broken", "--json"]))
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    assertReadable(root);
  });

  for (const command of ["bench", "inspect", "semantic"]) {
    it(`closes ${command} after persisted claims validation throws`, () => {
      const root = workspace();
      corruptClaims(root);
      writeFileSync(join(root, "semctx-bench.json"), "[]");
      const invoke = command === "bench" ? () => runBenchCmd(root, parseArgs(["bench", "--json"]))
        : command === "inspect" ? () => runInspect(root, parseArgs(["inspect", "any", "probe", "--json"]))
          : () => runSemantic(root, parseArgs(["semantic", "inspect", "invariant.probe", "--json"]));
      expect(invoke).toThrow();
      assertReadable(root);
    });
  }

  it("closes task creation after SQLite rejects persistence", () => {
    const root = workspace();
    const db = new Database(dbPath(root));
    db.exec("CREATE TRIGGER reject_task BEFORE INSERT ON task_frames BEGIN SELECT RAISE(ABORT, 'task rejected'); END;");
    db.close();
    expect(() => runTaskCreate(root, parseArgs(["task", "create", "--text", "probe", "--json"]))).toThrow("task rejected");
    assertReadable(root);
  });
});
