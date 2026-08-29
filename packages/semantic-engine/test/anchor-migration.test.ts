/**
 * The migration rewrites authored intent, so its refusals matter more than its rewrites.
 *
 * Each case pins one of four properties: it never acts on an index that cannot speak for the tree,
 * it never guesses, it never leaves the run half-written, and what it does write is a minimal diff
 * a maintainer can read. Every atomicity assertion compares file bytes before and after, not call
 * counts — a mock that "was not called" proves nothing about what landed on disk.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryGraph, RepositoryNode } from "@semantic-context/core";
import {
  NODE_ANCHOR_MIGRATION_FILE_SYSTEM,
  authorized,
  migrateAnchors,
  recoverAnchorMigration,
  refusedAuthority,
  type AnchorMigrationFileSystem,
  type RepositoryFacts,
} from "@semantic-context/semantic-engine";

const roots: string[] = [];

function symbol(id: string, name: string, kind: RepositoryNode["kind"], filePath: string): RepositoryNode {
  return { id, kind, name, filePath, evidence: [], tags: [], metadata: {} };
}

function facts(...nodes: RepositoryNode[]): RepositoryFacts {
  const graph: RepositoryGraph = { nodes, edges: [] };
  return { graph, claims: [], evidence: [] };
}

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-anchor-migration-"));
  roots.push(root);
  const dir = join(root, ".semctx", "semantic");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, "utf8");
  return root;
}

function semanticPath(root: string, name: string): string {
  return join(root, ".semctx", "semantic", name);
}

function read(root: string, name: string): string {
  return readFileSync(semanticPath(root, name), "utf8");
}

function entries(root: string): string[] {
  return readdirSync(join(root, ".semctx", "semantic")).sort();
}

const RUN = symbol("sym:function:src/a.ts:run", "run", "function", "src/a.ts");
const READ = symbol("sym:function:src/a.ts:read", "read", "function", "src/a.ts");
const WRITE = symbol("sym:function:src/a.ts:write", "write", "function", "src/a.ts");

function invariantFile(id: string, refs: string[]): string {
  return [
    "# A comment the author wrote and expects to keep.",
    `invariant ${id}`,
    "  statement: something must hold",
    "  status: declared",
    ...refs.map((ref) => `  link: ${ref}`),
    "",
  ].join("\n");
}

/**
 * One immutable generation, named once. `factsIdentity` has to equal `generation.facts` or the run
 * is refused before it plans — which is the point: nothing here can be "authorized" in the abstract.
 */
const GENERATION = { snapshot: "snapshot-alpha", facts: "facts-alpha" } as const;
const NEXT_GENERATION = { snapshot: "snapshot-beta", facts: "facts-beta" } as const;

const OK = {
  apply: true,
  authority: authorized(GENERATION),
  factsIdentity: GENERATION.facts,
} as const;

function activeDir(root: string): string {
  return join(root, ".semctx", "working", "anchor-migration-v1", "active");
}

function tombstoneDir(root: string): string {
  return join(root, ".semctx", "working", "anchor-migration-v1", "cleanup");
}

function recoveryActiveDir(root: string): string {
  return join(root, ".semctx", "working", "anchor-migration-v1", "recovery-active");
}

function crashMigration(root: string, point: string, nodes: readonly RepositoryNode[] = [RUN, READ]): number {
  const source = `
    import { migrateAnchors, authorized } from "./packages/semantic-engine/src/index.ts";
    const root = process.argv[1];
    const nodes = JSON.parse(process.argv[2]);
    migrateAnchors(root, { graph: { nodes, edges: [] }, claims: [], evidence: [] }, {
      apply: true,
      authority: authorized({ snapshot: "snapshot-alpha", facts: "facts-alpha" }),
      factsIdentity: "facts-alpha",
    });
  `;
  const child = Bun.spawnSync([process.execPath, "-e", source, root, JSON.stringify(nodes)], {
    cwd: process.cwd(),
    env: { ...process.env, SEMCTX_ANCHOR_MIGRATION_CRASH_AT: point },
    stdout: "pipe",
    stderr: "pipe",
  });
  return child.exitCode;
}

function crashRecovery(root: string, point: string): number {
  const source = `
    import { recoverAnchorMigration } from "./packages/semantic-engine/src/index.ts";
    recoverAnchorMigration(process.argv[1]);
  `;
  return Bun.spawnSync([process.execPath, "-e", source, root], {
    cwd: process.cwd(),
    env: { ...process.env, SEMCTX_ANCHOR_MIGRATION_CRASH_AT: point },
    stdout: "pipe",
    stderr: "pipe",
  }).exitCode;
}

