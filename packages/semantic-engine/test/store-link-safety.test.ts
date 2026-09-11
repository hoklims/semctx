import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemctxError } from "@semantic-context/core";
import { emptyModel } from "@semantic-context/semantic-model";
import {
  captureHandoff,
  formatSemanticFiles,
  initSemanticScaffold,
  loadSemanticModel,
  newChangeContract,
  readActiveChangePointer,
  readHandoff,
  writeActiveChange,
  writeChangeFile,
} from "../src/index";
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
