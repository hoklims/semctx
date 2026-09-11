import { afterEach, describe, expect, it, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemctxError, createDefaultConfig } from "@semantic-context/core";
import { initWorkspace, loadConfig, openStore, saveConfig } from "../src/workspace";

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

const linksSupported = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "semctx-workspace-link-probe-"));
  try {
    link(probe, join(probe, "self"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

const linked = test.skipIf(!linksSupported);

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

  linked("a linked context-packs directory is refused", () => {
    const root = temporary("semctx-workspace-packs-");
    const outside = temporary("semctx-workspace-outside-");
    mkdirSync(join(root, ".semctx"));
    link(outside, join(root, ".semctx", "context-packs"));

    expectConfigInvalid(() => initWorkspace(root));
    expect(existsSync(join(root, ".semctx", "config.json"))).toBe(false);
  });

  linked("a config.json that is itself a link is refused", () => {
    const root = temporary("semctx-workspace-config-");
    const outside = temporary("semctx-workspace-outside-");
    mkdirSync(join(root, ".semctx"));
    writeFileSync(join(outside, "config.json"), "{}\n");
    try {
      symlinkSync(join(outside, "config.json"), join(root, ".semctx", "config.json"), "file");
    } catch {
      return; // file links need a privilege this host does not grant; the directory cases above still run
    }

    expectConfigInvalid(() => loadConfig(root));
    expectConfigInvalid(() => saveConfig(root, createDefaultConfig(root)));
  });
});
