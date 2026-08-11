import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", ...args],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

/** A v1-config repository indexed at its first commit. v1 is deliberate: the analysis-health
 *  preflight is gated on `config.version === 2`, so this fixture has no other freshness guard. */
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-verify-index-binding-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(join(root, "src", "service.ts"), "export function service(): number {\n  return 1;\n}\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");
  initWorkspace(root, createDefaultConfig(root));
  indexRepository(root, "2026-08-11T11:00:00.000Z");
  return root;
}

const DIFF = [
  "diff --git a/src/service.ts b/src/service.ts",
  "index 1111111..2222222 100644",
  "--- a/src/service.ts",
  "+++ b/src/service.ts",
  "@@ -2 +2 @@",
  "-  return 1;",
  "+  return 2;",
  "",
].join("\n");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("index binding gate", () => {
  it("passes while the index is still bound to HEAD", () => {
    const root = repository();

    const computation = runVerify(root, { kind: "provided", diffText: DIFF });

    expect(computation.result.findings.map((finding) => finding.rule)).not.toContain(
      "index_binding_stale",
    );
  });

  // Impacted nodes are a join between line ranges frozen at indexing time and hunks measured
  // against the current HEAD. Once HEAD moves, that join silently mixes two coordinate systems.
  it("blocks once HEAD moves away from the indexed commit", () => {
    const root = repository();
    git(root, "commit", "-q", "--allow-empty", "-m", "move HEAD past the indexed commit");

    const computation = runVerify(root, { kind: "provided", diffText: DIFF });

    expect(computation.result.verdict).toBe("BLOCK");
    expect(computation.result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "index_binding_stale",
          severity: "block",
          message: expect.stringContaining("HEAD_MISMATCH"),
        }),
      ]),
    );
  });

  // The gate must stay narrow. A reason that does not invalidate a line range must never block,
  // or a repository whose semantic lifecycle is momentarily invalid would be unable to run the
  // very command that repairs it — and `semctx index` refuses a stale evidence baseline, so the
  // two would deadlock.
  it("records an unknown but never blocks on a reason that preserves coordinates", () => {
    const root = repository();
    writeFileSync(
      join(root, ".semctx", "verification-state.json"),
      `${JSON.stringify(
        {
          version: 2,
          headCommit: "0000000000000000000000000000000000000000",
          workingStateHash: `sha256:${"0".repeat(64)}`,
          verdict: "PASS",
          recordedAt: "2026-08-11T10:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );

    const computation = runVerify(root, { kind: "provided", diffText: DIFF });

    expect(computation.result.verdict).not.toBe("BLOCK");
    expect(computation.result.findings.map((finding) => finding.rule)).not.toContain(
      "index_binding_stale",
    );
    expect(computation.result.unknowns.join("\n")).toContain("index binding");
  });
});
