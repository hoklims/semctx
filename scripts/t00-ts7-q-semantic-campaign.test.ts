import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadCandidateArtifacts } from "./t00-ts7-q-semantic-campaign";
import { selectIndices, selectShard, verifyArtifact, compareReasons, semanticObservation, verifyProducerCompletion } from "./t00-ts7-q-semantic-core";

test("bounded repetition selects only existing obligations and rejects gaps or duplicate indices", () => {
  const rows = [{ index: 49 }, { index: 50 }, { index: 51 }];
  expect(selectIndices(rows, "50-51")).toEqual(rows.slice(1));
  expect(selectIndices(rows)).toEqual(rows);
  for (const range of ["50-52", "51-50", "50", "-1-50", "0-9007199254740992"]) expect(() => selectIndices(rows, range)).toThrow("INVALID_INDICES");
  expect(() => selectIndices([{ index: 50 }, { index: 50 }], "50-51")).toThrow("INVALID_INDICES");
});

test("shards partition obligations deterministically without omissions", () => {
  const rows = [{ index: 49 }, { index: 50 }, { index: 51 }, { index: 52 }];
  expect(selectShard(rows, "1/2")).toEqual([{ index: 49 }, { index: 51 }]);
  expect(selectShard(rows, "2/2")).toEqual([{ index: 50 }, { index: 52 }]);
  expect(selectShard([{ index: 99 }, { index: 50 }, { index: 76 }], "1/2")).toEqual([{ index: 50 }, { index: 99 }]);
  for (const shard of ["0/2", "3/2", "1/0", "1/2x", "1.5/2"]) {
    expect(() => selectShard(rows, shard)).toThrow();
  }
});

test("candidate binding rejects changed bytes, missing files and malformed digests", () => {
  const dir = mkdtempSync(join(tmpdir(), "t00-ts7-semantic-test-"));
  try {
    const path = join(dir, "artifact");
    writeFileSync(path, "original");
    const artifact = { path, sha256: createHash("sha256").update("original").digest("hex") };
    expect(verifyArtifact(artifact).bytes).toBe(8);
    writeFileSync(path, "modified");
    expect(() => verifyArtifact(artifact)).toThrow("ARTIFACT_MISMATCH");
    expect(() => verifyArtifact({ path, sha256: "" })).toThrow();
    expect(() => verifyArtifact({ ...artifact, path: join(dir, "absent") })).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("complete reasons reject unexpected extra reasons and absent oracle or execution", () => {
  const observation = { executed: true, unsupported: [], reasons: ["SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED"] };
  expect(compareReasons(observation, ["SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED"])).toBe(true);
  expect(compareReasons(observation, [])).toBe(false);
  expect(compareReasons(observation, null)).toBe(false);
  expect(compareReasons({ ...observation, executed: false }, observation.reasons)).toBe(false);
  expect(compareReasons({ ...observation, unsupported: ["missing"] }, observation.reasons)).toBe(false);
  expect(compareReasons({}, [])).toBe(false);
});

test("producer observations select the repository-relative subject path", () => {
  const observation = { executed: true, unsupported: [], reasons: ["SOURCE_REFERENCE_PATH_UNSUPPORTED"] };
  const response = { subjects: [{ path: "dep.ts", semanticObservation: { reasons: [] } }, { path: "main.ts", semanticObservation: observation }] };
  expect(semanticObservation(response, "main.ts")).toEqual(observation);
  expect(semanticObservation(response, "missing.ts")).toEqual({});
});

test("producer panic, timeout and missing process cannot become a complete campaign", () => {
  for (const exitCode of [0, 1]) expect(() => verifyProducerCompletion({ exitCode, signal: null, error: null })).not.toThrow();
  expect(() => verifyProducerCompletion({ exitCode: 101, signal: null, error: null })).toThrow("PRODUCER_EXECUTION_FAILED");
  expect(() => verifyProducerCompletion({ exitCode: null, signal: "SIGTERM", error: "timeout" })).toThrow("PRODUCER_EXECUTION_FAILED");
  expect(() => verifyProducerCompletion({ exitCode: null, signal: null, error: "ENOENT" })).toThrow("PRODUCER_EXECUTION_FAILED");
});

test("campaign rejects every changed candidate artifact before launching processes", () => {
  const directory = mkdtempSync(join(tmpdir(), "t00-ts7-semantic-binding-"));
  try {
    const marker = join(directory, "invoked"), out = join(directory, "output");
    const names = ["producer", "helper", "observer", "sdk", "oracle", "oracleLibraries", "semanticOracle"];
    const content = '#!/bin/sh\nprintf invoked > "$TEST_MARKER"\n';
    const artifacts = Object.fromEntries(names.map(name => {
      const path = join(directory, name);
      writeFileSync(path, content, { mode: 0o755 });
      return [name, { path, sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content) }];
    }));
    const platform = "macos";
    const manifest = join(directory, "candidate.json");
    for (const name of names) {
      writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, sourceCommit: "a".repeat(40), platforms: { macos: artifacts, linux: artifacts } }));
      writeFileSync(artifacts[name]!.path, content + "changed");
      expect(() => loadCandidateArtifacts(manifest, platform)).toThrow("ARTIFACT_MISMATCH:");
      const nativePlatform = process.platform === "darwin" ? "macos" : "linux";
      const supported = process.arch === "arm64" && ["darwin", "linux"].includes(process.platform);
      const result = spawnSync(process.execPath, [join(import.meta.dir, "t00-ts7-q-semantic-campaign.ts"), "--candidate", manifest, "--platform", nativePlatform, "--out", out], { env: { ...process.env, TEST_MARKER: marker }, timeout: 10_000 });
      expect(result.status).toBe(1);
      expect(result.stderr.toString()).toContain(supported ? "ARTIFACT_MISMATCH:" : "PLATFORM_MISMATCH");
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(out)).toBe(false);
      writeFileSync(artifacts[name]!.path, content);
      expect(loadCandidateArtifacts(manifest, platform).artifacts[name]).toEqual(artifacts[name]);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("campaign still refuses a mismatched execution platform before reading the candidate", () => {
  const platform = process.platform === "darwin" ? "linux" : "macos";
  const result = spawnSync(process.execPath, [join(import.meta.dir, "t00-ts7-q-semantic-campaign.ts"), "--candidate", "absent.json", "--platform", platform, "--out", "unused"], { timeout: 10_000 });
  expect(result.status).toBe(1);
  expect(result.stderr.toString()).toContain("PLATFORM_MISMATCH");
});
