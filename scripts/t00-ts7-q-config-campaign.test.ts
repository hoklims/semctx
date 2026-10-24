import { expect, test } from "bun:test";
import { selectIndices } from "./t00-ts7-q-config-campaign";

test("campaign has exactly the 47 mandated obligations and deterministic disjoint shards", () => {
  expect(selectIndices()).toHaveLength(47);
  const shards = [selectIndices("1/3"), selectIndices("2/3"), selectIndices("3/3")];
  expect(new Set(shards.flat()).size).toBe(47);
  expect(shards.flat().sort((a, b) => a - b)).toEqual(selectIndices());
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunner, fileEvidence, parseManifest, parseOptions, validateResults, verifyArtifacts, verifySdk } from "./t00-ts7-q-config-campaign";
import type { ObligationResult, PlatformArtifacts } from "./t00-ts7-q-config-campaign";

async function rejection(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(() => null, (error: unknown) => error);
}

for (const shard of ["0/2", "2/1", "1.0/2", "1/2x", "1/0", "1/9007199254740992"]) {
  test(`reject malformed or empty shard ${shard}`, () => expect(() => selectIndices(shard)).toThrow());
}

test("empty shards preserve the modulo convention", () => {
  expect(selectIndices("48/48")).toEqual([]);
  expect(() => validateResults([], [])).not.toThrow();
});

test("CLI rejects duplicate, unknown and incomplete options", () => {
  const args = ["--candidate", "candidate.json", "--platform", "macos", "--out", "out"];
  expect(parseOptions(args).platform).toBe("macos");
  for (const suffix of [["--out", "elsewhere"], ["--other", "x"], ["--shard"], ["--shard", "0/2"]]) expect(() => parseOptions([...args, ...suffix])).toThrow();
  expect(() => parseOptions(["--candidate", "c", "--platform", "windows", "--out", "o"])).toThrow();
});

test("manifest refuses missing platform, incomplete artifacts and invalid identity", () => {
  const item = { path: "/tmp/binary", sha256: "a".repeat(64), bytes: 1 };
  const manifest = { schemaVersion: 1, sourceCommit: "b".repeat(40), kind: "development", platforms: { macos: { producer: item, helper: item, observer: item, sdk: item, oracle: item, oracleLibraries: item } } };
  expect(parseManifest(manifest, "macos").artifacts.producer.path).toBe("/tmp/binary");
  expect(() => parseManifest(manifest, "linux")).toThrow();
  expect(() => parseManifest({ ...manifest, sourceCommit: "HEAD" }, "macos")).toThrow();
  expect(() => parseManifest({ ...manifest, platforms: { macos: { producer: item } } }, "macos")).toThrow();
  expect(() => parseManifest({ ...manifest, kind: "final-ish" }, "macos")).toThrow();
});

test("artifact authentication refuses changed bytes, changed size and missing file", async () => {
  const root = await mkdtemp(join(tmpdir(), "t00-q-config-pin-"));
  try {
    const path = join(root, "artifact");
    await writeFile(path, "original");
    const original = await fileEvidence(path);
    const artifacts: PlatformArtifacts = { producer: original, helper: original, observer: original, sdk: original, oracle: original, oracleLibraries: original };
    expect(await verifyArtifacts(artifacts)).toHaveLength(6);
    await writeFile(path, "mutated!");
    expect(String(await rejection(verifyArtifacts(artifacts)))).toContain("mismatch");
    await writeFile(path, "original");
    expect(String(await rejection(verifyArtifacts({ ...artifacts, producer: { ...original, bytes: 1 } })))).toContain("mismatch");
    await rm(path);
    expect(await rejection(verifyArtifacts(artifacts))).toBeInstanceOf(Error);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK authentication refuses TS5, missing inventory and substituted libraries", () => {
  expect(() => verifySdk({ version: "5.9.3", files: {} })).toThrow("TS7");
  expect(() => verifySdk({ version: "7.1.0-dev", files: {} })).toThrow("115-library");
  expect(() => verifySdk({ version: "7.1.0-dev", files: { "/sdk/lib/../secret": "x" } })).toThrow("library");
  expect(() => verifySdk({ version: "7.1.0-dev", files: { "/sdk/lib/lib.d.ts": "foreign bytes" } })).toThrow("115-library");
});

test("qualification refuses missing rows, duplicate rows and incomplete or failed properties", () => {
  const row: ObligationResult = { index: 23, id: "T00-23", status: "not_qualified", reason: "uncovered live branch", properties: [{ property: "live realpath", status: "not_qualified", reason: "no live endpoint" }], evidence: [], durationMs: 1 };
  expect(() => validateResults([row], [23])).not.toThrow();
  expect(() => validateResults([], [23])).toThrow("census");
  expect(() => validateResults([row, row], [23])).toThrow("census");
  expect(() => validateResults([{ ...row, status: "qualified" }], [23])).toThrow("qualification");
  expect(() => validateResults([{ ...row, properties: [] }], [23])).toThrow("invalid");
  expect(() => validateResults([{ ...row, durationMs: NaN }], [23])).toThrow("invalid");
  expect(() => validateResults([{ ...row, status: "qualified", properties: [{ property: "realpath", status: "pass", reason: "finite witness" }] }], [23])).toThrow("qualification");
});

test("real-process runner retains nonzero exit, exact streams and command evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "t00-q-config-process-"));
  try {
    const run = createRunner(root);
    const result = await run("negative", [process.execPath, "-e", 'process.stdout.write("out\\n");process.stderr.write("err\\n");process.exit(7)']);
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
    expect(result.evidence).toHaveLength(3);
    for (const evidence of result.evidence) expect(await fileEvidence(evidence.path)).toEqual(evidence);
    const execution = JSON.parse(await readFile(result.evidence[2]!.path, "utf8"));
    expect(execution.exitCode).toBe(7);
    expect(execution.argv[0]).toBe(process.execPath);
    expect(String(await rejection(run("negative", [process.execPath, "--version"])))).toContain("duplicate");
    expect(String(await rejection(run("../escape", [process.execPath, "--version"])))).toContain("invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
