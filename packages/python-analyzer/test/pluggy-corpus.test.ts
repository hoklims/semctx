import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { extractPython } from "../src/index";

const UPSTREAM_TAG = "1.6.0";
const UPSTREAM_COMMIT = "fd08ab5f811a9b2fa9124ae8cbbd393221151e2c";
const CORPUS_ROOT = resolve(import.meta.dir, "corpus", `pluggy-${UPSTREAM_TAG}`);

const UPSTREAM_FILES = [
  {
    relPath: "src/pluggy/__init__.py",
    sha256: "0fa769d609840e3b43a7c840c1073eaab81aba59cbe2296daea90b0ddfa0f6d8",
  },
  {
    relPath: "src/pluggy/_result.py",
    sha256: "dd77f2ec3ae35db61bee9b91aaec98d956e274858daba3e9ed09ee12531d8fc4",
  },
  {
    relPath: "testing/test_result.py",
    sha256: "6699113439e9477954ecb107929db305361ead8cec63a16d5b12b909bdf79c21",
  },
] as const;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function loadCorpus() {
  return UPSTREAM_FILES.map(({ relPath }) => ({
    relPath,
    source: readFileSync(resolve(CORPUS_ROOT, relPath), "utf8"),
  }));
}

describe(`pluggy ${UPSTREAM_TAG} real-repository corpus`, () => {
  it("pins exact upstream source and license bytes", () => {
    expect(UPSTREAM_COMMIT).toBe("fd08ab5f811a9b2fa9124ae8cbbd393221151e2c");
    for (const file of UPSTREAM_FILES) {
      expect(sha256(readFileSync(resolve(CORPUS_ROOT, file.relPath)))).toBe(file.sha256);
    }
    expect(sha256(readFileSync(resolve(CORPUS_ROOT, "LICENSE")))).toBe(
      "d6b65e6c213a5d0b577911d34d6e5949b9f59d76c238c5071a2f3fc16cfb2606",
    );
  });

  it("matches the deterministic canonical extraction golden", () => {
    const files = loadCorpus();
    const extraction = extractPython(files);

    expect(extractPython([...files].reverse())).toEqual(extraction);
    expect(sha256(JSON.stringify(extraction))).toBe(
      "77e01ca40972feba38470d449a8b5fc3ad492628ef999991cfeab1e37a697a07",
    );
  });

  it("emits stable local facts beyond path matching", () => {
    const extraction = extractPython(loadCorpus());

    expect(extraction.modules.map(({ relPath }) => relPath)).toEqual([
      "src/pluggy/__init__.py",
      "src/pluggy/_result.py",
      "testing/test_result.py",
    ]);
    expect(
      extraction.symbols.map(({ relPath, name, kind, range }) => ({
        relPath,
        name,
        kind,
        startLine: range.startLine,
      })),
    ).toEqual([
      { relPath: "src/pluggy/_result.py", name: "HookCallError", kind: "class", startLine: 20 },
      { relPath: "src/pluggy/_result.py", name: "Result", kind: "class", startLine: 25 },
      { relPath: "src/pluggy/_result.py", name: "__init__", kind: "function", startLine: 31 },
      { relPath: "src/pluggy/_result.py", name: "excinfo", kind: "function", startLine: 43 },
      { relPath: "src/pluggy/_result.py", name: "exception", kind: "function", startLine: 52 },
      { relPath: "src/pluggy/_result.py", name: "from_call", kind: "function", startLine: 57 },
      { relPath: "src/pluggy/_result.py", name: "force_result", kind: "function", startLine: 67 },
      { relPath: "src/pluggy/_result.py", name: "force_exception", kind: "function", startLine: 80 },
      { relPath: "src/pluggy/_result.py", name: "get_result", kind: "function", startLine: 91 },
      {
        relPath: "testing/test_result.py",
        name: "test_exceptions_traceback_doesnt_get_longer_and_longer",
        kind: "function",
        startLine: 6,
      },
      { relPath: "testing/test_result.py", name: "bad", kind: "function", startLine: 7 },
    ]);

    expect(
      extraction.imports.filter(
        ({ fromRelPath, module }) =>
          fromRelPath === "src/pluggy/__init__.py" && module === "_result",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "from",
        module: "_result",
        relativeLevel: 1,
        names: [{ name: "HookCallError" }],
      }),
      expect.objectContaining({
        kind: "from",
        module: "_result",
        relativeLevel: 1,
        names: [{ name: "Result" }],
      }),
    ]);
    expect(extraction.limitations).toEqual([]);
  });

  it("keeps unsupported negative conclusions ineligible", () => {
    const extraction = extractPython(loadCorpus());

    // A syntactically clean corpus does not expand this producer's capability:
    // imports are not resolved, and function names do not prove test or call relations.
    expect(extraction).not.toHaveProperty("calls");
    expect(extraction).not.toHaveProperty("contracts");
    expect(extraction).not.toHaveProperty("tests");
    expect(
      extraction.symbols.find(
        ({ name }) => name === "test_exceptions_traceback_doesnt_get_longer_and_longer",
      )?.kind,
    ).toBe("function");
    expect(extraction.imports.some((item) => item.module === "_result")).toBe(true);
    expect(extraction.imports.every((item) => !("toRelPath" in item))).toBe(true);
  });
});