function rewritePreparedPath(root: string, relPath: string): void {
  const journal = join(activeDir(root), "journal.ndjson");
  const records = readFileSync(journal, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const prepared = records.find((record) => record.state === "PREPARED");
  prepared.entries[0].relPath = relPath;
  writeFileSync(journal, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      for (const name of entries(root)) chmodSync(semanticPath(root, name), 0o600);
    } catch {
      // The root may already be gone, or never have had a semantic directory.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("nominal rewrite", () => {
  it("rewrites a legacy anchor to its canonical form and reports it", () => {
    const root = repository({
      "invariant.sem": invariantFile("invariant.one", ["sym:function:src/a.ts:run:42"]),
    });

    const report = migrateAnchors(root, facts(RUN), OK);

    expect(report.applied).toBe(true);
    expect(report.counts.rewritten).toBe(1);
    expect(read(root, "invariant.sem")).toContain("  link: sym:function:src/a.ts:run\n");
    // The comment the author wrote survives untouched — the migration is textual, not a re-parse.
    expect(read(root, "invariant.sem")).toContain("# A comment the author wrote and expects to keep.");
  });
});

describe("byte preservation — mixed line endings", () => {
  /** One CRLF line, one LF line, and the anchor to migrate — deliberately in that order. */
  function mixedEndings(ref: string): string {
    return [
      "# A comment terminated with CRLF.\r\n",
      "invariant invariant.one\n",
      "  statement: something must hold\r\n",
      "  status: declared\n",
      `  link: ${ref}\r\n`,
      "  note: trailing line with no terminator at all",
    ].join("");
  }

  it("rewrites the anchor and changes no other byte of a file mixing LF and CRLF", () => {
    const root = repository({ "invariant.sem": mixedEndings("sym:function:src/a.ts:run:42") });
    const before = read(root, "invariant.sem");

    const report = migrateAnchors(root, facts(RUN), OK);

    expect(report.counts.rewritten).toBe(1);
    // The whole file, byte for byte, with exactly the anchor substituted. A normalized terminator or
    // an added final newline fails here.
    expect(read(root, "invariant.sem")).toBe(
      before.replace("sym:function:src/a.ts:run:42", "sym:function:src/a.ts:run"),
    );
  });

  it("leaves a mixed-ending file byte-identical when the run refuses", () => {
    const root = repository({ "invariant.sem": mixedEndings("sym:function:src/a.ts:missing:9") });
    const before = read(root, "invariant.sem");

    const report = migrateAnchors(root, facts(RUN), OK);

    expect(report.hasRefusals).toBe(true);
    expect(read(root, "invariant.sem")).toBe(before);
  });

  it("does not add a final newline to a file that never had one", () => {
    const root = repository({
      "invariant.sem": `invariant invariant.one\n  link: sym:function:src/a.ts:run:42`,
    });

    migrateAnchors(root, facts(RUN), OK);

    expect(read(root, "invariant.sem")).toBe(`invariant invariant.one\n  link: sym:function:src/a.ts:run`);
  });
});

/**
 * The plan is computed from bytes read at planning time. Replacing a file that changed since would
 * discard an edit nobody reviewed — the one class of damage this command cannot apologise for.
 */
describe("preimage — immutable facts and seal", () => {
  it("refuses to replace a file edited after it was planned, and writes nothing anywhere", () => {
    const root = repository({
      "a.sem": invariantFile("invariant.a", ["sym:function:src/a.ts:run:42"]),
      "b.sem": invariantFile("invariant.b", ["sym:function:src/a.ts:read:7"]),
    });
    const concurrent = `${read(root, "b.sem")}\n# edited by someone else while the plan was computed\n`;

    let threw: unknown;
    try {
      migrateAnchors(root, facts(RUN, READ), {
        apply: true,
        authority: authorized(GENERATION),
        factsIdentity: GENERATION.facts,
        revalidateAuthority: () => {
          writeFileSync(semanticPath(root, "b.sem"), concurrent, "utf8");
          return authorized(GENERATION);
        },
      });
    } catch (error) {
      threw = error;
    }

    expect(threw).toBeDefined();
    expect(read(root, "b.sem")).toBe(concurrent);
    // The file that did not change was not migrated either: the run is atomic.
    expect(read(root, "a.sem")).toContain("  link: sym:function:src/a.ts:run:42");
    expect(entries(root)).toEqual(["a.sem", "b.sem"]);
  });

  it("never rolls back identical after-bytes committed by a concurrent writer", () => {
    const before = invariantFile("invariant.race", ["sym:function:src/a.ts:run:42"]);
    const concurrent = invariantFile("invariant.race", [RUN.id]);
    const root = repository({ "race.sem": before });

    expect(() => migrateAnchors(root, facts(RUN), {
      ...OK,
      revalidateAuthority: () => {
        writeFileSync(semanticPath(root, "race.sem"), concurrent, "utf8");
        return authorized(GENERATION);
      },
    })).toThrow(/changed preimages/);

    expect(read(root, "race.sem")).toBe(concurrent);
    expect(existsSync(activeDir(root))).toBe(false);
  });
});

describe("generation binding — a re-index between planning and writing", () => {
  it("writes nothing when the index is rebuilt between planning and writing", () => {
    const root = repository({
      "invariant.sem": invariantFile("invariant.one", ["sym:function:src/a.ts:run:42"]),
    });
    const before = read(root, "invariant.sem");

    const report = migrateAnchors(root, facts(RUN), {
      ...OK,
      // A perfectly healthy verdict — for a different generation. Nothing about its status says so.
      revalidateAuthority: () => authorized(NEXT_GENERATION),
    });

    expect(report.applied).toBe(false);
    expect(report.authority.status).toBe("refused");
    expect(report.authority.reasons).toEqual(["INDEX_GENERATION_DRIFTED"]);
    expect(report.counts.filesChanged).toBe(0);
    expect(read(root, "invariant.sem")).toBe(before);
    expect(entries(root)).toEqual(["invariant.sem"]);
  });

  it("refuses before planning when the facts are not the ones the verdict names", () => {
    const root = repository({
      "invariant.sem": invariantFile("invariant.one", ["sym:function:src/a.ts:run:42"]),
    });
    const before = read(root, "invariant.sem");

    const report = migrateAnchors(root, facts(RUN), {
      apply: true,
      authority: authorized(GENERATION),
      factsIdentity: NEXT_GENERATION.facts,
    });

    expect(report.authority.reasons).toEqual(["INDEX_GENERATION_DRIFTED"]);
    // Not even a plan: an outcome list derived from unvouched facts reads exactly like a sound one.
    expect(report.files).toEqual([]);
    expect(read(root, "invariant.sem")).toBe(before);
  });
});

describe("index authority", () => {
  const STALE = refusedAuthority(["INDEX_STALE"]);

  it("refuses a dry run against an index that cannot speak for the tree", () => {
    const root = repository({
      "invariant.sem": invariantFile("invariant.one", ["sym:function:src/a.ts:run:42"]),
    });

    const report = migrateAnchors(root, facts(RUN), { apply: false, authority: STALE });

    expect(report.authority.status).toBe("refused");
    expect(report.authority.reasons).toEqual(["INDEX_STALE"]);
    expect(report.files).toEqual([]);
  });
});

describe("refusal quarantines the whole run", () => {
  it("refuses an ambiguous anchor and rewrites nothing in its file", () => {
    const nested = symbol("sym:function:src/a.ts:outer.run", "run", "function", "src/a.ts");
    const root = repository({
      "invariant.sem": invariantFile("invariant.one", [
        "sym:function:src/a.ts:run:42",
        "sym:function:src/a.ts:read:7",
      ]),
    });
    const before = read(root, "invariant.sem");

    const report = migrateAnchors(root, facts(RUN, nested, READ), OK);

    expect(report.hasRefusals).toBe(true);
    expect(report.counts.refused).toBe(1);
    const refusal = report.files[0]?.outcomes.find((outcome) => outcome.status === "refused");
    expect(refusal).toMatchObject({ reasonCode: "ambiguous" });
    // The load-bearing assertion: the *migratable* sibling anchor on the next line was not written
    // either. A partially migrated file would hide the refusal inside a diff that looks done.
    expect(read(root, "invariant.sem")).toBe(before);
    expect(report.files[0]?.changed).toBe(false);
  });

  it("writes nothing anywhere in the run when any file is refused", () => {
    const nested = symbol("sym:function:src/a.ts:outer.run", "run", "function", "src/a.ts");
    const root = repository({
      "a-clean.sem": invariantFile("invariant.clean", ["sym:function:src/a.ts:read:7"]),
      "b-refused.sem": invariantFile("invariant.refused", ["sym:function:src/a.ts:run:42"]),
    });
    const cleanBefore = read(root, "a-clean.sem");
    const refusedBefore = read(root, "b-refused.sem");

    const report = migrateAnchors(root, facts(RUN, nested, READ), OK);

    expect(report.hasRefusals).toBe(true);
    expect(report.applied).toBe(false);
    expect(read(root, "a-clean.sem")).toBe(cleanBefore);
    expect(read(root, "b-refused.sem")).toBe(refusedBefore);
    expect(report.files.every((file) => !file.changed)).toBe(true);
    expect(entries(root)).toEqual(["a-clean.sem", "b-refused.sem"]);
  });
});

/**
 * The three moments this command could damage authored files: a temporary name that collides, a
 * staging error part-way through, and a rename that fails after other renames already landed. None
 * can be provoked reliably through the real filesystem, so these drive the file-system port instead
 * and assert on file bytes rather than on call counts.
 */
describe("atomicity under injected faults — écriture entre planification et validation", () => {
  function faulty(overrides: Partial<AnchorMigrationFileSystem>): AnchorMigrationFileSystem {
    return { ...NODE_ANCHOR_MIGRATION_FILE_SYSTEM, ...overrides };
  }

  function twoFiles(): string {
    return repository({
      "a-first.sem": invariantFile("invariant.a", ["sym:function:src/a.ts:run:42"]),
      "b-second.sem": invariantFile("invariant.b", ["sym:function:src/a.ts:read:7"]),
    });
  }

  const reported = (name: string): string => `.semctx/semantic/${name}`;

  it("leaves nothing behind when a staging write fails part-way through the run", () => {
    const root = twoFiles();
    const first = read(root, "a-first.sem");
    const second = read(root, "b-second.sem");
    let writes = 0;

    expect(() => migrateAnchors(root, facts(RUN, READ), {
      ...OK,
      fileSystem: faulty({
        fillAndClose: (handle, path, content) => {
          writes += 1;
          if (writes > 1) {
            closeSync(handle);
            rmSync(path, { force: true });
            throw new Error("ENOSPC: no space left on device");
          }
          NODE_ANCHOR_MIGRATION_FILE_SYSTEM.fillAndClose(handle, path, content);
        },
      }),
    })).toThrow(/rolled back/);

    expect(read(root, "a-first.sem")).toBe(first);
    expect(read(root, "b-second.sem")).toBe(second);
    expect(entries(root)).toEqual(["a-first.sem", "b-second.sem"]);
  });

  it("restores the file it already replaced when the second rename fails", () => {
    const root = twoFiles();
    const first = read(root, "a-first.sem");
    const second = read(root, "b-second.sem");
    let renames = 0;

    expect(() => migrateAnchors(root, facts(RUN, READ), {
      ...OK,
      fileSystem: faulty({
        rename: (from, to) => {
          renames += 1;
          // The first rename genuinely lands, so the rollback below has real work to do.
          if (renames > 1) throw new Error("EPERM: operation not permitted");
          NODE_ANCHOR_MIGRATION_FILE_SYSTEM.rename(from, to);
        },
      }),
    })).toThrow(/rolled back/);

    expect(renames).toBe(2);
    expect(read(root, "a-first.sem")).toBe(first);
    expect(read(root, "b-second.sem")).toBe(second);
    expect(entries(root)).toEqual(["a-first.sem", "b-second.sem"]);
  });

  it("uses the durable recovery path rather than an in-place write when rollback is required", () => {
    const root = twoFiles();
    const first = read(root, "a-first.sem");
    const second = read(root, "b-second.sem");
    let renames = 0;

    try {
      migrateAnchors(root, facts(RUN, READ), {
        ...OK,
        fileSystem: faulty({
          rename: (from, to) => {
            renames += 1;
            if (renames > 1) throw new Error("EPERM: operation not permitted");
            NODE_ANCHOR_MIGRATION_FILE_SYSTEM.rename(from, to);
          },
          writeFile: () => {
            throw new Error("EROFS: read-only file system");
          },
        }),
      });
      throw new Error("expected the run to fail");
    } catch (error) {
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      expect(details["restored"]).toEqual([reported("a-first.sem")]);
      expect(details["restoreFailures"]).toBeUndefined();
    }
    expect(read(root, "a-first.sem")).toBe(first);
    expect(read(root, "b-second.sem")).toBe(second);
  });

  it("removes the partial temporary when the write into it fails", () => {
    const root = repository({
      "invariant.sem": invariantFile("invariant.one", ["sym:function:src/a.ts:run:42"]),
    });
    const path = semanticPath(root, "invariant.sem.partial.tmp");
    const handle = NODE_ANCHOR_MIGRATION_FILE_SYSTEM.claimExclusive(path);
    closeSync(handle);
    expect(existsSync(path)).toBe(true);

    expect(() => NODE_ANCHOR_MIGRATION_FILE_SYSTEM.fillAndClose(handle, path, "PARTIAL")).toThrow();

    expect(existsSync(path)).toBe(false);
    expect(entries(root)).toEqual(["invariant.sem"]);
  });
});

describe("grammar-complete byte locator", () => {
  it("rewrites scalar, block-list and inline-list links without normalizing mixed LF/CRLF", () => {
    const source = [
      "invariant invariant.one\r\n",
      "  statement: mixed forms\n",
      "  link: sym:function:src/a.ts:run:42\r\n",
      "  link:\n",
      "    - sym:function:src/a.ts:read:7\r\n",
      "  link: [sym:function:src/a.ts:write:9, other:https://example.test/x]\n",
    ].join("");
    const root = repository({ "forms.sem": source });

    const report = migrateAnchors(root, facts(RUN, READ, WRITE), OK);

    expect(report.counts.rewritten).toBe(3);
    expect(readFileSync(semanticPath(root, "forms.sem"))).toEqual(Buffer.from(source
      .replace("sym:function:src/a.ts:run:42", RUN.id)
      .replace("sym:function:src/a.ts:read:7", READ.id)
      .replace("sym:function:src/a.ts:write:9", WRITE.id)));
  });

  it("preserves a UTF-8 BOM while rewriting scalar, block-list, and inline-list byte offsets", () => {
    const body = [
      "invariant invariant.bom\r\n",
      "  statement: mixed forms\n",
      "  link: sym:function:src/a.ts:run:42\r\n",
      "  link:\n",
      "    - sym:function:src/a.ts:read:7\r\n",
      "  link: [sym:function:src/a.ts:write:9, other:https://example.test/x]",
    ].join("");
    const source = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]);
    const root = repository({ "bom.sem": body });
    writeFileSync(semanticPath(root, "bom.sem"), source);

    const report = migrateAnchors(root, facts(RUN, READ, WRITE), OK);

    expect(report.counts.rewritten).toBe(3);
    expect(readFileSync(semanticPath(root, "bom.sem"))).toEqual(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(body
        .replace("sym:function:src/a.ts:run:42", RUN.id)
        .replace("sym:function:src/a.ts:read:7", READ.id)
        .replace("sym:function:src/a.ts:write:9", WRITE.id)),
    ]));
  });

  it("refuses invalid UTF-8 before producing a plan", () => {
    const root = repository({ "invalid.sem": "invariant invariant.invalid\n  statement: x\n" });
    writeFileSync(semanticPath(root, "invalid.sem"), Buffer.from([0x69, 0x6e, 0x76, 0x61, 0x6c, 0x69, 0x64, 0xff]));

    expect(() => migrateAnchors(root, facts(RUN), OK)).toThrow(/invalid UTF-8/);
    expect(readFileSync(semanticPath(root, "invalid.sem"))).toEqual(Buffer.from([0x69, 0x6e, 0x76, 0x61, 0x6c, 0x69, 0x64, 0xff]));
  });

  it("globally refuses when parser and locator disagree", () => {
    const root = repository({
      "mismatch.sem": "not-a-kind x\n  link: sym:function:src/a.ts:run:42\n",
      "clean.sem": invariantFile("invariant.clean", ["sym:function:src/a.ts:read:7"]),
    });
    const clean = read(root, "clean.sem");

    const report = migrateAnchors(root, facts(RUN, READ), OK);

    expect(report.hasRefusals).toBe(true);
    expect(report.files.flatMap((file) => file.outcomes)).toContainEqual(expect.objectContaining({
      reasonCode: "LINK_SYNTAX_UNREWRITABLE",
    }));
    expect(read(root, "clean.sem")).toBe(clean);
  });
});

