import { describe, it, expect } from "bun:test";
import { NullSemanticCandidateProvider, CocoIndexCandidateProvider, resolveProvider } from "../src/index";

describe("NullSemanticCandidateProvider", () => {
  it("is always available and contributes nothing", async () => {
    const provider = new NullSemanticCandidateProvider();
    expect(provider.name).toBe("none");
    expect(await provider.isAvailable()).toBe(true);
    expect(await provider.search({ query: "anything", repositoryRoot: ".", limit: 5 })).toEqual([]);
  });
});

describe("resolveProvider", () => {
  it("maps names to providers, defaulting to null", () => {
    expect(resolveProvider("cocoindex").name).toBe("cocoindex");
    expect(resolveProvider("none").name).toBe("none");
    expect(resolveProvider("something-unknown").name).toBe("none");
  });
});

describe("CocoIndexCandidateProvider.parse (tolerant to ccc output shapes)", () => {
  const provider = new CocoIndexCandidateProvider();

  it("parses a JSON array with field aliases", () => {
    const rows = provider.parse(JSON.stringify([{ file: "src/a.ts", symbol: "foo", score: 0.9, start_line: 3 }]));
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ filePath: "src/a.ts", symbolName: "foo", score: 0.9, startLine: 3, provider: "cocoindex" });
  });

  it("parses a { results: [...] } envelope", () => {
    const rows = provider.parse(JSON.stringify({ results: [{ path: "src/b.ts" }] }));
    expect(rows[0]?.filePath).toBe("src/b.ts");
    expect(rows[0]?.score).toBe(0.5); // default when absent
  });

  it("parses newline-delimited JSON", () => {
    const rows = provider.parse('{"file":"src/c.ts"}\n{"file":"src/d.ts"}');
    expect(rows.map((r) => r.filePath)).toEqual(["src/c.ts", "src/d.ts"]);
  });

  it("returns [] on empty or non-JSON input", () => {
    expect(provider.parse("")).toEqual([]);
    expect(provider.parse("this is not json")).toEqual([]);
  });
});

describe("CocoIndexCandidateProvider graceful degradation", () => {
  it("reports unavailable and returns no candidates when ccc is missing", async () => {
    const provider = new CocoIndexCandidateProvider({ command: "definitely-not-a-real-command-xyzzy" });
    expect(await provider.isAvailable()).toBe(false);
    expect(await provider.search({ query: "x", repositoryRoot: ".", limit: 3 })).toEqual([]);
  });

  it("keeps candidates unattested while ccc exposes no source-state seal", async () => {
    const provider = new CocoIndexCandidateProvider();
    expect("attestedSearch" in provider).toBe(false);
  });
});
