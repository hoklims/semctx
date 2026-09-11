import { afterEach, describe, expect, it, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemctxError, createDefaultConfig } from "@semantic-context/core";
import { SqliteRepositoryReader, SqliteRepositoryStore } from "../src/store";
import { dbPath, initWorkspace, loadConfig, openStore, saveConfig } from "../src/workspace";

// `semctx init` is the first command that touches a checkout, before any semantic guard runs.
// A checkout that ships `.semctx` as a link to another location would have its configuration,
// context packs and index written there (SEC-PB-01, workspace arm).

const roots: string[] = [];

function temporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function link(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

/** Probe once per link kind; a host that cannot create a kind skips its cases visibly. */
function probe(create: (probeDir: string) => void): boolean {
  const probeDir = mkdtempSync(join(tmpdir(), "semctx-workspace-link-probe-"));
  try {
    create(probeDir);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

const linksSupported = probe((probeDir) => link(probeDir, join(probeDir, "self")));
const fileLinksSupported = probe((probeDir) => {
  writeFileSync(join(probeDir, "target"), "");
  symlinkSync(join(probeDir, "target"), join(probeDir, "alias"), "file");
});

const linked = test.skipIf(!linksSupported);
const fileLinked = test.skipIf(!fileLinksSupported);

function expectConfigInvalid(run: () => unknown): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SemctxError);
  expect((caught as SemctxError).code).toBe("CONFIG_INVALID");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace refuses a linked .semctx", () => {
  it("control: a real .semctx initialises, saves, loads and opens", () => {
    const root = temporary("semctx-workspace-control-");
    const config = initWorkspace(root);
    saveConfig(root, config);
    expect(loadConfig(root).repositoryRoot).toBe(config.repositoryRoot);
    openStore(root).close();
    expect(existsSync(join(root, ".semctx", "semctx.db"))).toBe(true);
  });

  linked("init, save, load and open all refuse a linked .semctx and write nothing through it", () => {
    const root = temporary("semctx-workspace-root-");
    const outside = temporary("semctx-workspace-outside-");
    link(outside, join(root, ".semctx"));

    expectConfigInvalid(() => initWorkspace(root));
    expectConfigInvalid(() => saveConfig(root, createDefaultConfig(root)));
    expectConfigInvalid(() => loadConfig(root));
    expectConfigInvalid(() => openStore(root));
    expect(readdirSync(outside)).toEqual([]);
  });

  linked("a dangling .semctx link is refused rather than treated as absent", () => {
    const root = temporary("semctx-workspace-dangling-");
    const outside = temporary("semctx-workspace-outside-");
    mkdirSync(join(outside, "gone"));
    link(join(outside, "gone"), join(root, ".semctx"));
    rmSync(join(outside, "gone"), { recursive: true, force: true });

    expectConfigInvalid(() => initWorkspace(root));
    expectConfigInvalid(() => loadConfig(root));
    expect(readdirSync(outside)).toEqual([]);
  });

  linked("a linked context-packs directory is refused", () => {
    const root = temporary("semctx-workspace-packs-");
    const outside = temporary("semctx-workspace-outside-");
    mkdirSync(join(root, ".semctx"));
    link(outside, join(root, ".semctx", "context-packs"));

    expectConfigInvalid(() => initWorkspace(root));
    expect(existsSync(join(root, ".semctx", "config.json"))).toBe(false);
  });

  fileLinked("a config.json that is itself a link is refused", () => {
    const root = temporary("semctx-workspace-config-");
    const outside = temporary("semctx-workspace-outside-");
    mkdirSync(join(root, ".semctx"));
    writeFileSync(join(outside, "config.json"), "{}\n");
    symlinkSync(join(outside, "config.json"), join(root, ".semctx", "config.json"), "file");

    expectConfigInvalid(() => loadConfig(root));
    expectConfigInvalid(() => saveConfig(root, createDefaultConfig(root)));
  });

  fileLinked("a dangling config.json link is refused, never followed into the outside directory", () => {
    const root = temporary("semctx-workspace-dangling-config-");
    const outside = temporary("semctx-workspace-outside-");
    mkdirSync(join(root, ".semctx"));
    // The target does not exist yet: `existsSync` reports the link as absent, but a write through
    // it would create the config file outside the checkout.
    symlinkSync(join(outside, "config.json"), join(root, ".semctx", "config.json"), "file");

    expectConfigInvalid(() => saveConfig(root, createDefaultConfig(root)));
    expectConfigInvalid(() => initWorkspace(root));
    expect(existsSync(join(outside, "config.json"))).toBe(false);
  });

  linked("a linked SQLite sidecar is refused before the index is opened", () => {
    const root = temporary("semctx-workspace-sidecar-");
    const outside = temporary("semctx-workspace-outside-");
    initWorkspace(root);
    link(outside, `${dbPath(root)}-wal`);

    expectConfigInvalid(() => openStore(root));
    expect(existsSync(dbPath(root))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  fileLinked("a sidecar linked to an outside file is refused by the writer and the reader", () => {
    const root = temporary("semctx-workspace-sidecar-file-");
    const outside = temporary("semctx-workspace-outside-");
    initWorkspace(root);
    openStore(root).close();
    writeFileSync(join(outside, "shm"), "");
    symlinkSync(join(outside, "shm"), `${dbPath(root)}-shm`, "file");

    expectConfigInvalid(() => openStore(root));
    expectConfigInvalid(() => SqliteRepositoryReader.openExisting(dbPath(root)));
  });

  fileLinked("the read-only reader refuses a semctx.db that links to an outside database", () => {
    const root = temporary("semctx-workspace-reader-");
    const outside = temporary("semctx-workspace-outside-");
    const outsideDatabase = join(outside, "outside.db");
    SqliteRepositoryStore.open(outsideDatabase).close();
    initWorkspace(root);
    symlinkSync(outsideDatabase, dbPath(root), "file");

    expectConfigInvalid(() => SqliteRepositoryReader.openExisting(dbPath(root)));
    expectConfigInvalid(() => openStore(root));
  });
});
