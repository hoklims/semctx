import { describe, it, expect } from "bun:test";
import { parseNameOnlyLog, computeCoChanges } from "@semantic-context/context-engine";

describe("parseNameOnlyLog", () => {
  it("splits git log by record separator into per-commit file lists", () => {
    const log = "\x1e\na.ts\nb.ts\n\x1e\na.ts\nc.ts\n";
    expect(parseNameOnlyLog(log)).toEqual([
      ["a.ts", "b.ts"],
      ["a.ts", "c.ts"],
    ]);
  });

  it("dedupes files within a commit and drops empty commits", () => {
    const log = "\x1e\na.ts\na.ts\n\x1e\n\n";
    expect(parseNameOnlyLog(log)).toEqual([["a.ts"]]);
  });
});

describe("computeCoChanges", () => {
  it("reports files co-changed with a changed file at or above minSupport", () => {
    const commits = [
      ["a.ts", "b.ts"],
      ["a.ts", "b.ts"],
      ["a.ts", "c.ts"],
      ["x.ts", "y.ts"],
    ];
    // a.ts ↔ b.ts twice (kept), a.ts ↔ c.ts once (dropped at minSupport 2).
    expect(computeCoChanges(commits, ["a.ts"], { minSupport: 2 })).toEqual([
      { file: "a.ts", coChanged: [{ file: "b.ts", commits: 2 }] },
    ]);
  });

  it("excludes files already in the diff, and returns empty below support", () => {
    const commits = [["a.ts", "b.ts"]];
    expect(computeCoChanges(commits, ["a.ts", "b.ts"], { minSupport: 1 })).toEqual([]);
    expect(computeCoChanges(commits, ["a.ts"], { minSupport: 5 })).toEqual([]);
  });

  it("ranks by support desc then path asc and caps per file", () => {
    const commits = [
      ["a.ts", "b.ts", "c.ts"],
      ["a.ts", "b.ts"],
      ["a.ts", "c.ts"],
    ];
    // b.ts: 2, c.ts: 2 -> tie broken by path asc; cap 1 keeps b.ts.
    expect(computeCoChanges(commits, ["a.ts"], { minSupport: 2, maxPerFile: 1 })).toEqual([
      { file: "a.ts", coChanged: [{ file: "b.ts", commits: 2 }] },
    ]);
  });
});
