import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultConfig,
  createGlobSelectionConfig,
  type SemctxConfig,
} from "@semantic-context/core";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import {
  controlAltitudeAuthority,
  controlStatus,
  indexHealth,
  indexRepository,
  queryControlDeletionAuthorization,
  runVerify,
  trustedControlSealHash,
} from "../src";
import { CONTROL_INDEX_SNAPSHOT_META_KEY } from "../src/freshness";

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", ...args],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

/** Both selection configurations, indexed identically. The downgrade must be non-authorizing at
 *  either version: v1 has no analysis-health preflight, so it is the version a config-scoped
 *  escape hatch would leave green. */
function repository(version: 1 | 2): string {
  const root = mkdtempSync(join(tmpdir(), `semctx-unproven-v${version}-`));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(
    join(root, "src", "service.ts"),
    "export function service(): number {\n  return 1;\n}\n",
  );
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");
  const config: SemctxConfig = version === 1
    ? createDefaultConfig(root)
    : { ...createGlobSelectionConfig(root), include: ["src/**/*.ts"] };
  initWorkspace(root, config);
  indexRepository(root, "2026-08-14T09:00:00.000Z");
  return root;
}

/**
 * Rewrite the sealed control snapshot as a schema-1 record: drop exactly the fields that carry the
 * Plane-A and unresolved-reference binding, and nothing else. Every other stored fact — graph hash,
 * head commit, analysis inputs — stays as indexing wrote it, so a surface that still reads FRESH
 * here is reading a snapshot that cannot prove its own binding, not a snapshot that drifted.
 */
function downgradeControlSnapshotToSchemaV1(root: string): void {
  const store = openStore(root);
  try {
    const raw = store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY);
    if (raw === undefined) throw new Error("fixture has no persisted control index snapshot");
    const snapshot = JSON.parse(raw) as Record<string, unknown>;
    expect(snapshot["schemaVersion"]).toBe(2);
    const {
      observedHunkIndexHash: _observed,
      attestationSetHash: _attestations,
      planeAIndexSnapshotHash: _planeA,
      ...legacy
    } = snapshot;
    store.setMeta(
      CONTROL_INDEX_SNAPSHOT_META_KEY,
      JSON.stringify({ ...legacy, schemaVersion: 1 }),
    );
  } finally {
    store.close();
  }
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

/** The exact post-image Codex forged: a value that is at no commit in this repository. */
const FORGED_DIFF = [
  "diff --git a/src/service.ts b/src/service.ts",
  "index 1111111..3333333 100644",
  "--- a/src/service.ts",
  "+++ b/src/service.ts",
  "@@ -2 +2 @@",
  "-  return 1;",
  "+  return 999;",
  "",
].join("\n");

