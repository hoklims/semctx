import { describe, expect, test } from "bun:test";
import { compilerDiagnostics, resolutionFromTrace, closeConfigurationResolution, preserveUnprovedConfigurationProperties, runConfigurationResolution } from "./t00-ts7-q-config-cr";

describe("TS7 configuration/resolution evidence", () => {
  test("retains complete independent diagnostic messages and repeated codes", () => {
    expect(compilerDiagnostics("tsconfig.json(2,4): error TS6046: Argument for '--module' option must be: 'esnext'.\nerror TS5095: Bundler requires an ESM module.\n")).toEqual([
      { code: 6046, message: "Argument for '--module' option must be: 'esnext'." },
      { code: 5095, message: "Bundler requires an ESM module." },
    ]);
  });

  test("unrecognized compiler output cannot become an empty successful oracle", () => {
    expect(() => compilerDiagnostics("fatal: unsupported protocol\n")).toThrow("unrecognized");
  });

  test("selects only the requested resolution from a complete compiler trace", () => {
    const trace = "======== Module name './target' was successfully resolved to '/world/target.ts'. ========\n======== Module name 'other' was not resolved. ========\n";
    expect(resolutionFromTrace(trace, "./target")).toBe("/world/target.ts");
    expect(resolutionFromTrace(trace, "other")).toBeNull();
    expect(() => resolutionFromTrace(trace, "absent")).toThrow("missing");
  });

  test("ambiguous resolution results are refused instead of selecting the first", () => {
    expect(() => resolutionFromTrace("======== Module name 'pkg' was successfully resolved to '/a.ts'. ========\n======== Module name 'pkg' was successfully resolved to '/b.ts'. ========\n", "pkg")).toThrow("ambiguous");
  });

  test("empty shards execute no process or SDK acquisition", async () => {
    const results = await runConfigurationResolution({ producer: "", helper: "", sdk: "", oracle: "", out: "", platform: "macos", run: async () => { throw new Error("unexpected process"); } }, []);
    expect(results).toEqual([]);
  });

  test("finite successful witnesses cannot hide a missing cumulative failure path", () => {
    expect(closeConfigurationResolution([
      { property: "finite resolution", status: "pass", reason: "matches oracle" },
      { property: "live realpath failures", status: "not_qualified", reason: "unexercised" },
    ])).toBe("not_qualified");
  });

  test("a mismatch or empty property denominator cannot qualify", () => {
    expect(closeConfigurationResolution([])).toBe("not_qualified");
    expect(closeConfigurationResolution([{ property: "diagnostic", status: "fail", reason: "different" }])).toBe("not_qualified");
    expect(closeConfigurationResolution([{ property: "owned", status: "pass", reason: "complete" }])).toBe("qualified");
  });
});

test("successful native directory witnesses do not close the unproved optional delegate correspondence", () => {
  const successful = [{ property: "native directory true/false", status: "pass" as const, reason: "observed" }];
  expect(closeConfigurationResolution(preserveUnprovedConfigurationProperties(201, successful))).toBe("not_qualified");
  expect(closeConfigurationResolution(preserveUnprovedConfigurationProperties(198, successful))).toBe("not_qualified");
  expect(closeConfigurationResolution(preserveUnprovedConfigurationProperties(205, successful))).toBe("qualified");
});
