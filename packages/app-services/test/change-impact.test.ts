import { afterAll, describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChangeImpactReportSchema, createDefaultConfig, type ChangeImpactReport } from "@semantic-context/core";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import { REPO_ROOT } from "@semantic-context/test-fixtures";
import { indexRepository, runChangeImpact } from "../src";
import { CONTROL_INDEX_SNAPSHOT_META_KEY } from "../src/freshness";
import { __setVerifyControlBarrierForTesting } from "../src/verify";

/**
 * End-to-end contract of `runChangeImpact` on the replay/live fixture: a small replay change must
 * stay small without anything being declared safe, and every index-derived set must disappear the
 * moment the index is not provably in the coordinates of the diff side it is joined on.
 */

const FIXTURE = join(REPO_ROOT, "examples", "change-impact-replay");
const PINS = "packages/protocol/src/pins.ts";
const CANONICAL = "sym:function:packages/protocol/src/pins.ts:canonicalReplayName";
const IS_REPLAY_SAFE = "sym:function:packages/protocol/src/pins.ts:isReplaySafe";
const MATCHES_PIN = "sym:function:packages/protocol/src/pins.ts:matchesProtocolPin";
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Semctx Test",
  GIT_AUTHOR_EMAIL: "semctx@example.test",
  GIT_COMMITTER_NAME: "Semctx Test",
  GIT_COMMITTER_EMAIL: "semctx@example.test",
  GIT_AUTHOR_DATE: "2026-09-01T10:00:00Z",
  GIT_COMMITTER_DATE: "2026-09-01T10:00:00Z",
};
const parents: string[] = [];