describe("persistent crash recovery", () => {
  function twoCrashFiles(): { root: string; beforeA: Buffer; beforeB: Buffer } {
    const root = repository({
      "a.sem": invariantFile("invariant.a", ["sym:function:src/a.ts:run:42"]),
      "b.sem": invariantFile("invariant.b", ["sym:function:src/a.ts:read:7"]),
    });
    return {
      root,
      beforeA: readFileSync(semanticPath(root, "a.sem")),
      beforeB: readFileSync(semanticPath(root, "b.sem")),
    };
  }

  it("rolls back byte-exactly after the first durable replacement; a second recovery is a no-op", () => {
    const { root, beforeA, beforeB } = twoCrashFiles();
    expect(crashMigration(root, "after-first-replace")).toBe(86);
    expect(existsSync(activeDir(root))).toBe(true);

    migrateAnchors(root, facts(RUN, READ), { ...OK, apply: false });
    expect(readFileSync(semanticPath(root, "a.sem")).equals(beforeA)).toBe(true);
    expect(readFileSync(semanticPath(root, "b.sem")).equals(beforeB)).toBe(true);
    expect(existsSync(activeDir(root))).toBe(false);

    migrateAnchors(root, facts(RUN, READ), { ...OK, apply: false });
    expect(readFileSync(semanticPath(root, "a.sem")).equals(beforeA)).toBe(true);
    expect(readFileSync(semanticPath(root, "b.sem")).equals(beforeB)).toBe(true);
  });

  it("rolls back when every target was replaced but COMMITTED was not durable", () => {
    const { root, beforeA, beforeB } = twoCrashFiles();
    expect(crashMigration(root, "after-all-replaces")).toBe(86);

    migrateAnchors(root, facts(RUN, READ), { ...OK, apply: false });
    expect(readFileSync(semanticPath(root, "a.sem")).equals(beforeA)).toBe(true);
    expect(readFileSync(semanticPath(root, "b.sem")).equals(beforeB)).toBe(true);
  });

  it("keeps after-bytes and only cleans up after COMMITTED", () => {
    const { root, beforeA } = twoCrashFiles();
    expect(crashMigration(root, "after-commit")).toBe(86);
    expect(readFileSync(semanticPath(root, "a.sem")).equals(beforeA)).toBe(false);

    migrateAnchors(root, facts(RUN, READ), { ...OK, apply: false });
    expect(read(root, "a.sem")).toContain(RUN.id);
    expect(read(root, "b.sem")).toContain(READ.id);
    expect(existsSync(activeDir(root))).toBe(false);
  });

  it("finishes COMMITTED cleanup after a crash between active-to-tombstone rename and deletion", () => {
    const { root, beforeA } = twoCrashFiles();
    expect(crashMigration(root, "after-commit")).toBe(86);
    expect(crashRecovery(root, "after-cleanup-rename")).toBe(86);
    expect(existsSync(activeDir(root))).toBe(false);
    expect(existsSync(tombstoneDir(root))).toBe(true);

    recoverAnchorMigration(root);

    expect(existsSync(tombstoneDir(root))).toBe(false);
    expect(readFileSync(semanticPath(root, "a.sem")).equals(beforeA)).toBe(false);
    expect(read(root, "a.sem")).toContain(RUN.id);
  });

  for (const point of ["after-rollback-started", "after-restore", "after-restored", "after-rolled-back"] as const) {
    it(`resumes idempotently after a second crash at ${point}`, () => {
      const { root, beforeA, beforeB } = twoCrashFiles();
      expect(crashMigration(root, "after-first-replace")).toBe(86);
      expect(crashRecovery(root, point)).toBe(86);

      recoverAnchorMigration(root);

      expect(readFileSync(semanticPath(root, "a.sem")).equals(beforeA)).toBe(true);
      expect(readFileSync(semanticPath(root, "b.sem")).equals(beforeB)).toBe(true);
      expect(existsSync(activeDir(root))).toBe(false);
      expect(existsSync(tombstoneDir(root))).toBe(false);
    });
  }

  for (const point of ["after-rollback-started", "after-restore", "after-restored", "after-rolled-back"] as const) {
    it(`repairs a torn journal tail before a second recovery crash at ${point}`, () => {
      const { root, beforeA, beforeB } = twoCrashFiles();
      expect(crashMigration(root, "after-first-replace")).toBe(86);
      const journal = join(activeDir(root), "journal.ndjson");
      appendFileSync(journal, '{"state":"ROLLBACK_STARTED"');

      expect(crashRecovery(root, point)).toBe(86);
      expect(readFileSync(journal).at(-1)).toBe(0x0a);

      recoverAnchorMigration(root);

      expect(readFileSync(semanticPath(root, "a.sem")).equals(beforeA)).toBe(true);
      expect(readFileSync(semanticPath(root, "b.sem")).equals(beforeB)).toBe(true);
      expect(existsSync(activeDir(root))).toBe(false);
      expect(existsSync(tombstoneDir(root))).toBe(false);

      expect(recoverAnchorMigration(root)).toEqual([]);
      expect(readFileSync(semanticPath(root, "a.sem")).equals(beforeA)).toBe(true);
      expect(readFileSync(semanticPath(root, "b.sem")).equals(beforeB)).toBe(true);
    });
  }

  it("ignores a truncated final journal line and recovers from the last complete state", () => {
    const { root, beforeA, beforeB } = twoCrashFiles();
    expect(crashMigration(root, "after-first-replace")).toBe(86);
    appendFileSync(join(activeDir(root), "journal.ndjson"), '{"state":"REPLACED"');

    migrateAnchors(root, facts(RUN, READ), { ...OK, apply: false });
    expect(readFileSync(semanticPath(root, "a.sem")).equals(beforeA)).toBe(true);
    expect(readFileSync(semanticPath(root, "b.sem")).equals(beforeB)).toBe(true);
  });

  it("fails closed on corruption in the middle of the journal", () => {
    const { root } = twoCrashFiles();
    expect(crashMigration(root, "after-first-replace")).toBe(86);
    const journal = join(activeDir(root), "journal.ndjson");
    const lines = readFileSync(journal, "utf8").trimEnd().split("\n");
    lines.splice(2, 0, "not-json");
    writeFileSync(journal, `${lines.join("\n")}\n`, "utf8");
    const migratedA = readFileSync(semanticPath(root, "a.sem"));

    expect(() => migrateAnchors(root, facts(RUN, READ), { ...OK, apply: false })).toThrow(/journal is corrupt/);
    expect(readFileSync(semanticPath(root, "a.sem")).equals(migratedA)).toBe(true);
    expect(existsSync(activeDir(root))).toBe(true);
  });

  it("fails closed on a third target hash before restoring any sibling", () => {
    const { root } = twoCrashFiles();
    expect(crashMigration(root, "after-first-replace")).toBe(86);
    const migratedA = readFileSync(semanticPath(root, "a.sem"));
    writeFileSync(semanticPath(root, "b.sem"), "third-state", "utf8");

    expect(() => migrateAnchors(root, facts(RUN, READ), { ...OK, apply: false })).toThrow(/third hash/);
    expect(readFileSync(semanticPath(root, "a.sem")).equals(migratedA)).toBe(true);
    expect(existsSync(activeDir(root))).toBe(true);
  });

  it("fails closed when a referenced blob is absent", () => {
    const { root } = twoCrashFiles();
    expect(crashMigration(root, "after-first-replace")).toBe(86);
    const records = readFileSync(join(activeDir(root), "journal.ndjson"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const prepared = records.find((record) => record.state === "PREPARED");
    const digest = prepared.entries[0].beforeHash as string;
    unlinkSync(join(activeDir(root), "blobs", digest));

    expect(() => migrateAnchors(root, facts(RUN, READ), { ...OK, apply: false })).toThrow(/blob is missing/);
    expect(existsSync(activeDir(root))).toBe(true);
  });

  for (const relPath of [
    "src/victim.sem",
    ".semctx/semantic/../victim.sem",
    ".semctx\\semantic\\victim.sem",
    "C:/victim.sem",
  ]) {
    it(`rejects hostile journal target ${relPath} before any authored write`, () => {
      const { root } = twoCrashFiles();
      expect(crashMigration(root, "after-first-replace")).toBe(86);
      const beforeA = readFileSync(semanticPath(root, "a.sem"));
      const beforeB = readFileSync(semanticPath(root, "b.sem"));
      rewritePreparedPath(root, relPath);

      expect(() => recoverAnchorMigration(root)).toThrow(/journal is corrupt|unsafe target/);
      expect(readFileSync(semanticPath(root, "a.sem"))).toEqual(beforeA);
      expect(readFileSync(semanticPath(root, "b.sem"))).toEqual(beforeB);
    });
  }

  it("rejects a canonical journal path whose real parent escapes through a directory reparse", () => {
    const { root } = twoCrashFiles();
    expect(crashMigration(root, "after-first-replace")).toBe(86);
    const outside = mkdtempSync(join(tmpdir(), "semctx-anchor-outside-"));
    roots.push(outside);
    const victim = join(outside, "victim.sem");
    writeFileSync(victim, "outside-authored-bytes", "utf8");
    symlinkSync(outside, semanticPath(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    rewritePreparedPath(root, ".semctx/semantic/escape/victim.sem");

    expect(() => recoverAnchorMigration(root)).toThrow(/unsafe target/);
    expect(readFileSync(victim, "utf8")).toBe("outside-authored-bytes");
  });

  it.skipIf(process.platform === "win32")("preserves mode 0644 on commit and rollback", () => {
    const committed = repository({ "x.sem": invariantFile("invariant.x", ["sym:function:src/a.ts:run:42"]) });
    chmodSync(semanticPath(committed, "x.sem"), 0o644);
    migrateAnchors(committed, facts(RUN), OK);
    expect(statSync(semanticPath(committed, "x.sem")).mode & 0o777).toBe(0o644);

    const rolled = repository({ "x.sem": invariantFile("invariant.x", ["sym:function:src/a.ts:run:42"]) });
    chmodSync(semanticPath(rolled, "x.sem"), 0o644);
    expect(crashMigration(rolled, "after-first-replace", [RUN])).toBe(86);
    migrateAnchors(rolled, facts(RUN), { ...OK, apply: false });
    expect(statSync(semanticPath(rolled, "x.sem")).mode & 0o777).toBe(0o644);
  });
});

describe("exclusive transaction ownership and durability faults", () => {
  it("allows only one real subprocess to acquire the active transaction", async () => {
    const root = repository({
      "race.sem": invariantFile("invariant.race", ["sym:function:src/a.ts:run:42"]),
    });
    const start = join(root, "start-race");
    const source = `
      import { existsSync } from "node:fs";
      import { migrateAnchors, authorized } from "./packages/semantic-engine/src/index.ts";
      const root = process.argv[1];
      const start = process.argv[2];
      while (!existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      const node = { id: "sym:function:src/a.ts:run", kind: "function", name: "run", filePath: "src/a.ts", evidence: [], tags: [], metadata: {} };
      try {
        migrateAnchors(root, { graph: { nodes: [node], edges: [] }, claims: [], evidence: [] }, {
          apply: true,
          authority: authorized({ snapshot: "snapshot-alpha", facts: "facts-alpha" }),
          factsIdentity: "facts-alpha",
        });
      } catch (error) {
        console.log(error?.details?.reason ?? "UNKNOWN");
        process.exit(17);
      }
    `;
    const launch = () => Bun.spawn([process.execPath, "-e", source, root, start], {
      cwd: process.cwd(),
      env: { ...process.env, SEMCTX_ANCHOR_MIGRATION_HOLD_AFTER_ACQUIRE_MS: "500" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const first = launch();
    const second = launch();
    writeFileSync(start, "go", "utf8");
    const exits = await Promise.all([first.exited, second.exited]);
    const outputs = await Promise.all([
      new Response(first.stdout).text(),
      new Response(second.stdout).text(),
    ]);

    expect(exits.sort((a, b) => a - b)).toEqual([0, 17]);
    expect(outputs.join("\n")).toContain("TRANSACTION_ALREADY_ACTIVE");
    expect(read(root, "race.sem")).toContain(RUN.id);
    expect(existsSync(activeDir(root))).toBe(false);
  });

  it("never lets a same-PID Bun Worker recover another Worker's live transaction", async () => {
    const root = repository({
      "worker-race.sem": invariantFile("invariant.worker-race", ["sym:function:src/a.ts:run:42"]),
    });
    const workerPath = join(root, "migration-worker.ts");
    const enginePath = join(process.cwd(), "packages", "semantic-engine", "src", "index.ts");
    writeFileSync(workerPath, `
      import { migrateAnchors, authorized } from ${JSON.stringify(enginePath)};
      self.onmessage = (event) => {
        process.env["SEMCTX_ANCHOR_MIGRATION_HOLD_AFTER_ACQUIRE_MS"] = "500";
        const node = { id: "sym:function:src/a.ts:run", kind: "function", name: "run", filePath: "src/a.ts", evidence: [], tags: [], metadata: {} };
        try {
          migrateAnchors(event.data, { graph: { nodes: [node], edges: [] }, claims: [], evidence: [] }, {
            apply: true,
            authority: authorized({ snapshot: "snapshot-alpha", facts: "facts-alpha" }),
            factsIdentity: "facts-alpha",
          });
          postMessage({ ok: true, pid: process.pid });
        } catch (error) {
          postMessage({ ok: false, pid: process.pid, reason: error?.details?.reason ?? error?.code ?? "UNKNOWN" });
        }
      };
    `, "utf8");
    const worker = new Worker(workerPath);
    const outcome = new Promise<{ ok: boolean; pid: number; reason?: string }>((resolve) => {
      worker.onmessage = (event) => resolve(event.data);
    });
    worker.postMessage(root);
    const deadline = Date.now() + 5_000;
    while (!existsSync(activeDir(root)) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    expect(existsSync(activeDir(root))).toBe(true);

    let recoveryError: unknown;
    try { recoverAnchorMigration(root); } catch (error) { recoveryError = error; }

    expect((recoveryError as { details?: { reason?: string } }).details?.reason)
      .toBe("TRANSACTION_ALREADY_ACTIVE");
    const workerOutcome = await outcome;
    expect(workerOutcome).toEqual({ ok: true, pid: process.pid });
    expect(read(root, "worker-race.sem")).toContain(RUN.id);
    expect(existsSync(activeDir(root))).toBe(false);
    worker.terminate();
  });

  it("allows only one real subprocess to recover a crashed transaction", async () => {
    const root = repository({
      "recovery-race.sem": invariantFile("invariant.recovery-race", ["sym:function:src/a.ts:run:42"]),
    });
    const before = read(root, "recovery-race.sem");
    expect(crashMigration(root, "after-first-replace", [RUN])).toBe(86);
    const start = join(root, "start-recovery-race");
    const source = `
      import { existsSync } from "node:fs";
      import { recoverAnchorMigration } from "./packages/semantic-engine/src/index.ts";
      const root = process.argv[1];
      const start = process.argv[2];
      while (!existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      try {
        recoverAnchorMigration(root);
      } catch (error) {
        console.log(error?.details?.reason ?? "UNKNOWN");
        process.exit(17);
      }
    `;
    const launch = () => Bun.spawn([process.execPath, "-e", source, root, start], {
      cwd: process.cwd(),
      env: { ...process.env, SEMCTX_ANCHOR_MIGRATION_HOLD_AFTER_RECOVERY_CLAIM_MS: "500" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const first = launch();
    const second = launch();
    writeFileSync(start, "go", "utf8");
    const exits = await Promise.all([first.exited, second.exited]);
    const outputs = await Promise.all([
      new Response(first.stdout).text(),
      new Response(second.stdout).text(),
    ]);

    expect(exits.sort((a, b) => a - b)).toEqual([0, 17]);
    expect(outputs.join("\n")).toContain("TRANSACTION_ALREADY_ACTIVE");
    expect(read(root, "recovery-race.sem")).toBe(before);
    expect(existsSync(activeDir(root))).toBe(false);
    expect(existsSync(recoveryActiveDir(root))).toBe(false);
    expect(recoverAnchorMigration(root)).toEqual([]);
  });

  for (const point of ["after-recovery-candidate", "after-recovery-claim"] as const) {
    it(`reclaims a dead recovery owner after a crash at ${point}`, () => {
      const root = repository({
        "recovery-reclaim.sem": invariantFile("invariant.recovery-reclaim", ["sym:function:src/a.ts:run:42"]),
      });
      const before = read(root, "recovery-reclaim.sem");
      expect(crashMigration(root, "after-first-replace", [RUN])).toBe(86);
      expect(crashRecovery(root, point)).toBe(86);

      recoverAnchorMigration(root);

      expect(read(root, "recovery-reclaim.sem")).toBe(before);
      expect(existsSync(activeDir(root))).toBe(false);
      expect(existsSync(recoveryActiveDir(root))).toBe(false);
      expect(recoverAnchorMigration(root)).toEqual([]);
    });
  }

  it("cleans a release tombstone after recovery crashed beyond active cleanup", () => {
    const root = repository({
      "recovery-release.sem": invariantFile("invariant.recovery-release", ["sym:function:src/a.ts:run:42"]),
    });
    const before = read(root, "recovery-release.sem");
    expect(crashMigration(root, "after-first-replace", [RUN])).toBe(86);
    expect(crashRecovery(root, "after-recovery-release-rename")).toBe(86);

    expect(read(root, "recovery-release.sem")).toBe(before);
    expect(existsSync(activeDir(root))).toBe(false);
    expect(recoverAnchorMigration(root)).toEqual([]);
    expect(readdirSync(join(root, ".semctx", "working", "anchor-migration-v1"))
      .some((name) => name.startsWith("recovery-"))).toBe(false);
  });

  it("fails closed without deleting a corrupt recovery owner", () => {
    const root = repository({
      "recovery-corrupt.sem": invariantFile("invariant.recovery-corrupt", ["sym:function:src/a.ts:run:42"]),
    });
    expect(crashMigration(root, "after-first-replace", [RUN])).toBe(86);
    expect(crashRecovery(root, "after-recovery-claim")).toBe(86);
    writeFileSync(join(recoveryActiveDir(root), "owner.json"), "not-json", "utf8");

    expect(() => recoverAnchorMigration(root)).toThrow(/owner is corrupt/);
    expect(existsSync(activeDir(root))).toBe(true);
    expect(existsSync(recoveryActiveDir(root))).toBe(true);
  });

  it("fails closed when a published transaction owner is missing", () => {
    const root = repository({
      "owner-missing.sem": invariantFile("invariant.owner-missing", ["sym:function:src/a.ts:run:42"]),
    });
    expect(crashMigration(root, "after-first-replace", [RUN])).toBe(86);
    unlinkSync(join(activeDir(root), "owner.json"));
    const beforeRecovery = readFileSync(semanticPath(root, "owner-missing.sem"));

    let thrown: unknown;
    try { recoverAnchorMigration(root); } catch (error) { thrown = error; }

    expect((thrown as { details?: { reason?: string } }).details?.reason)
      .toBe("TRANSACTION_JOURNAL_CORRUPT");
    expect(readFileSync(semanticPath(root, "owner-missing.sem"))).toEqual(beforeRecovery);
    expect(existsSync(activeDir(root))).toBe(true);
  });

  it("does not misclassify transaction publication fsync failure as a collision", () => {
    const root = repository({
      "publish-fsync.sem": invariantFile("invariant.publish-fsync", ["sym:function:src/a.ts:run:42"]),
    });
    const before = readFileSync(semanticPath(root, "publish-fsync.sem"));
    const directory = join(root, ".semctx", "working", "anchor-migration-v1");
    let injected = false;
    let thrown: unknown;
    try {
      migrateAnchors(root, facts(RUN), {
        ...OK,
        fileSystem: {
          ...NODE_ANCHOR_MIGRATION_FILE_SYSTEM,
          syncDirectory: (path) => {
            if (!injected && path === directory && existsSync(activeDir(root))) {
              injected = true;
              throw Object.assign(new Error("injected transaction publication fsync"), { code: "EIO" });
            }
            NODE_ANCHOR_MIGRATION_FILE_SYSTEM.syncDirectory!(path);
          },
        },
      });
    } catch (error) { thrown = error; }

    expect(injected).toBe(true);
    expect((thrown as { details?: { reason?: string } }).details?.reason)
      .toBe("TRANSACTION_ACQUISITION_FAILED");
    expect(readFileSync(semanticPath(root, "publish-fsync.sem"))).toEqual(before);
    expect(existsSync(activeDir(root))).toBe(false);
  });

  it("does not misclassify recovery-claim fsync failure as a collision", () => {
    const root = repository({
      "claim-fsync.sem": invariantFile("invariant.claim-fsync", ["sym:function:src/a.ts:run:42"]),
    });
    const before = read(root, "claim-fsync.sem");
    expect(crashMigration(root, "after-first-replace", [RUN])).toBe(86);
    const directory = join(root, ".semctx", "working", "anchor-migration-v1");
    let injected = false;
    let thrown: unknown;
    try {
      recoverAnchorMigration(root, {
        ...NODE_ANCHOR_MIGRATION_FILE_SYSTEM,
        syncDirectory: (path) => {
          if (!injected && path === directory && existsSync(recoveryActiveDir(root))) {
            injected = true;
            throw Object.assign(new Error("injected recovery claim fsync"), { code: "EIO" });
          }
          NODE_ANCHOR_MIGRATION_FILE_SYSTEM.syncDirectory!(path);
        },
      });
    } catch (error) { thrown = error; }

    expect(injected).toBe(true);
    expect((thrown as { details?: { reason?: string } }).details?.reason)
      .toBe("TRANSACTION_RECOVERY_CLAIM_FAILED");
    expect(existsSync(recoveryActiveDir(root))).toBe(false);
    expect(existsSync(activeDir(root))).toBe(true);
    recoverAnchorMigration(root);
    expect(read(root, "claim-fsync.sem")).toBe(before);
  });

  it("preserves journal corruption when recovery release also fails", () => {
    const root = repository({
      "release-fsync.sem": invariantFile("invariant.release-fsync", ["sym:function:src/a.ts:run:42"]),
    });
    expect(crashMigration(root, "after-first-replace", [RUN])).toBe(86);
    appendFileSync(join(activeDir(root), "journal.ndjson"), "not-json\n", "utf8");
    const directory = join(root, ".semctx", "working", "anchor-migration-v1");
    let injected = false;
    let thrown: unknown;
    try {
      recoverAnchorMigration(root, {
        ...NODE_ANCHOR_MIGRATION_FILE_SYSTEM,
        syncDirectory: (path) => {
          const hasRelease = existsSync(directory)
            && readdirSync(directory).some((name) => name.startsWith("recovery-release-"));
          if (!injected && path === directory && hasRelease) {
            injected = true;
            throw Object.assign(new Error("injected recovery release fsync"), { code: "EIO" });
          }
          NODE_ANCHOR_MIGRATION_FILE_SYSTEM.syncDirectory!(path);
        },
      });
    } catch (error) { thrown = error; }

    const details = (thrown as { details?: Record<string, unknown> }).details ?? {};
    expect(details["reason"]).toBe("TRANSACTION_JOURNAL_CORRUPT");
    expect(details["suppressed"]).toEqual([
      { name: "Error", message: "injected recovery release fsync" },
    ]);
    expect(readdirSync(directory).some((name) => name.startsWith("recovery-release-"))).toBe(true);
    let retry: unknown;
    try { recoverAnchorMigration(root); } catch (error) { retry = error; }
    expect((retry as { details?: { reason?: string } }).details?.reason)
      .toBe("TRANSACTION_JOURNAL_CORRUPT");
    expect(readdirSync(directory).some((name) => name.startsWith("recovery-"))).toBe(false);
  });

  it("propagates an injected file fsync EIO and rolls back authored bytes", () => {
    const root = repository({
      "fsync.sem": invariantFile("invariant.fsync", ["sym:function:src/a.ts:run:42"]),
    });
    const before = readFileSync(semanticPath(root, "fsync.sem"));

    expect(() => migrateAnchors(root, facts(RUN), {
      ...OK,
      fileSystem: {
        ...NODE_ANCHOR_MIGRATION_FILE_SYSTEM,
        fsyncPath: () => {
          throw Object.assign(new Error("injected file fsync"), { code: "EIO" });
        },
      },
    })).toThrow(/rolled back/);
    expect(readFileSync(semanticPath(root, "fsync.sem"))).toEqual(before);
  });

  for (const code of ["EIO", "ENOSPC"] as const) {
    it(`propagates injected directory fsync ${code} without touching authored bytes`, () => {
      const root = repository({
        "dirsync.sem": invariantFile("invariant.dirsync", ["sym:function:src/a.ts:run:42"]),
      });
      const before = readFileSync(semanticPath(root, "dirsync.sem"));

      expect(() => migrateAnchors(root, facts(RUN), {
        ...OK,
        fileSystem: {
          ...NODE_ANCHOR_MIGRATION_FILE_SYSTEM,
          syncDirectory: () => {
            throw Object.assign(new Error(`injected directory fsync ${code}`), { code });
          },
        },
      })).toThrow(new RegExp(code));
      expect(readFileSync(semanticPath(root, "dirsync.sem"))).toEqual(before);
    });
  }

  it("propagates post-COMMITTED directory fsync failure without rolling back committed bytes", () => {
    const root = repository({
      "committed.sem": invariantFile("invariant.committed", ["sym:function:src/a.ts:run:42"]),
    });

    expect(() => migrateAnchors(root, facts(RUN), {
      ...OK,
      fileSystem: {
        ...NODE_ANCHOR_MIGRATION_FILE_SYSTEM,
        syncDirectory: (path) => {
          NODE_ANCHOR_MIGRATION_FILE_SYSTEM.syncDirectory!(path);
          if (existsSync(tombstoneDir(root))) {
            throw Object.assign(new Error("injected committed cleanup fsync"), { code: "EIO" });
          }
        },
      },
    })).toThrow(/committed but cleanup durability failed/);
    expect(read(root, "committed.sem")).toContain(RUN.id);
    expect(existsSync(activeDir(root))).toBe(false);
    expect(existsSync(tombstoneDir(root))).toBe(false);
  });
});
