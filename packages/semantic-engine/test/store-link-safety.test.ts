import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemctxError } from "@semantic-context/core";
import type { RepositoryNode } from "@semantic-context/core";
import { emptyModel } from "@semantic-context/semantic-model";
import {
  activeChangePath,
  authorized,
  captureHandoff,
  formatSemanticFiles,
  initSemanticScaffold,
  loadSemanticModel,
  migrateAnchors,
  newChangeContract,
  readActiveChangePointer,
  readHandoff,
  writeActiveChange,
  writeChangeFile,
} from "../src/index";
import { changeFilePath, handoffJsonPath } from "../src/paths";
import { listSemFiles } from "../src/store";

// Authored intent lives under `.semctx/semantic`, the working pointer and handoff under
// `.semctx/working`. A checkout can plant a directory link at any of those nodes (or at `.semctx`
// itself) that points outside the repository. `existsSync`, `readdirSync` and every write follow
// links, so without a link check every read and rewrite would land wherever the link points — a
// vault escape reachable by simply cloning a hostile repository (SEC-PB-01).

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

/** A directory link; junctions need no privilege on Windows. */
function link(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

/** Probe once whether this host can create directory links; skipped tests stay visible. */
const linksSupported = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "semctx-link-probe-"));
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

/** File links need a privilege some hosts do not grant; those cases skip visibly too. */
const fileLinksSupported = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "semctx-file-link-probe-"));
  try {
    writeFileSync(join(probe, "target"), "");
    symlinkSync(join(probe, "target"), join(probe, "alias"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

const fileLinked = test.skipIf(!fileLinksSupported);

const NOW = "2026-09-11T00:00:00.000Z";

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

function contract() {
  return newChangeContract({ id: "change.link.probe", statement: "probe", file: ".semctx/semantic/changes/change.link.probe.sem" });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("semantic store refuses linked directories", () => {
  test("control: real directories load, format, write and hand off", () => {
    const root = temporary("semctx-link-control-");
    mkdirSync(join(root, ".semctx", "semantic"), { recursive: true });
    writeFileSync(join(root, ".semctx", "semantic", "goals.sem"), GOAL);

    expect(loadSemanticModel(root).model.nodes.map((node) => node.id)).toEqual(["goal.external.leak"]);
    expect(formatSemanticFiles(root, false)).toHaveLength(1);
    writeChangeFile(root, contract());
    writeActiveChange(root, contract());
    expect(readActiveChangePointer(root).state).toBe("valid");
    captureHandoff({ root, now: "2026-09-11T00:00:00.000Z", model: emptyModel() });
    expect(readHandoff(root)?.createdAt).toBe("2026-09-11T00:00:00.000Z");
  });

  linked("a linked .semctx/semantic is never read or rewritten", () => {
    const root = temporary("semctx-link-semantic-");
    const outside = temporary("semctx-link-outside-");
    mkdirSync(join(root, ".semctx"));
    writeFileSync(join(outside, "goals.sem"), GOAL);
    link(outside, join(root, ".semctx", "semantic"));

    expectConfigInvalid(() => loadSemanticModel(root));
    expectConfigInvalid(() => formatSemanticFiles(root, true));
    expectConfigInvalid(() => listSemFiles(join(root, ".semctx", "semantic")));
    expectConfigInvalid(() => writeChangeFile(root, contract()));
    expect(readdirSync(outside)).toEqual(["goals.sem"]);
    expect(readFileSync(join(outside, "goals.sem"), "utf8")).toBe(GOAL);
  });

  linked("a linked .semctx is never read, rewritten or scaffolded", () => {
    const root = temporary("semctx-link-root-");
    const outside = temporary("semctx-link-outside-");
    mkdirSync(join(outside, "semantic"));
    writeFileSync(join(outside, "semantic", "goals.sem"), GOAL);
    link(outside, join(root, ".semctx"));

    expectConfigInvalid(() => loadSemanticModel(root));
    expectConfigInvalid(() => formatSemanticFiles(root, true));
    expectConfigInvalid(() => initSemanticScaffold(root));
    expectConfigInvalid(() => writeActiveChange(root, contract()));
    expectConfigInvalid(() => captureHandoff({ root, now: "2026-09-11T00:00:00.000Z", model: emptyModel() }));
    expect(existsSync(join(outside, "working"))).toBe(false);
    expect(existsSync(join(outside, "semantic", "invariants.sem"))).toBe(false);
    expect(readFileSync(join(outside, "semantic", "goals.sem"), "utf8")).toBe(GOAL);
  });

  linked("a linked changes directory is refused before any contract is written through it", () => {
    const root = temporary("semctx-link-changes-");
    const outside = temporary("semctx-link-outside-");
    mkdirSync(join(root, ".semctx", "semantic"), { recursive: true });
    writeFileSync(join(root, ".semctx", "semantic", "goals.sem"), GOAL);
    link(outside, join(root, ".semctx", "semantic", "changes"));

    expectConfigInvalid(() => loadSemanticModel(root));
    expectConfigInvalid(() => writeChangeFile(root, contract()));
    expect(readdirSync(outside)).toEqual([]);
  });

  linked("a linked working directory is refused for the active pointer and the handoff", () => {
    const root = temporary("semctx-link-working-");
    const outside = temporary("semctx-link-outside-");
    mkdirSync(join(root, ".semctx", "semantic"), { recursive: true });
    writeFileSync(join(outside, "active-change.sem"), "");
    link(outside, join(root, ".semctx", "working"));

    expectConfigInvalid(() => writeActiveChange(root, contract()));
    expectConfigInvalid(() => readActiveChangePointer(root));
    expectConfigInvalid(() => captureHandoff({ root, now: "2026-09-11T00:00:00.000Z", model: emptyModel() }));
    expectConfigInvalid(() => readHandoff(root));
    expect(readdirSync(outside)).toEqual(["active-change.sem"]);
    expect(readFileSync(join(outside, "active-change.sem"), "utf8")).toBe("");
  });

  linked("the walk root itself is checked, not only its parent", () => {
    const outside = temporary("semctx-link-outside-");
    const holder = temporary("semctx-link-holder-");
    writeFileSync(join(outside, "goals.sem"), GOAL);
    link(outside, join(holder, "semantic"));

    expectConfigInvalid(() => listSemFiles(join(holder, "semantic")));
  });
});

describe("semantic store refuses dangling links, planted temporaries and linked destinations", () => {
  linked("a dangling working link is refused rather than treated as absent", () => {
    const root = temporary("semctx-link-dangling-");
    const outside = temporary("semctx-link-outside-");
    mkdirSync(join(root, ".semctx", "semantic"), { recursive: true });
    mkdirSync(join(outside, "gone"));
    link(join(outside, "gone"), join(root, ".semctx", "working"));
    rmSync(join(outside, "gone"), { recursive: true, force: true });

    expectConfigInvalid(() => readActiveChangePointer(root));
    expectConfigInvalid(() => writeActiveChange(root, contract()));
    expectConfigInvalid(() => captureHandoff({ root, now: NOW, model: emptyModel() }));
    expect(existsSync(join(outside, "gone"))).toBe(false);
  });

  fileLinked("a planted temporary-file link never receives a change contract", () => {
    const root = temporary("semctx-link-tmp-change-");
    const outside = temporary("semctx-link-outside-");
    mkdirSync(join(root, ".semctx", "semantic", "changes"), { recursive: true });
    const destination = changeFilePath(root, "change.link.probe");
    // A tracked `<file>.tmp` link: a writer that stages through that exact name follows it.
    symlinkSync(join(outside, "leak.sem"), `${destination}.tmp`, "file");

    writeChangeFile(root, contract());

    expect(existsSync(join(outside, "leak.sem"))).toBe(false);
    expect(lstatSync(destination).isSymbolicLink()).toBe(false);
    expect(readFileSync(destination, "utf8")).toContain("change change.link.probe");
    expect(lstatSync(`${destination}.tmp`).isSymbolicLink()).toBe(true);
  });

  fileLinked("a planted temporary-file link never receives the handoff capsule", () => {
    const root = temporary("semctx-link-tmp-handoff-");
    const outside = temporary("semctx-link-outside-");
    mkdirSync(join(root, ".semctx", "working"), { recursive: true });
    symlinkSync(join(outside, "handoff.json"), `${handoffJsonPath(root)}.tmp`, "file");

    captureHandoff({ root, now: NOW, model: emptyModel() });

    expect(existsSync(join(outside, "handoff.json"))).toBe(false);
    expect(lstatSync(handoffJsonPath(root)).isSymbolicLink()).toBe(false);
    expect(readHandoff(root)?.createdAt).toBe(NOW);
  });

  fileLinked("a working file that is itself a link is refused as a destination and as a source", () => {
    const root = temporary("semctx-link-destination-");
    const outside = temporary("semctx-link-outside-");
    mkdirSync(join(root, ".semctx", "working"), { recursive: true });
    writeFileSync(join(outside, "active-change.sem"), "");
    symlinkSync(join(outside, "active-change.sem"), activeChangePath(root), "file");

    expectConfigInvalid(() => writeActiveChange(root, contract()));
    expectConfigInvalid(() => readActiveChangePointer(root));
    expect(readFileSync(join(outside, "active-change.sem"), "utf8")).toBe("");
  });

  linked("the anchor migration refuses a linked .semctx before recovery, planning or writing", () => {
    const root = temporary("semctx-link-migration-");
    const outside = temporary("semctx-link-outside-");
    const legacy = "invariant invariant.one\n  statement: something must hold\n  status: declared\n  link: sym:function:src/a.ts:run:42\n";
    mkdirSync(join(outside, "semantic"), { recursive: true });
    writeFileSync(join(outside, "semantic", "invariants.sem"), legacy);
    link(outside, join(root, ".semctx"));
    const run: RepositoryNode = { id: "sym:function:src/a.ts:run", kind: "function", name: "run", filePath: "src/a.ts", evidence: [], tags: [], metadata: {} };
    const generation = { snapshot: "snapshot-link", facts: "facts-link" };

    expectConfigInvalid(() => migrateAnchors(
      root,
      { graph: { nodes: [run], edges: [] }, claims: [], evidence: [] },
      { apply: true, authority: authorized(generation), factsIdentity: generation.facts },
    ));
    expect(readFileSync(join(outside, "semantic", "invariants.sem"), "utf8")).toBe(legacy);
    expect(readdirSync(outside)).toEqual(["semantic"]);
  });
});
