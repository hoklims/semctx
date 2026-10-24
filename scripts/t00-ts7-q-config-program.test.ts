import { describe, expect, test } from "bun:test";
import { configurationJsxReasons, configurationProgramBound, configurationOracleResolution, configurationProgramTarget } from "./t00-ts7-q-config-program";

const subject = { path: "main.ts", outcome: "analyzed", unimplemented: [], parseDiagnostics: [] };
const target = {
  complete: true,
  subjects: [subject],
  raw_extraction: {
    imports: [{ fromRelPath: "main.ts", moduleSpecifier: "@leaf", resolvedRelPath: "src/leaf.ts", bindingTargets: [{ relPath: "src/leaf.ts", symbolPath: "leaf" }] }],
    calls: [{ callerRelPath: "main.ts", callerSymbolPath: "main", calleeRelPath: "src/leaf.ts", calleeSymbolPath: "leaf", calleeName: "leaf" }],
  },
};
const observation = (reasons: string[] = []) => ({ executed: true, unsupported: [], reasons });
const jsx = {
  complete: true,
  subjects: [{ ...subject, path: "view.tsx", moduleConfigurationObservations: { ordinaryWithoutSnapshot: observation(), retainedWithoutSource: observation(), retainedWithSource: observation() } }],
};

describe("TS7 configuration Program qualification", () => {
  test("retained alias requires both the import and call to select the independent target", () => {
    expect(configurationProgramTarget(0, target, "src/leaf.ts")).toBe(true);
    expect(configurationProgramTarget(0, target, "src/other.ts")).toBe(false);
    expect(configurationProgramTarget(0, { ...target, raw_extraction: { ...target.raw_extraction, calls: [] } }, "src/leaf.ts")).toBe(false);
    expect(configurationProgramTarget(0, { ...target, raw_extraction: { ...target.raw_extraction, imports: [{ ...target.raw_extraction.imports[0], bindingTargets: [{ relPath: "src/other.ts", symbolPath: "leaf" }] }] } }, "src/leaf.ts")).toBe(false);
  });
  test("ordinary nonconsumption excludes stale binding and callee endpoints", () => {
    const unresolved = { ...target, raw_extraction: { imports: [{ fromRelPath: "main.ts", moduleSpecifier: "@leaf" }], calls: [{ callerRelPath: "main.ts", callerSymbolPath: "main", calleeName: "leaf" }] } };
    expect(configurationProgramTarget(0, unresolved, null)).toBe(true);
    expect(configurationProgramTarget(0, target, null)).toBe(false);
    expect(configurationProgramTarget(0, { ...unresolved, raw_extraction: { ...unresolved.raw_extraction, calls: target.raw_extraction.calls } }, null)).toBe(false);
  });
  test("failed, incomplete, unsupported or empty Programs cannot certify a target", () => {
    expect(configurationProgramTarget(2, target, "src/leaf.ts")).toBe(false);
    expect(configurationProgramTarget(0, { ...target, complete: false }, "src/leaf.ts")).toBe(false);
    expect(configurationProgramTarget(0, { ...target, subjects: [] }, "src/leaf.ts")).toBe(false);
    expect(configurationProgramTarget(0, { ...target, subjects: [{ ...subject, unimplemented: ["unavailable"] }] }, "src/leaf.ts")).toBe(false);
  });
  test("preserve excludes precisely generated JSX reasons across both retained observers", () => {
    expect(configurationJsxReasons(0, jsx, true, [])).toBe(true);
    const changed = structuredClone(jsx);
    changed.subjects[0]!.moduleConfigurationObservations.retainedWithSource.reasons = ["SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED"];
    expect(configurationJsxReasons(0, changed, true, [])).toBe(false);
    const unrelated = structuredClone(jsx);
    unrelated.subjects[0]!.moduleConfigurationObservations.retainedWithoutSource.reasons = ["SOURCE_EXPORT_EQUALS_UNSUPPORTED"];
    expect(configurationJsxReasons(0, unrelated, true, [])).toBe(true);
  });
  test("ordinary absence requires the ordinary observer to execute", () => {
    expect(configurationJsxReasons(0, jsx, false, [])).toBe(true);
    const changed = structuredClone(jsx);
    changed.subjects[0]!.moduleConfigurationObservations.ordinaryWithoutSnapshot.executed = false;
    expect(configurationJsxReasons(0, changed, false, [])).toBe(false);
    expect(configurationJsxReasons(0, { complete: true, subjects: [] }, false, [])).toBe(false);
  });
  test("automatic and classic activating controls cannot be replaced by preserve", () => {
    expect(configurationJsxReasons(0, jsx, true, ["SOURCE_AUTOMATIC_JSX_RUNTIME_UNSUPPORTED"])).toBe(false);
    expect(configurationJsxReasons(0, jsx, true, ["SOURCE_CLASSIC_JSX_RUNTIME_UNSUPPORTED"])).toBe(false);
    expect(configurationJsxReasons(1, jsx, false, [])).toBe(false);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CampaignContext } from "./t00-ts7-q-config-campaign";
import { runConfigurationProgram } from "./t00-ts7-q-config-program";

test("failed independent compiler observations leave every Program property unqualified", async () => {
  const out = mkdtempSync(resolve(tmpdir(), "semctx-program-control-"));
  const sdk = resolve(out, "sdk.json");
  writeFileSync(sdk, JSON.stringify({ files: Object.fromEntries(Array.from({ length: 115 }, (_, i) => [`/sdk/lib/lib.fake${i}.d.ts`, ""])) }));
  const producer = resolve(out, "producer");
  writeFileSync(producer, "controlled producer bytes");
  const ctx: CampaignContext = {
    producer, helper: "helper", oracle: "oracle", sdk, out, platform: "macos",
    run: async name => ({ exitCode: name.startsWith("program-oracle-") ? 2 : 0, stdout: name.startsWith("program-oracle-") ? "unrelated compiler failure" : JSON.stringify(target), stderr: "", evidence: [] }),
  };
  try {
    const result = await runConfigurationProgram(ctx, [167, 171]);
    expect(result.map(item => item.index)).toEqual([167, 171]);
    expect(result.map(item => item.status)).toEqual(["not_qualified", "not_qualified"]);
    expect(result.flatMap(item => item.properties).every(item => item.status !== "pass")).toBe(true);
    expect(result.every(item => item.evidence.length > 0)).toBe(true);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("unselected Program obligations do not read artifacts or run a process", async () => {
  const ctx: CampaignContext = { producer: "absent", helper: "absent", oracle: "absent", sdk: "absent", out: "absent", platform: "macos", run: () => { throw Error("unexpected process"); } };
  expect(await runConfigurationProgram(ctx, [23])).toEqual([]);
});


test("independent resolution requires the expected compiler outcome without unrelated diagnostics", () => {
  const trace = "Module name '@leaf' was successfully resolved to '/repo/src/leaf.ts'.";
  expect(configurationOracleResolution(0, trace, "/repo", "src/leaf.ts")).toEqual({ passed: true, target: "src/leaf.ts" });
  expect(configurationOracleResolution(2, "error TS2307: Cannot find module '@leaf'.", "/repo", null).passed).toBe(true);
  expect(configurationOracleResolution(0, "", "/repo", null).passed).toBe(false);
  expect(configurationOracleResolution(2, "error TS2307: Missing.\nerror TS9999: Unrelated failure.", "/repo", null).passed).toBe(false);
  expect(configurationOracleResolution(2, "malformed configuration", "/repo", null).passed).toBe(false);
  expect(configurationOracleResolution(0, trace + trace, "/repo", "src/leaf.ts").passed).toBe(false);
  expect(configurationOracleResolution(0, trace, "/repo", "src/other.ts").passed).toBe(false);
});


test("Program proof refuses foreign request or producer identity and dirty process streams", () => {
  const value = { request_id: "sha256:request", producer_artifact_id: "sha256:producer" };
  expect(configurationProgramBound(0, "", value, "sha256:request", "sha256:producer")).toBe(true);
  expect(configurationProgramBound(1, "", value, "sha256:request", "sha256:producer")).toBe(false);
  expect(configurationProgramBound(0, "warning", value, "sha256:request", "sha256:producer")).toBe(false);
  expect(configurationProgramBound(0, "", value, "sha256:foreign", "sha256:producer")).toBe(false);
  expect(configurationProgramBound(0, "", value, "sha256:request", "sha256:foreign")).toBe(false);
  expect(configurationProgramBound(0, "", {}, "sha256:request", "sha256:producer")).toBe(false);
});
