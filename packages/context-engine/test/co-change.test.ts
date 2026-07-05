import { describe, it, expect } from "bun:test";
import { parseNameStatusLog, computeCoChanges, GraphIndex, analyzeDiff, buildVerifyReport } from "@semantic-context/context-engine";
import { createDefaultConfig } from "@semantic-context/core";
import type { CoChange, VerifyReportGitMeta } from "@semantic-context/context-engine";
import type { RepositoryGraph } from "@semantic-context/core";

describe("parseNameStatusLog", () => {
  it("splits by record separator and reads <status>\\t<path> lines", () => {
    const log = "\x1e\nM\ta.ts\nA\tb.ts\n\x1e\nM\ta.ts\nD\tc.ts\n";
    expect(parseNameStatusLog(log)).toEqual([
      ["a.ts", "b.ts"],
      ["a.ts", "c.ts"],
    ]);
  });

  it("folds a rename (R<score>\\told\\tnew) into BOTH paths so history survives the rename", () => {
    const log = "\x1e\nR096\told/x.ts\tnew/x.ts\nM\ta.ts\n";
    expect(parseNameStatusLog(log)).toEqual([["old/x.ts", "new/x.ts", "a.ts"]]);
  });

  it("dedupes files within a commit and drops empty commits", () => {
    const log = "\x1e\nM\ta.ts\nM\ta.ts\n\x1e\n\n";
    expect(parseNameStatusLog(log)).toEqual([["a.ts"]]);
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
    expect(computeCoChanges(commits, ["a.ts"], { minSupport: 2, maxPerFile: 1 })).toEqual([
      { file: "a.ts", coChanged: [{ file: "b.ts", commits: 2 }] },
    ]);
  });
});

describe("co-change projection into VerifyReport", () => {
  const config = createDefaultConfig(".");
  const emptyGraph: RepositoryGraph = { nodes: [], edges: [] };
  const meta: VerifyReportGitMeta = { base: null, head: "HEAD", mergeBase: null, range: null };
  const result = () => analyzeDiff({ index: new GraphIndex(emptyGraph), claims: [], config, diffText: "" });

  it("projects a non-empty CoChange[] into report.coChangedFiles (additive, correct shape)", () => {
    const coChanges: CoChange[] = [{ file: "a.ts", coChanged: [{ file: "b.ts", commits: 3 }] }];
    const report = buildVerifyReport(result(), meta, config.blockingRules, coChanges);
    expect(report.coChangedFiles).toEqual([{ file: "a.ts", coChanged: [{ file: "b.ts", commits: 3 }] }]);
  });

  it("omits coChangedFiles entirely when empty (ADR 0008: present only when non-empty)", () => {
    const report = buildVerifyReport(result(), meta, config.blockingRules, []);
    expect("coChangedFiles" in report).toBe(false);
  });
});
