/**
 * `semctx migrate anchors` proved at the surface an operator and CI actually touch.
 *
 * Testing `migrateAnchors` alone leaves the parts that decide what a caller sees untested: which
 * exit code CI reads, whether the JSON carries the reason code and the candidates, and whether the
 * authority refusal reaches the transport at all. Each case here runs the real command.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { cpSync, rmSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { openStore } from "@semantic-context/repository-store";
import { parseArgs } from "../src/args";
import { runInit } from "../src/commands/init";
import { runIndex } from "../src/commands/index-cmd";
import { runMigrate } from "../src/commands/migrate";

let root: string;

function git(...args: string[]): void {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", ...args],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function silently<T>(action: () => T): T {
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (): boolean => true;
  try {
    return action();
  } finally {
    process.stdout.write = originalWrite;
  }
}

function run(argv: string[]): { code: number; out: string } {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let out = "";
  (process.stdout.write as unknown) = (chunk: string): boolean => {
    out += chunk;
    return true;
  };
  try {
    const code = runMigrate(root, parseArgs([...argv, "--root", root]));
    return { code, out };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function reindex(): void {
  silently(() => runIndex(root, parseArgs(["index", "--root", root])));
}

function semanticPath(name: string): string {
  return join(root, ".semctx", "semantic", name);
}

function readSem(name: string): string {
  return readFileSync(semanticPath(name), "utf8");
}

function evidenceFile(id: string, refs: readonly string[]): string {
  return [
    `evidence ${id}`,
    "  statement: the behaviour is observed here",
    "  status: declared",
    ...refs.map((ref) => `  link: ${ref}`),
    "",
  ].join("\n");
}

const FIXTURES = ["migration.sem", "migration-b.sem"] as const;

function prepare(files: Partial<Record<(typeof FIXTURES)[number], string>>): void {
  mkdirSync(join(root, ".semctx", "semantic"), { recursive: true });
  for (const name of FIXTURES) {
    const content = files[name];
    if (content === undefined) rmSync(semanticPath(name), { force: true });
    else writeFileSync(semanticPath(name), content, "utf8");
  }
  reindex();
}

/** A symbol that exists in the indexed sample repository, discovered rather than assumed. */
let anchoredSymbol: { legacy: string; canonical: string };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-migrate-cli-"));
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
  });
  writeFileSync(join(root, ".gitignore"), ".semctx/\n", "utf8");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  silently(() => runInit(root, parseArgs(["init", "--root", root])));
  reindex();

  const store = openStore(root);
  try {
    const byKey = new Map<string, string[]>();
    for (const node of store.loadGraph().nodes) {
      const parts = node.id.split(":");
      if (parts.length !== 4 || parts[0] !== "sym") continue;
      const key = `${parts[1]} ${parts[2]} ${parts[3]!.split(".").pop()}`;
      byKey.set(key, [...(byKey.get(key) ?? []), node.id]);
    }
    const unique = [...byKey.entries()]
      .filter(([, ids]) => ids.length === 1)
      .sort(([left], [right]) => (left < right ? -1 : 1))[0];
    if (unique === undefined) throw new Error("sample repository has no uniquely named symbol");
    const [key, ids] = unique;
    const [kind, relPath, name] = key.split(" ") as [string, string, string];
    anchoredSymbol = { legacy: `sym:${kind}:${relPath}:${name}:1`, canonical: ids[0]! };
  } finally {
    store.close();
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("semctx migrate — transport", () => {
  it("prints usage and exits 0 with no subcommand, 1 with an unknown one", () => {
    expect(run(["migrate"]).code).toBe(0);
    expect(run(["migrate", "nonsense"]).code).toBe(1);
    expect(run(["migrate"]).out).toContain("semctx migrate anchors");
  });

  it("advertises itself as temporary, not as a permanent rewrite facility", () => {
    expect(run(["migrate"]).out).toContain("temporary");
  });
});

describe("semctx migrate anchors — dry run", () => {
  it("exits 0, reports the rewrite in canonical JSON, and leaves the file byte-identical", () => {
    prepare({ "migration.sem": evidenceFile("evidence.migrate.one", [anchoredSymbol.legacy]) });
    const before = readSem("migration.sem");

    const result = run(["migrate", "anchors", "--format", "json"]);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.schemaVersion).toBe(1);
    expect(report.kind).toBe("anchor_migration");
    expect(report.applied).toBe(false);
    expect(report.authority.status).toBe("authorized");
    expect(report.authority.reasons).toEqual([]);
    expect(report.authority.generation).toMatchObject({
      snapshot: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      facts: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(report.counts.rewritten).toBe(1);
    expect(report.hasRefusals).toBe(false);
    const outcome = report.files
      .flatMap((file: { outcomes: unknown[] }) => file.outcomes)
      .find((item: { status: string }) => item.status === "rewritten");
    expect(outcome).toMatchObject({ from: anchoredSymbol.legacy, to: anchoredSymbol.canonical });
    expect(readSem("migration.sem")).toBe(before);
  });
});

describe("semctx migrate anchors — apply", () => {
  it("exits 0 and rewrites the anchor", () => {
    prepare({ "migration.sem": evidenceFile("evidence.migrate.one", [anchoredSymbol.legacy]) });

    const result = run(["migrate", "anchors", "--apply", "--format", "json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).applied).toBe(true);
    expect(readSem("migration.sem")).toContain(`  link: ${anchoredSymbol.canonical}`);
  });

  it("recovers an interrupted transaction before planning the next CLI run", () => {
    prepare({
      "migration.sem": evidenceFile("evidence.migrate.one", [anchoredSymbol.legacy]),
      "migration-b.sem": evidenceFile("evidence.migrate.two", [anchoredSymbol.legacy]),
    });
    const beforeA = readFileSync(semanticPath("migration.sem"));
    const beforeB = readFileSync(semanticPath("migration-b.sem"));
    const child = Bun.spawnSync([
      process.execPath,
      "apps/cli/src/index.ts",
      "migrate",
      "anchors",
      "--apply",
      "--format",
      "json",
      "--root",
      root,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, SEMCTX_ANCHOR_MIGRATION_CRASH_AT: "after-first-replace" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(86);

    const recovered = run(["migrate", "anchors", "--format", "json"]);
    expect(recovered.code).toBe(0);
    expect(readFileSync(semanticPath("migration.sem")).equals(beforeA)).toBe(true);
    expect(readFileSync(semanticPath("migration-b.sem")).equals(beforeB)).toBe(true);
  });
});

describe("semctx migrate anchors — refusal quarantines the whole run", () => {
  it("exits 1, names the reason code and candidates on the canonical shape, writes nothing", () => {
    prepare({
      "migration.sem": evidenceFile("evidence.migrate.gone", ["sym:function:src/nowhere.ts:vanished:12"]),
      "migration-b.sem": evidenceFile("evidence.migrate.clean", [anchoredSymbol.legacy]),
    });
    const cleanBefore = readSem("migration-b.sem");
    const refusedBefore = readSem("migration.sem");

    const result = run(["migrate", "anchors", "--apply", "--format", "json"]);
    const report = JSON.parse(result.out);

    expect(result.code).toBe(1);
    expect(report.authority.status).toBe("authorized");
    expect(report.hasRefusals).toBe(true);
    expect(report.applied).toBe(false);
    const refusal = report.files
      .flatMap((file: { outcomes: unknown[] }) => file.outcomes)
      .find((item: { status: string }) => item.status === "refused");
    expect(refusal.reasonCode).toBe("symbol_gone");
    expect(Array.isArray(refusal.candidates)).toBe(true);
    // The clean sibling file is untouched too: a refusal quarantines the entire run.
    expect(readSem("migration-b.sem")).toBe(cleanBefore);
    expect(readSem("migration.sem")).toBe(refusedBefore);
  });
});

describe("semctx migrate anchors — index authority", () => {
  it("exits 1 and writes nothing when a tracked source edit outruns the index", () => {
    prepare({ "migration.sem": evidenceFile("evidence.migrate.one", [anchoredSymbol.legacy]) });
    const before = readSem("migration.sem");
    const drift = join(root, "src", "semctx-migrate-drift.ts");
    writeFileSync(drift, "export const drift = 1;\n", "utf8");
    git("add", "-A");
    git("commit", "-q", "-m", "drift");

    try {
      const result = run(["migrate", "anchors", "--apply", "--format", "json"]);
      const report = JSON.parse(result.out);

      expect(result.code).toBe(1);
      expect(report.authority.status).toBe("refused");
      expect(report.authority.reasons.length).toBeGreaterThan(0);
      expect(report.applied).toBe(false);
      expect(report.files).toEqual([]);
      expect(readSem("migration.sem")).toBe(before);
    } finally {
      rmSync(drift, { force: true });
      git("add", "-A");
      git("commit", "-q", "-m", "undo drift");
      reindex();
    }
  });
});
