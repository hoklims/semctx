import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCandidate } from "./t00-ts7-q-syntax-campaign";

test("campaign refuses incomplete, altered and ambiguously selected candidates before writing a result", async () => {
  const root = await mkdtemp(join(tmpdir(), "t00-ts7-q-syntax-preflight-"));
  try {
    const binary = join(root, "artifact");
    await writeFile(binary, "fixture");
    const artifact = { path: binary, bytes: 7, sha256: createHash("sha256").update("fixture").digest("hex") };
    const complete = Object.fromEntries(["producer", "helper", "observer", "sdk", "oracle", "oracleLibraries", "syntaxOracle"]
      .map(key => [key, artifact]));
    const platform = "macos";
    const manifest = join(root, "candidate.json");
    const out = join(root, "out");
    const missingObserver = { ...complete }; delete missingObserver.observer;
    const missingAdapter = { ...complete }; delete missingAdapter.syntaxOracle;
    const badHash = { ...complete, producer: { ...artifact, sha256: "0".repeat(64) } };
    for (const artifacts of [missingObserver, missingAdapter, badHash]) {
      await writeFile(manifest, JSON.stringify({ schemaVersion: 1, sourceCommit: "a".repeat(40), platforms: { [platform]: artifacts } }));
      const rejection = await loadCandidate(manifest, platform).then(() => undefined, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(Error);
      expect(String(rejection)).toMatch(/expected object|artifact mismatch/);
      const nativePlatform = process.platform === "darwin" ? "macos" : "linux";
      await writeFile(manifest, JSON.stringify({ schemaVersion: 1, sourceCommit: "a".repeat(40), platforms: { [nativePlatform]: artifacts } }));
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "t00-ts7-q-syntax-campaign.ts"),
        "--candidate", manifest, "--platform", nativePlatform, "--out", out], { stdout: "pipe", stderr: "pipe" });
      expect(await child.exited).toBe(1);
      const supported = process.arch === "arm64" && ["darwin", "linux"].includes(process.platform);
      expect(await new Response(child.stderr).text()).toMatch(supported ? /expected object|artifact mismatch/ : /campaign requires the declared native ARM64 platform/);
      expect(await Bun.file(join(out, "results.json")).exists()).toBe(false);
    }
    const duplicate = Bun.spawn([process.execPath, join(import.meta.dir, "t00-ts7-q-syntax-campaign.ts"),
      "--candidate", manifest, "--candidate", manifest, "--platform", platform, "--out", out],
    { stdout: "pipe", stderr: "pipe" });
    expect(await duplicate.exited).not.toBe(0);
    expect(await new Response(duplicate.stderr).text()).toContain("expected --candidate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("campaign still refuses a mismatched execution platform before reading the candidate", async () => {
  const platform = process.platform === "darwin" ? "linux" : "macos";
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "t00-ts7-q-syntax-campaign.ts"),
    "--candidate", "absent.json", "--platform", platform, "--out", "unused"], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain("campaign requires the declared native ARM64 platform");
});
