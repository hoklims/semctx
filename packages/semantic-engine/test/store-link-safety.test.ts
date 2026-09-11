import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemctxError } from "@semantic-context/core";
import { formatSemanticFiles, initSemanticScaffold, loadSemanticModel } from "../src/index";
import { listSemFiles } from "../src/store";

// Authored intent lives under `.semctx/semantic`. A checkout can plant a directory link there (or
// at `.semctx` itself) that points outside the repository. `existsSync` and `readdirSync` follow
// links, so without a link check every read and rewrite of `*.sem` would land wherever the link
// points — a vault escape reachable by simply cloning a hostile repository (SEC-PB-01).

const GOAL = `goal goal.external.leak
  statement: authored outside the repository
  status: declared
`;

const roots: string[] = [];

function temporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

/** A directory link; junctions need no privilege on Windows. `false` when the host refuses links. */
function link(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

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

describe("semantic store refuses linked directories", () => {
  test("control: real directories load and format", () => {
    const root = temporary("semctx-link-control-");
    mkdirSync(join(root, ".semctx", "semantic"), { recursive: true });
    writeFileSync(join(root, ".semctx", "semantic", "goals.sem"), GOAL);

    expect(loadSemanticModel(root).model.nodes.map((node) => node.id)).toEqual(["goal.external.leak"]);
    expect(formatSemanticFiles(root, false)).toHaveLength(1);
  });

  test("a linked .semctx/semantic is never read or rewritten", () => {
    const root = temporary("semctx-link-semantic-");
    const outside = temporary("semctx-link-outside-");
    mkdirSync(join(root, ".semctx"));
    writeFileSync(join(outside, "goals.sem"), GOAL);
    if (!link(outside, join(root, ".semctx", "semantic"))) return;

    expectConfigInvalid(() => loadSemanticModel(root));
    expectConfigInvalid(() => formatSemanticFiles(root, true));
    expectConfigInvalid(() => listSemFiles(join(root, ".semctx", "semantic")));
    expect(readFileSync(join(outside, "goals.sem"), "utf8")).toBe(GOAL);
  });

  test("a linked .semctx is never read, rewritten or scaffolded", () => {
    const root = temporary("semctx-link-root-");
    const outside = temporary("semctx-link-outside-");
    mkdirSync(join(outside, "semantic"));
    writeFileSync(join(outside, "semantic", "goals.sem"), GOAL);
    if (!link(outside, join(root, ".semctx"))) return;

    expectConfigInvalid(() => loadSemanticModel(root));
    expectConfigInvalid(() => formatSemanticFiles(root, true));
    expectConfigInvalid(() => initSemanticScaffold(root));
    expect(existsSync(join(outside, "working"))).toBe(false);
    expect(existsSync(join(outside, "semantic", "invariants.sem"))).toBe(false);
    expect(readFileSync(join(outside, "semantic", "goals.sem"), "utf8")).toBe(GOAL);
  });

  test("a linked changes directory is refused before any contract is written through it", () => {
    const root = temporary("semctx-link-changes-");
    const outside = temporary("semctx-link-outside-");
    mkdirSync(join(root, ".semctx", "semantic"), { recursive: true });
    writeFileSync(join(root, ".semctx", "semantic", "goals.sem"), GOAL);
    if (!link(outside, join(root, ".semctx", "semantic", "changes"))) return;

    expectConfigInvalid(() => loadSemanticModel(root));
  });

  test("the walk root itself is checked, not only its parent", () => {
    const outside = temporary("semctx-link-outside-");
    const holder = temporary("semctx-link-holder-");
    writeFileSync(join(outside, "goals.sem"), GOAL);
    if (!link(outside, join(holder, "semantic"))) return;

    expectConfigInvalid(() => listSemFiles(join(holder, "semantic")));
  });
});
