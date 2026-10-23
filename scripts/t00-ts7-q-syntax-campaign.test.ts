import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("campaign refuses incomplete, altered and ambiguously selected candidates before writing a result", async () => {
  const root = await mkdtemp(join(tmpdir(), "t00-ts7-q-syntax-preflight-"));
  try {
    const binary = join(root, "artifact");
    await writeFile(binary, "fixture");
    const artifact = { path: binary, bytes: 7, sha256: createHash("sha256").update("fixture").digest("hex") };
    const complete = Object.fromEntries(["producer", "helper", "observer", "sdk", "oracle", "oracleLibraries", "syntaxOracle"]
      .map(key => [key, artifact]));
    const platform = process.platform === "darwin" ? "macos" : "linux";
    const manifest = join(root, "candidate.json");
    const out = join(root, "out");
    const missingObserver = { ...complete }; delete missingObserver.observer;
    const missingAdapter = { ...complete }; delete missingAdapter.syntaxOracle;
    const badHash = { ...complete, producer: { ...artifact, sha256: "0".repeat(64) } };
    for (const artifacts of [missingObserver, missingAdapter, badHash]) {
      await writeFile(manifest, JSON.stringify({ schemaVersion: 1, sourceCommit: "a".repeat(40), platforms: { [platform]: artifacts } }));
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "t00-ts7-q-syntax-campaign.ts"),
        "--candidate", manifest, "--platform", platform, "--out", out], { stdout: "pipe", stderr: "pipe" });
      expect(await child.exited).not.toBe(0);
      expect(await new Response(child.stderr).text()).toMatch(/expected object|artifact mismatch/);
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