function bindingFinding(root: string, source: Parameters<typeof runVerify>[1]): string {
  const computation = runVerify(root, source);
  expect(computation.result.verdict).toBe("BLOCK");
  const finding = computation.result.findings.find((item) => item.rule === "index_binding_stale");
  expect(finding).toBeDefined();
  expect(finding?.severity).toBe("block");
  return finding?.message ?? "";
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("a control snapshot that cannot prove its binding never authorizes", () => {
  for (const version of [1, 2] as const) {
    describe(`config v${version}`, () => {
      it("is refused by every surface at once, for the same cause", () => {
        const root = repository(version);

        const deletionQuery = {
          subject: "src/service.ts",
          planningCommit: `git:${git(root, "rev-parse", "HEAD")}`,
          evaluatedAt: "2026-08-14T09:30:00.000Z",
          attestationRequests: [],
        };

        // Precondition: the untouched index authorizes, and this exact query is not already being
        // refused for some unrelated reason. Without it the downgrade assertions below would also
        // pass against a fixture that was never authorizing to begin with.
        expect(controlStatus(root).canRunHighRiskControl).toBe(true);
        expect(indexHealth(root).binding.status).toBe("valid");
        expect(trustedControlSealHash(root)).toBeDefined();
        expect(queryControlDeletionAuthorization(root, deletionQuery).terminalStatus)
          .not.toBe("refused");
        expect(controlAltitudeAuthority(root, 0).allowsAutonomousWrite).toBe(true);

        downgradeControlSnapshotToSchemaV1(root);

        // 1. controlStatus — the surface that read FRESH.
        const status = controlStatus(root);
        expect(status.verdict).toBe("UNSEALED");
        expect(status.reasons).toEqual(["INDEX_SNAPSHOT_INVALID"]);

        // 2. canRunHighRiskControl — the authorizing bit itself.
        expect(status.canRunHighRiskControl).toBe(false);

        // 3. An authoritative Plane C query refuses rather than answering.
        const deletion = queryControlDeletionAuthorization(root, deletionQuery);
        expect(deletion.terminalStatus).toBe("refused");
        expect(deletion.reasonCodes).toEqual(["INDEX_STALE"]);
        expect(deletion.payload).toBeNull();

        // 4. No exact seal is handed out.
        expect(trustedControlSealHash(root)).toBeUndefined();

        // 5. indexHealth — the surface that already said invalid.
        const health = indexHealth(root);
        expect(health.binding.status).toBe("invalid");
        expect(health.freshness.canRunHighRiskControl).toBe(false);
        expect(health.freshness.verdict).toBe("UNSEALED");

        // 6. runVerify — the surface that already said BLOCK, and its exact cause.
        expect(bindingFinding(root, { kind: "working-tree" })).toContain(
          "UNRESOLVED_REFERENCE_SNAPSHOT_UNAUTHORIZED",
        );

        // 7. A second high-risk consumer withdraws autonomous authority for the exact freshness
        // cause. This uses a valid L0 authority request, so the assertion cannot pass because of an
        // unrelated missing change id or coordinate lookup failure.
        const authority = controlAltitudeAuthority(root, 0);
        expect(authority.freshness).toEqual({
          verdict: "UNSEALED",
          canRunHighRiskControl: false,
        });
        expect(authority.allowsAutonomousWrite).toBe(false);
        expect(authority.reasons).toContain("autonomous_write_withheld:freshness:UNSEALED");
      });
    });
  }
});

describe("a declared head is an attribution, not a provenance", () => {
  it("refuses a provided diff that attributes nothing", () => {
    const root = repository(1);

    expect(bindingFinding(root, { kind: "provided", diffText: DIFF })).toContain(
      "SOURCE_IDENTITY_ABSENT",
    );
  });

  it("refuses a file diff that attributes nothing", () => {
    const root = repository(1);
    const path = join(root, "supplied.diff");
    writeFileSync(path, DIFF);

    expect(bindingFinding(root, { kind: "file", path })).toContain("SOURCE_IDENTITY_ABSENT");
  });

  it("fails explicitly when the declared ref does not exist", () => {
    const root = repository(1);
    const path = join(root, "supplied.diff");
    writeFileSync(path, DIFF);

    expect(() => runVerify(root, { kind: "file", path, head: "no-such-ref" })).toThrow(
      'head ref "no-such-ref" does not exist locally.',
    );
    expect(() => runVerify(root, { kind: "provided", diffText: DIFF, head: "no-such-ref" })).toThrow(
      'head ref "no-such-ref" does not exist locally.',
    );
  });

  // The reproduction: the declared OID is the indexed commit and resolves cleanly, so every
  // coordinate check the gate can make is satisfied. Nothing ties the post-image to that commit.
  it("refuses a provided diff whose declared OID is correct but whose content is not at it", () => {
    const root = repository(1);
    const declaredCommit = git(root, "rev-parse", "HEAD");
    expect(git(root, "show", "HEAD:src/service.ts")).toContain("return 1;");

    const computation = runVerify(root, { kind: "provided", diffText: FORGED_DIFF, head: "HEAD" });
    const finding = computation.result.findings.find((item) => item.rule === "index_binding_stale");

    expect(computation.result.verdict).toBe("BLOCK");
    expect(computation.report.head).toBe(declaredCommit);
    expect(finding?.message).toContain("SOURCE_IDENTITY_UNPROVEN");
    // The declared OID *is* the indexed commit, so a commit-mismatch reason would be the wrong
    // diagnosis and would let a caller "fix" the block by re-attributing the diff.
    expect(finding?.message).not.toContain("ANALYZED_COMMIT_MISMATCH");
  });

  it("refuses a file diff whose declared OID is correct but whose content is not at it", () => {
    const root = repository(1);
    const path = join(root, "supplied.diff");
    writeFileSync(path, FORGED_DIFF);

    const message = bindingFinding(root, { kind: "file", path, head: "HEAD" });

    expect(message).toContain("SOURCE_IDENTITY_UNPROVEN");
  });

  it("still names the commit mismatch when the declared OID is also the wrong one", () => {
    const root = repository(1);
    const path = join(root, "supplied.diff");
    writeFileSync(path, DIFF);
    git(root, "commit", "-q", "--allow-empty", "-m", "later");
    git(root, "tag", "later");
    git(root, "reset", "-q", "--hard", "HEAD~1");

    const message = bindingFinding(root, { kind: "file", path, head: "later" });

    expect(message).toContain("SOURCE_IDENTITY_UNPROVEN");
    expect(message).toContain("ANALYZED_COMMIT_MISMATCH");
  });

  // Absence of one reason code is not the property under test: the verdict must be blocking and
  // no impact conclusion may survive it.
  it("leaves no authorizing residue behind the block", () => {
    const root = repository(1);

    const computation = runVerify(root, { kind: "provided", diffText: FORGED_DIFF, head: "HEAD" });

    expect(computation.result.verdict).toBe("BLOCK");
    expect(computation.report.verdict).toBe("BLOCK");
    expect(computation.result.unknowns.join("\n")).toContain("SOURCE_IDENTITY_UNPROVEN");
  });

  // The invariant the fix must not trade away: a working diff taken in place is still verifiable.
  it("does not block a normal working-tree diff", () => {
    const root = repository(1);
    writeFileSync(
      join(root, "src", "service.ts"),
      "export function service(): number {\n  return 2;\n}\n",
    );

    const computation = runVerify(root, { kind: "working-tree" });

    expect(computation.result.findings.map((finding) => finding.rule)).not.toContain(
      "index_binding_stale",
    );
  });
});
