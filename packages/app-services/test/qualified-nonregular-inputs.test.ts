import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createGlobSelectionConfig, SemctxError } from "@semantic-context/core";
import { captureQualifiedAnalysisInputs } from "../src/freshness";

for (const kind of ["socket", "fifo"] as const) test.skipIf(process.platform === "win32")(`qualified input refuses real Unix ${kind} before reading`, async () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-nonregular-")); const path = join(root, "events.json");
  const server = createServer(); let listening = false;
  try {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0);
    if (kind === "socket") {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { listening = true; resolve(); }); });
      expect(statSync(path).isSocket()).toBe(true);
    } else {
      expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0); expect(statSync(path).isFIFO()).toBe(true);
    }
    expect(statSync(path).isFile()).toBe(false);
    const config = { ...createGlobSelectionConfig(root), analysisProfile: "modelo-suite-static-v1" as const, selectionMode: "qualified-static-v1" as const };
    let observed: unknown;
    try { captureQualifiedAnalysisInputs(config); } catch (error) { observed = error; }
    expect(observed).toBeInstanceOf(SemctxError);
    expect((observed as SemctxError).code).toBe("INVALID_TASK_INPUT");
    expect((observed as Error).message).toContain("regular file");
  } finally {
    if (listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
