import { describe, expect, test } from "bun:test";
import { comparePewExtraction, pewObservationSucceeded } from "./t00-ts7-q-config-pew";

describe("TS7 Program and worker qualification evidence", () => {
  const extraction = { modules: ["a.ts", "b.ts"], symbols: [], imports: [], calls: [] };
  test("exact independently authored extraction rejects omitted and additional facts", () => {
    expect(comparePewExtraction(extraction, extraction)).toBe(true);
    expect(comparePewExtraction({ ...extraction, modules: ["a.ts"] }, extraction)).toBe(false);
    expect(comparePewExtraction({ ...extraction, calls: [{ calleeName: "foreign" }] }, extraction)).toBe(false);
    expect(comparePewExtraction({ ...extraction, extra: true }, extraction)).toBe(false);
    expect(comparePewExtraction({}, extraction)).toBe(false);
  });
  test("failed processes and unsupported observations cannot earn property credit", () => {
    expect(pewObservationSucceeded(0, { executed: true, unsupported: [] })).toBe(true);
    expect(pewObservationSucceeded(1, { executed: true, unsupported: [] })).toBe(false);
    expect(pewObservationSucceeded(0, { executed: false, unsupported: [] })).toBe(false);
    expect(pewObservationSucceeded(0, { executed: true, unsupported: ["missing SDK"] })).toBe(false);
    expect(pewObservationSucceeded(0, {})).toBe(false);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CampaignContext } from "./t00-ts7-q-config-campaign";
import { runProgramEmissionWorkers } from "./t00-ts7-q-config-pew";

async function retainedSystemResults(oracleExit: number, mutate: boolean, emptySubjects = false) {
  const out = mkdtempSync(resolve(tmpdir(), "semctx-pew-unit-"));
  const sdk = resolve(out, "sdk.json");
  writeFileSync(sdk, JSON.stringify({ files: Object.fromEntries(Array.from({ length: 115 }, (_, i) => [`/sdk/lib/lib.fake${i}.d.ts`, ""])) }));
  const ctx: CampaignContext = {
    producer: "producer", helper: "helper", oracle: "oracle", sdk, out, platform: "macos",
    run: async name => {
      const value = name === "pew-retained-source" ? {
        complete: true, subjects: emptySubjects ? [] : [{ path: "src/leaf.ts", outcome: "analyzed", unimplemented: [], parseDiagnostics: [] }],
        raw_extraction: { symbols: [{ name: "leaf", relPath: "src/leaf.ts" }] },
      } : {
        executed: true, unsupported: [], results: [
          { value: mutate ? "live transient" : "retained leaf" }, { found: false },
          { value: true }, { value: false }, { value: true }, { value: false },
        ].map(item => ({ ...item, executed: true, unsupported: [] })),
      };
      return { exitCode: name.startsWith("pew-oracle-") ? oracleExit : 0, stdout: JSON.stringify(value), stderr: "", evidence: [{ path: "/unit-process", sha256: "a".repeat(64), bytes: 1 }] };
    },
  };
  try { return await runProgramEmissionWorkers(ctx, [172, 173, 174]); }
  finally { rmSync(out, { recursive: true, force: true }); }
}

test("independent Program and retained system controls qualify only with a successful TS7 oracle", async () => {
  expect((await retainedSystemResults(0, false)).map(item => item.status)).toEqual(["qualified", "qualified", "qualified"]);
  expect((await retainedSystemResults(2, false)).map(item => item.status)).toEqual(["not_qualified", "not_qualified", "not_qualified"]);
});

test("live-byte leakage and empty Program subjects cannot masquerade as retained source evidence", async () => {
  expect((await retainedSystemResults(0, true))[0]?.status).toBe("not_qualified");
  expect((await retainedSystemResults(0, false, true)).map(item => item.status)).toEqual(["not_qualified", "not_qualified", "not_qualified"]);
});


test("technical oracle execution failures abort the run", async () => {
  let failure: unknown;
  try { await retainedSystemResults(-1, false); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("Technical oracle execution failure");
});

test("unexecuted unresolved target cannot qualify the Program resolver", async () => {
  const out = mkdtempSync(resolve(tmpdir(), "t00-q-config-alias-"));
  const sdk = resolve(out, "sdk.json");
  writeFileSync(sdk, JSON.stringify({ files: Object.fromEntries(Array.from({ length: 115 }, (_, i) => [`/sdk/lib/lib.fake${i}.d.ts`, ""])) }));
  const calls: string[][] = [];
  const ctx: CampaignContext = {
    producer: "producer", helper: "helper", oracle: "oracle", sdk, out, platform: "macos",
    run: async (name, argv) => {
      calls.push(argv);
      if (name.startsWith("pew-oracle-")) return { exitCode: name.endsWith("missing") ? 2 : 0, stdout: name.endsWith("missing") ? "error TS2307: Cannot find module '@leaf'." : resolve(out, "pew/alias-present/repository/src/leaf.ts"), stderr: "", evidence: [] };
      const missing = name === "pew-alias-missing";
      return { exitCode: 0, stdout: JSON.stringify({ complete: true, subjects: [{ path: "main.ts", outcome: missing ? "unknown" : "analyzed", unimplemented: missing ? ["CONTROLLED_RESOLUTION_NOT_EXECUTED"] : [], parseDiagnostics: [] }], raw_extraction: { imports: [{ moduleSpecifier: "@leaf", ...(missing ? {} : { resolvedRelPath: "src/leaf.ts" }) }] } }), stderr: "", evidence: [] };
    },
  };
  try {
    const rows = await runProgramEmissionWorkers(ctx, [175]);
    expect(rows[0]?.status).toBe("not_qualified");
    expect(calls.filter(argv => argv[0] === "producer").every(argv => argv[1]?.endsWith(".request.json"))).toBe(true);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