afterAll(() => {
  __setVerifyControlBarrierForTesting(undefined);
  for (const parent of parents) rmSync(parent, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "core.autocrlf=false", ...args], { cwd: root, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

/** `gitRootAbove` places the semctx root in a subdirectory of the Git repository. */
function repository(extraFiles: Record<string, string> = {}, options: { gitRootAbove?: boolean } = {}): string {
  const parent = mkdtempSync(join(tmpdir(), "semctx-change-impact-"));
  parents.push(parent);
  const gitRoot = options.gitRootAbove === true ? join(parent, "top") : undefined;
  const root = join(gitRoot ?? parent, "fixture");
  mkdirSync(root, { recursive: true });
  cpSync(FIXTURE, root, { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  for (const [path, text] of Object.entries(extraFiles)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(gitRoot ?? root, "init", "-q", "-b", "main");
  git(gitRoot ?? root, "add", ".");
  git(gitRoot ?? root, "commit", "-q", "-m", "fixture");
  initWorkspace(root, createDefaultConfig(root));
  indexRepository(root, "2026-09-01T10:00:00.000Z");
  return root;
}

function replace(root: string, path: string, before: string, after: string): void {
  const file = join(root, path);
  const text = readFileSync(file, "utf8");
  if (!text.includes(before)) throw new Error(`fixture drifted: ${path}`);
  writeFileSync(file, text.replace(before, after));
}

const EDIT_CANONICAL = ["  const name = recorded.trim();", "  const name = recorded.trim().toLowerCase();"] as const;
const EDIT_KEYS = ['  "s2c.gameFightEnd",\n] as const;', '  "s2c.gameFightEnd",\n  "s2c.gameFightJoin",\n] as const;'] as const;

const tierIds = (targets: ChangeImpactReport["directlyAffected"]): string[] => (targets ?? []).map((target) => target.id).sort();
const allReached = (report: ChangeImpactReport): string[] => [
  ...tierIds(report.directlyAffected),
  ...tierIds(report.transitivelyAffected),
  ...tierIds(report.possiblyAffected),
];
const surface = (report: ChangeImpactReport, name: string) => report.surfaces?.find((entry) => entry.name === name);

function analyse(root: string, source: Parameters<typeof runChangeImpact>[1] = { kind: "working-tree" }): ChangeImpactReport {
  const report = runChangeImpact(root, source, { surfacesPath: join(root, "surfaces.json") });
  ChangeImpactReportSchema.parse(report);
  return report;
}

describe("runChangeImpact — a local replay change", () => {
  it("stays in its package without declaring the rest safe", () => {
    const root = repository();
    replace(root, PINS, ...EDIT_CANONICAL);
    const report = analyse(root);

    expect(report.analysis.binding).toMatchObject({ status: "bound", rangeSide: "old", breaks: [] });
    expect(report.analysis.confidence).toEqual({ level: "moderate", reasons: ["STATIC_REACH_CEILING"] });
    expect(report.changes.units!.map((unit) => [unit.kind, unit.id, unit.behavioral])).toEqual([["symbol", CANONICAL, true]]);
    expect(tierIds(report.directlyAffected)).toEqual([
      "sym:function:packages/protocol/scripts/diagnose-turn.ts:diagnoseTurn",
      "sym:function:packages/protocol/scripts/replay-fight.ts:replayFight",
      "test:packages/protocol/test/pins-check.ts",
    ]);
    // The live path only imports the file: a structural possibility, never a known impact.
    expect(tierIds(report.possiblyAffected)).toEqual(["mod:packages/decision/src/decide.ts", "mod:packages/runtime/src/live.ts"]);
    expect(allReached(report)).not.toContain(MATCHES_PIN);
    expect(report.blastRadius).toMatchObject({ scope: "package", complete: true, known: { packages: ["@demo/protocol"] } });
    expect(report.blastRadius.possible.packages).toEqual(["@demo/decision", "@demo/runtime"]);
    expect(surface(report, "replay")!.exposure).toBe("changed");
    expect(surface(report, "runtime-live")!.exposure).toBe("possible");
    expect(surface(report, "protocol")!.exposure).toBe("not_reached");
    expect(report.explicitlyUnaffected).toEqual([]);
    expect(report.analysis.limits.map((limit) => limit.code)).toContain("NO_NEGATIVE_EVIDENCE");
  });

  it("joins marker and authored claims at the exposure of their anchors", () => {
    const root = repository();
    replace(root, PINS, ...EDIT_CANONICAL);
    const report = analyse(root);
    const claims = Object.fromEntries(report.exposedClaims!.map((claim) => [claim.id, [claim.source, claim.exposure]]));
    expect(claims["inv:replay-never-feeds-live"]).toEqual(["marker", "changed"]);
    expect(claims["invariant.replay.analysis-only"]).toEqual(["semantic", "changed"]);
    // A `file:` link names the whole module: capped at possible, never "changed".
    expect(claims["invariant.protocol.module-reviewed"]).toEqual(["semantic", "possible"]);
    expect(claims["inv:live-pins-are-authoritative"]).toBeUndefined();
    expect(report.analysis.semanticLayer).toBe("joined");
    expect(report.unresolved).toContainEqual(expect.objectContaining({
      code: "SEMANTIC_INVARIANT_UNANCHORED",
      nodeId: "invariant.decision.deterministic",
      affects: "claims",
    }));
  });

  it("follows a private constant through its same-file readers", () => {
    const root = repository();
    replace(root, PINS, ...EDIT_KEYS);
    const report = analyse(root);
    expect(report.changes.units!.map((unit) => [unit.kind, unit.id, unit.exported])).toEqual([
      ["declaration", "decl:packages/protocol/src/pins.ts:REPLAY_SAFE_KEYS", false],
    ]);
    expect(tierIds(report.directlyAffected)).toEqual([IS_REPLAY_SAFE]);
    expect(tierIds(report.transitivelyAffected)).toContain(CANONICAL);
    expect(report.possiblyAffected).toEqual([]);
    expect(allReached(report)).not.toContain(MATCHES_PIN);
    expect(surface(report, "runtime-live")!.exposure).toBe("not_reached");
  });

  it("reports a comment-only change as non-behavioural", () => {
    const root = repository();
    replace(root, PINS, "/** Replay-only keys", "/** Replay-only (analysis) keys");
    const report = analyse(root);
    expect(report.changes.units!.every((unit) => !unit.behavioral)).toBe(true);
    expect(allReached(report)).toEqual([]);
    expect(report.blastRadius).toMatchObject({ scope: "local", rationale: ["NO_BEHAVIORAL_CHANGE"] });
  });

  it("anchors a marker claim as changed only when the edit reaches the marker", () => {
    const prose = repository();
    replace(prose, PINS, "Replay adapter: map a recorded", "Replay adapter: maps a recorded");
    const proseClaims = Object.fromEntries(analyse(prose).exposedClaims!.map((claim) => [claim.id, claim.exposure]));
    expect(proseClaims["inv:replay-never-feeds-live"]).toBe("possible");
    const marker = repository();
    replace(marker, PINS, "consumed by analysis tools only", "consumed by offline analysis tools only");
    const markerClaims = Object.fromEntries(analyse(marker).exposedClaims!.map((claim) => [claim.id, claim.exposure]));
    expect(markerClaims["inv:replay-never-feeds-live"]).toBe("changed");
  });

  it("reaches a module that uses the change only through a re-exporting barrel", () => {
    const root = repository({
      "packages/protocol/src/index.ts": 'export { canonicalReplayName, isReplaySafe } from "./pins";\n',
      "packages/runtime/src/replay-consumer.ts": [
        'import { canonicalReplayName } from "../../protocol/src/index";',
        "",
        "export function normalizeAll(names: string[]): (string | undefined)[] {",
        "  return names.map(canonicalReplayName);",
        "}",
        "",
      ].join("\n"),
    });
    replace(root, PINS, ...EDIT_CANONICAL);
    const report = analyse(root);
    const reasons = Object.fromEntries((report.possiblyAffected ?? []).map((target) => [target.id, target.reason]));
    expect(reasons["mod:packages/protocol/src/index.ts"]).toBe("REEXPORTS_CHANGED_FILE");
    expect(reasons["mod:packages/runtime/src/replay-consumer.ts"]).toBe("IMPORTS_REEXPORTER_OF_CHANGED_FILE");
  });
});

describe("runChangeImpact — sources and index coordinates", () => {
  it("binds a staged diff on the old side", () => {
    const root = repository();
    replace(root, PINS, ...EDIT_CANONICAL);
    git(root, "add", PINS);
    const report = analyse(root, { kind: "staged" });
    expect(report.analysis.binding).toMatchObject({ status: "bound", rangeSide: "old" });
    expect(report.changes.units!.map((unit) => unit.id)).toEqual([CANONICAL]);
  });

  it("binds a range on the new side when the index is at its head", () => {
    const root = repository();
    git(root, "checkout", "-q", "-b", "change");
    replace(root, PINS, ...EDIT_CANONICAL);
    git(root, "commit", "-q", "-am", "change");
    indexRepository(root, "2026-09-01T10:05:00.000Z");
    const report = analyse(root, { kind: "range", base: "main" });
    expect(report.subject).toMatchObject({ source: "range", base: "main", head: "HEAD" });
    expect(report.subject.mergeBaseOid).toBe(git(root, "rev-parse", "main"));
    expect(report.analysis.binding).toMatchObject({ status: "bound", rangeSide: "new" });
    expect(report.changes.units!.map((unit) => [unit.id, unit.side])).toEqual([[CANONICAL, "new"]]);
    expect(tierIds(report.directlyAffected)).toContain("sym:function:packages/protocol/scripts/replay-fight.ts:replayFight");
  });

  it("binds a working-tree diff on the new side of an index built on that dirty tree, and only while it is unchanged", () => {
    const root = repository();
    replace(root, PINS, ...EDIT_CANONICAL);
    indexRepository(root, "2026-09-01T10:05:00.000Z");
    const dirty = analyse(root);
    expect(dirty.analysis.binding).toMatchObject({ status: "bound", rangeSide: "new" });
    expect(dirty.changes.units!.map((unit) => [unit.id, unit.side])).toEqual([[CANONICAL, "new"]]);

    replace(root, PINS, ...EDIT_KEYS);
    const drifted = analyse(root);
    expect(drifted.analysis.binding.status).toBe("broken");
    expect(drifted.analysis.binding.breaks).toContain("INDEX_COORDINATES_NOT_ON_DIFF_SIDE");

    git(root, "add", PINS);
    const staged = analyse(root, { kind: "staged" });
    expect(staged.analysis.binding.breaks).toContain("INDEX_COORDINATES_NOT_ON_DIFF_SIDE");
    // Re-indexing cannot bind a staged diff while the index reads uncommitted files.
    expect(staged.unresolved[0]!.detail).toContain("commit or stash");
  });

  it("binds each file on the side its indexed coordinates are in", () => {
    const root = repository();
    // Dirty at indexing time: indexed as edited. Edited after indexing: indexed as committed.
    replace(root, PINS, "export function isReplaySafe(name: string): boolean {", "\nexport function isReplaySafe(name: string): boolean {");
    indexRepository(root, "2026-09-01T10:05:00.000Z");
    replace(root, "packages/runtime/src/live.ts", "matchesProtocolPin(build, name))", "matchesProtocolPin(build, name.trim()))");
    const report = analyse(root);
    expect(report.analysis.binding).toMatchObject({ status: "bound", rangeSide: "mixed" });
    const sides = Object.fromEntries(report.changes.units!.map((unit) => [unit.id, unit.side]));
    expect(sides["sym:function:packages/runtime/src/live.ts:runLiveFight"]).toBe("old");
    const pinsUnits = report.changes.units!.filter((unit) => unit.file === PINS);
    expect(pinsUnits.length).toBeGreaterThan(0);
    expect(pinsUnits.every((unit) => unit.side === "new")).toBe(true);
  });

  it("breaks a staged or range diff over an index that read uncommitted edges", () => {
    const removeCall = ["frames.filter((frame) => canonicalReplayName(frame) !== undefined).length", "frames.length"] as const;
    const staged = repository();
    replace(staged, "packages/protocol/scripts/replay-fight.ts", ...removeCall);
    indexRepository(staged, "2026-09-01T10:05:00.000Z");
    replace(staged, PINS, ...EDIT_CANONICAL);
    git(staged, "add", PINS);
    expect(analyse(staged, { kind: "staged" }).analysis.binding.breaks).toContain("INDEX_COORDINATES_NOT_ON_DIFF_SIDE");

    const range = repository();
    git(range, "checkout", "-q", "-b", "change");
    replace(range, PINS, ...EDIT_CANONICAL);
    git(range, "commit", "-q", "-am", "change");
    replace(range, "packages/protocol/scripts/replay-fight.ts", ...removeCall);
    indexRepository(range, "2026-09-01T10:05:00.000Z");
    expect(analyse(range, { kind: "range", base: "main" }).analysis.binding.breaks).toContain("INDEX_COORDINATES_NOT_ON_DIFF_SIDE");
  });

  it("breaks a staged or range diff over an index that missed a committed file", () => {
    // replay-fight.ts calls the changed function; it was missing from the worktree at indexing.
    const caller = "packages/protocol/scripts/replay-fight.ts";
    const range = repository();
    git(range, "checkout", "-q", "-b", "change");
    replace(range, PINS, ...EDIT_CANONICAL);
    git(range, "commit", "-q", "-am", "change");
    rmSync(join(range, caller));
    indexRepository(range, "2026-09-01T10:05:00.000Z");
    expect(analyse(range, { kind: "range", base: "main" }).analysis.binding.breaks).toContain("INDEX_COORDINATES_NOT_ON_DIFF_SIDE");

    const staged = repository();
    rmSync(join(staged, caller));
    indexRepository(staged, "2026-09-01T10:05:00.000Z");
    replace(staged, PINS, ...EDIT_CANONICAL);
    git(staged, "add", PINS);
    expect(analyse(staged, { kind: "staged" }).analysis.binding.breaks).toContain("INDEX_COORDINATES_NOT_ON_DIFF_SIDE");
  });

  it("lists the importers a file added on the new side takes over", () => {
    const names = {
      "packages/protocol/src/names/index.ts": "export const NAMES = [\"a\"];\n",
      "packages/protocol/src/use-names.ts": 'import { NAMES } from "./names";\n\nexport const count = NAMES.length;\n',
    };
    for (const text of ["", "function helper(): number {\n  return 1;\n}\n"]) {
      const root = repository(names);
      git(root, "checkout", "-q", "-b", "change");
      writeFileSync(join(root, "packages/protocol/src/names.ts"), text);
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "shadow");
      indexRepository(root, "2026-09-01T10:05:00.000Z");
      const report = analyse(root, { kind: "range", base: "main" });
      expect(report.analysis.binding.status).toBe("bound");
      expect(report.possiblyAffected!.find((target) => target.id === "mod:packages/protocol/src/use-names.ts")?.reason).toBe("IMPORTS_SHADOWED_MODULE");
      expect(report.unresolved.map((gap) => gap.code)).toContain("ADDED_PATH_MAY_SHADOW_MODULE");
    }
  });

  it("does not doubt an untracked file the binding proved unchanged since indexing", () => {
    const root = repository();
    writeFileSync(join(root, "packages/protocol/src/extra.ts"), "export const EXTRA = 1;\n");
    indexRepository(root, "2026-09-01T10:05:00.000Z");
    replace(root, PINS, ...EDIT_CANONICAL);
    const report = analyse(root);
    expect(report.analysis.binding.status).toBe("bound");
    expect(report.unresolved).toContainEqual(expect.objectContaining({ code: "UNTRACKED_PATH_NOT_DIFFED", file: "packages/protocol/src/extra.ts", affects: "none" }));
    expect(report.blastRadius.complete).toBe(true);
  });

  it("names the search bound instead of a missing side when too many local changes exist", () => {
    const root = repository();
    mkdirSync(join(root, "notes"));
    for (let note = 0; note < 13; note += 1) writeFileSync(join(root, `notes/n${note}.txt`), `${note}\n`);
    indexRepository(root, "2026-09-01T10:05:00.000Z");
    replace(root, PINS, ...EDIT_CANONICAL);
    expect(analyse(root).analysis.binding.breaks).toEqual(["DIRTY_INDEX_SEARCH_BOUND_EXCEEDED"]);
  });

  it("reads the module links of an indexed file Git does not track", () => {
    const root = repository({
      "packages/runtime/src/replay-consumer.ts": 'import { canonicalReplayName } from "../../protocol/src/index";\n\nexport const normalize = (names: string[]) => names.map(canonicalReplayName);\n',
    });
    writeFileSync(join(root, "packages/protocol/src/index.ts"), 'export { canonicalReplayName } from "./pins";\n');
    indexRepository(root, "2026-09-01T10:05:00.000Z");
    replace(root, PINS, ...EDIT_CANONICAL);
    const reasons = Object.fromEntries((analyse(root).possiblyAffected ?? []).map((target) => [target.id, target.reason]));
    expect(reasons["mod:packages/protocol/src/index.ts"]).toBe("REEXPORTS_CHANGED_FILE");
    expect(reasons["mod:packages/runtime/src/replay-consumer.ts"]).toBe("IMPORTS_REEXPORTER_OF_CHANGED_FILE");
  });

  it("finds re-exports from a subdirectory root whatever grep.fullName says", () => {
    const root = repository({ "packages/protocol/src/index.ts": 'export { canonicalReplayName } from "./pins";\n' }, { gitRootAbove: true });
    git(root, "config", "grep.fullName", "true");
    replace(root, PINS, ...EDIT_CANONICAL);
    const reasons = Object.fromEntries((analyse(root).possiblyAffected ?? []).map((target) => [target.id, target.reason]));
    expect(reasons["mod:packages/protocol/src/index.ts"]).toBe("REEXPORTS_CHANGED_FILE");
  });

  it("lists untracked paths without guessing their impact", () => {
    const root = repository();
    writeFileSync(join(root, "packages/protocol/src/extra.ts"), "export const EXTRA = 1;\n");
    const report = analyse(root);
    expect(report.changes.files).toContainEqual({ path: "packages/protocol/src/extra.ts", status: "untracked", hunks: 0 });
    expect(report.unresolved).toContainEqual(expect.objectContaining({ code: "UNTRACKED_PATH_NOT_DIFFED", file: "packages/protocol/src/extra.ts" }));
  });

  it("nulls every index-derived set when the index belongs to another commit", () => {
    const root = repository();
    replace(root, "README.md", "#", "# moved");
    git(root, "commit", "-q", "-am", "move head");
    replace(root, PINS, ...EDIT_CANONICAL);
    const report = analyse(root);
    expect(report.analysis.binding.status).toBe("broken");
    expect(report.analysis.binding.rangeSide).toBeNull();
    expect(report.analysis.binding.breaks).toContain("ANALYZED_COMMIT_MISMATCH");
    expect(report.analysis.confidence).toEqual({ level: "none", reasons: ["INDEX_BINDING_BROKEN"] });
    expect(report.analysis.semanticLayer).toBe("not_computed");
    expect(report.changes.units).toBeNull();
    expect(report.directlyAffected).toBeNull();
    expect(report.transitivelyAffected).toBeNull();
    expect(report.possiblyAffected).toBeNull();
    expect(report.exposedClaims).toBeNull();
    expect(report.changes.files.map((file) => file.path)).toEqual([PINS]);
    expect(report.surfaces!.every((entry) => entry.exposure === "unknown")).toBe(true);
    expect(report.blastRadius).toMatchObject({ scope: "unknown", complete: false });
  });

  it("refuses an invalid surface map instead of inferring surfaces", () => {
    const root = repository();
    writeFileSync(join(root, "bad-surfaces.json"), JSON.stringify({ schemaVersion: 1, surfaces: [{ name: "x", include: [] }] }));
    expect(() => runChangeImpact(root, { kind: "working-tree" }, { surfacesPath: join(root, "bad-surfaces.json") })).toThrow(/invalid surface map/);
    const bare = runChangeImpact(root, { kind: "working-tree" });
    expect(bare.surfaces).toBeNull();
    expect(bare.subject.inputs.surfaceMap).toBeNull();
  });

  it("emits no proof vocabulary", () => {
    const root = repository();
    replace(root, PINS, ...EDIT_CANONICAL);
    const report = analyse(root);
    const text = JSON.stringify(report);
    for (const forbidden of ['"PASS"', '"WARN"', '"BLOCK"', "recommendedTests", "mustPass", '"P0"', '"P1"', '"P2"', '"P3"', '"P4"', '"P5"', "ALLOW"]) {
      expect(text).not.toContain(forbidden);
    }
    // The only `verdict` is the index freshness state the binding read, never a proof decision.
    const keys: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) value.forEach((item) => walk(item, path));
      else if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          keys.push(`${path}.${key}`);
          walk(child, `${path}.${key}`);
        }
      }
    };
    walk(report, "");
    expect(keys.filter((key) => /verdict|decision|gate|proof|required|mandatory|obligation|allow|block/i.test(key))).toEqual([".analysis.binding.freshness.verdict"]);
  });

  it("never reads as complete or moderate when a gap stops the reach", () => {
    const root = repository();
    // A top-level call: every importer of pins.ts now runs it, and the reach beyond them is not modeled.
    writeFileSync(join(root, PINS), `${readFileSync(join(root, PINS), "utf8")}console.log("pins loaded");\n`);
    const report = analyse(root);
    expect(report.analysis.binding.status).toBe("bound");
    expect(report.analysis.confidence.level).toBe("low");
    expect(report.analysis.confidence.reasons).toContain("REVERSE_REACH_NOT_MODELED");
    expect(report.blastRadius).toMatchObject({ scope: "unknown", complete: false });
    // No modeled path reaches the scoring surface, but on an incomplete reach that is unknown, not "not reached".
    expect(surface(report, "scoring-weights")?.exposure).toBe("unknown");
    expect(report.surfaces!.map((entry) => entry.exposure)).not.toContain("not_reached");
  });

  it("breaks when the worktree or the index changes during the analysis", () => {
    const root = repository();
    replace(root, PINS, ...EDIT_CANONICAL);
    const late = join(root, "packages/protocol/src/late.ts");
    __setVerifyControlBarrierForTesting(() => writeFileSync(late, "export const LATE = 1;\n"));
    const worktree = analyse(root);
    expect(worktree.analysis.binding.breaks).toContain("WORKING_TREE_CHANGED_DURING_ANALYSIS");
    expect(worktree.directlyAffected).toBeNull();
    rmSync(late);

    __setVerifyControlBarrierForTesting(() => {
      const writer = openStore(root);
      try {
        const snapshot = JSON.parse(writer.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY)!) as { capturedAt: string };
        writer.setMeta(CONTROL_INDEX_SNAPSHOT_META_KEY, JSON.stringify({ ...snapshot, capturedAt: "2026-09-01T10:09:00.000Z" }));
      } finally {
        writer.close();
      }
    });
    const index = analyse(root);
    expect(index.analysis.binding.breaks).toContain("INDEX_CHANGED_DURING_ANALYSIS");
    expect(index.directlyAffected).toBeNull();
  });
});
