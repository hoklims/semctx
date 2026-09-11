import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemctxError } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { checkSemanticState, indexRepository, openReadyRepository } from "../src";

// Readiness and the semantic check reach the index through the read-only reader without going
// through `loadConfig`. A checkout whose `.semctx` is a link to another repository's `.semctx`
// must not have its neighbour's index served as its own (SEC-PB-01, read-only arm).

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
  const probe = mkdtempSync(join(tmpdir(), "semctx-readiness-link-probe-"));
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

/** An indexed repository whose graph names a symbol no other fixture declares. */
function indexedNeighbour(): string {
  const root = temporary("semctx-readiness-neighbour-");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "secret.ts"), "export function signToken(): string {\n  return \"token\";\n}\n");
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  initWorkspace(root);
  indexRepository(root, "2026-09-11T00:00:00.000Z");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("read-only readiness refuses a linked .semctx", () => {
  test("control: an indexed repository opens its own reader", () => {
    const root = indexedNeighbour();
    const reader = openReadyRepository(root);
    try {
      expect(reader.loadGraph().nodes.some((node) => node.id.endsWith("signToken"))).toBe(true);
    } finally {
      reader.close();
    }
  });

  linked("readiness never serves a neighbour's index through a linked .semctx", () => {
    const neighbour = indexedNeighbour();
    const root = temporary("semctx-readiness-root-");
    link(join(neighbour, ".semctx"), join(root, ".semctx"));

    expectConfigInvalid(() => openReadyRepository(root));
  });

  linked("the semantic check never reads a neighbour's index or verification state through a linked .semctx", () => {
    const neighbour = indexedNeighbour();
    const root = temporary("semctx-readiness-check-");
    link(join(neighbour, ".semctx"), join(root, ".semctx"));

    expectConfigInvalid(() => checkSemanticState(root));
  });
});
