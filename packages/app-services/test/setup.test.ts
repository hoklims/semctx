import { afterEach, describe, expect, it } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig, createGlobSelectionConfig } from "@semantic-context/core";
import { isInitialized, loadConfig, saveConfig } from "@semantic-context/repository-store";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import {
  SETUP_POLYGLOT_V1_REFUSE_NEXT_STEPS,
  SETUP_POLYGLOT_V1_REFUSE_REASON,
  SETUP_POLYGLOT_V1_REFUSE_REASON_CODE,
  buildPolyglotRequiresConfigV2Report,
  computeSetupReadiness,
  evaluatePolyglotSetupPolicy,
  planSetupRepository,
  setupRepository,
  type SetupPhaseEvent,
  type SetupRepositoryReport,
  type SetupRefusedReport,
  type SetupResult,
} from "../src/setup";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "semctx-test",
  GIT_AUTHOR_EMAIL: "semctx-test@example.com",
  GIT_COMMITTER_NAME: "semctx-test",
  GIT_COMMITTER_EMAIL: "semctx-test@example.com",
};

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: GIT_ENV,
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

/** Sample fixture with a git seal so analysis readiness is not UNSEALED/insufficient. */
function freshSample(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-setup-svc-"));
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
  });
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");
  return root;
}

function asSetup(report: SetupResult): SetupRepositoryReport {
  expect(report.kind).toBe("setup");
  return report as SetupRepositoryReport;
}

function asRefused(report: SetupResult): SetupRefusedReport {
  expect(report.kind).toBe("setup_refused");
  return report as SetupRefusedReport;
}

function coverageStatus(report: SetupRepositoryReport): string {
  const coverage = report.indexHealth.coverage as { status?: unknown };
  expect(typeof coverage?.status).toBe("string");
  return String(coverage.status);
}

function freshnessCanHigh(report: SetupRepositoryReport): boolean {
  const freshness = report.indexHealth.freshness as { canRunHighRiskControl?: unknown };
  expect(typeof freshness?.canRunHighRiskControl).toBe("boolean");
  return freshness.canRunHighRiskControl === true;
}

function bindingStatus(report: SetupRepositoryReport): string {
  const binding = report.indexHealth.binding as { status?: unknown };
  expect(typeof binding?.status).toBe("string");
  return String(binding.status);
}

describe("setupRepository (shared SSoT)", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("bootstraps a fresh workspace to SETUP_READY", () => {
    root = freshSample();
    const phases: SetupPhaseEvent[] = [];
    const report = asSetup(setupRepository(root, {
      now: "2026-08-01T12:00:00.000Z",
      onPhase: (event) => phases.push(event),
    }));
    expect(report.configWritten).toBe(true);
    expect(report.alreadyInitialized).toBe(false);
    expect(report.setupReady).toBe(true);
    expect(report.analysisReady).toBe(true);
    expect(report.verdict).toBe("SETUP_READY");
    expect(report.nodes).toBeGreaterThan(0);
    expect(report.semctxDir).toContain(".semctx");
    expect(coverageStatus(report)).toMatch(/^(complete|partial)$/);
    expect(isInitialized(root)).toBe(true);
    expect(existsSync(join(root, ".semctx", "config.json"))).toBe(true);
    expect(existsSync(join(root, ".semctx", "semantic", "goals.sem"))).toBe(true);
    // Policy-only on disk: machine root never versioned (#82).
    const onDisk = JSON.parse(readFileSync(join(root, ".semctx", "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(onDisk).not.toHaveProperty("repositoryRoot");
    expect(loadConfig(root).repositoryRoot).toBeTruthy();
    expect(phases.map((p) => p.phase)).toEqual([
      "config",
      "semantic",
      "index",
      "index",
      "check",
      "analysis",
    ]);
  });

  it("plans a fresh setup without writing or indexing", () => {
    root = freshSample();
    const before = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root, stdout: "pipe" });
    const report = planSetupRepository(root);
    expect(report.kind).toBe("setup_plan");
    if (report.kind !== "setup_plan") throw new Error("expected setup plan");
    expect(report.config.action).toBe("create");
    expect(report.plannedChanges).toContain(".semctx/config.json");
    expect(report.index).toEqual({ status: "not-run", reason: "dry-run" });
    expect(report.analysisReady).toBe("unknown");
    expect(report.setupReady).toBe("unknown");
    expect(existsSync(join(root, ".semctx"))).toBe(false);
    const after = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root, stdout: "pipe" });
    expect(new TextDecoder().decode(after.stdout)).toBe(new TextDecoder().decode(before.stdout));
  });

  it("dry plan rejects malformed existing config without changing it", () => {
    root = freshSample();
    const currentRoot = root;
    mkdirSync(join(currentRoot, ".semctx"), { recursive: true });
    const path = join(currentRoot, ".semctx", "config.json");
    writeFileSync(path, "{broken", "utf8");
    expect(() => planSetupRepository(currentRoot)).toThrow("config.json is not valid JSON");
    expect(readFileSync(path, "utf8")).toBe("{broken");
    expect(existsSync(join(currentRoot, ".semctx", "semctx.db"))).toBe(false);
  });

  it("dry plan rejects authored semantic syntax errors before config, scaffold, or index writes", () => {
    root = freshSample();
    const currentRoot = root;
    mkdirSync(join(currentRoot, ".semctx", "semantic", "changes"), { recursive: true });
    const authored = join(currentRoot, ".semctx", "semantic", "changes", "custom.sem");
    writeFileSync(authored, "not-a-semantic-block value\n", "utf8");

    expect(() => planSetupRepository(currentRoot)).toThrow("semantic model contains syntax errors");
    expect(readFileSync(authored, "utf8")).toBe("not-a-semantic-block value\n");
    expect(existsSync(join(currentRoot, ".semctx", "config.json"))).toBe(false);
    expect(existsSync(join(currentRoot, ".semctx", "semantic", "goals.sem"))).toBe(false);
    expect(existsSync(join(currentRoot, ".semctx", "semctx.db"))).toBe(false);
    expect(existsSync(join(currentRoot, ".gitignore"))).toBe(false);
  });

  it.each(["-wal", "-shm", "-journal"])("dry plan exercises the SQLite writer sidecar link guard: %s", (suffix) => {
    root = freshSample();
    const outside = mkdtempSync(join(tmpdir(), "semctx-setup-sidecar-outside-"));
    mkdirSync(join(root, ".semctx"), { recursive: true });
    symlinkSync(outside, join(root, ".semctx", `semctx.db${suffix}`), process.platform === "win32" ? "junction" : "dir");
    try {
      expect(() => planSetupRepository(root!)).toThrow("linked repository store files are unsupported");
      expect(existsSync(join(root, ".gitignore"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("fail-closes SETUP_READY on unsealed v1 (no version short-circuit)", () => {
    // Multi-cause NOT_READY (UNSEALED + typically insufficient). Restoring
    // `config.version !== 2 || …` would flip this fixture to SETUP_READY.
    root = mkdtempSync(join(tmpdir(), "semctx-setup-v1-unsealed-"));
    cpSync(SAMPLE_REPO, root, {
      recursive: true,
      filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
    });
    const report = asSetup(setupRepository(root, { now: "2026-08-01T12:00:00.000Z" }));
    expect(report.selection.configVersion).toBe(1);
    expect(coverageStatus(report)).toBe("insufficient");
    expect(freshnessCanHigh(report)).toBe(false);
    expect(report.analysisReady).toBe(false);
    expect(report.setupReady).toBe(false);
    expect(report.verdict).toBe("SETUP_NOT_READY");
  });

  it("fail-closes when only coverage is insufficient (sealed, high-risk freshness true)", () => {
    // Isolates the coverage conjunct: binding valid + canRunHighRiskControl true.
    root = mkdtempSync(join(tmpdir(), "semctx-setup-cov-only-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "value.py"), "def value():\n    return 1\n");
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "fixture");
    const base = createGlobSelectionConfig(root);
    saveConfig(root, {
      ...base,
      languages: { ...base.languages, python: "off" },
    });

    const report = asSetup(setupRepository(root, { now: "2026-08-01T12:00:00.000Z" }));
    expect(bindingStatus(report)).toBe("valid");
    expect(freshnessCanHigh(report)).toBe(true);
    expect(coverageStatus(report)).toBe("insufficient");
    expect(report.analysisReady).toBe(false);
    expect(report.setupReady).toBe(false);
    expect(report.verdict).toBe("SETUP_NOT_READY");
  });

  it("is idempotent on a second run", () => {
    root = freshSample();
    asSetup(setupRepository(root, { now: "2026-08-01T12:00:00.000Z" }));
    const second = asSetup(setupRepository(root, { now: "2026-08-01T12:00:01.000Z" }));
    expect(second.configWritten).toBe(false);
    expect(second.alreadyInitialized).toBe(true);
    expect(second.semanticFilesCreated).toBe(0);
    expect(second.verdict).toBe("SETUP_READY");
    expect(second.setupReady).toBe(true);
  });

  it("refuses polyglot against an existing v1 config without writing a v2 overwrite", () => {
    root = freshSample();
    saveConfig(root, createDefaultConfig(root));
    expect(isInitialized(root)).toBe(true);

    const report = asRefused(setupRepository(root, { polyglot: true, now: "2026-08-01T12:00:00.000Z" }));
    expect(report.reasonCode).toBe("POLYGLOT_REQUIRES_CONFIG_V2");
    expect(report.verdict).toBe("SETUP_REFUSED");
    expect(report.setupReady).toBe(false);
    expect(report.configVersion).toBe(1);
    expect(report.nextSteps.length).toBeGreaterThan(0);
    expect(report.reason).toMatch(/migrate/i);
    expect(loadConfig(root).version).toBe(1);
    // setupRepository must surface the pure policy constructor payload (no local drift).
    expect(report).toEqual(buildPolyglotRequiresConfigV2Report(root, 1));
  });

  it("evaluatePolyglotSetupPolicy owns predicate + full refuse payload (pure, no I/O)", () => {
    expect(evaluatePolyglotSetupPolicy({
      repositoryRoot: "/tmp/r",
      polyglot: false,
      alreadyInitialized: true,
      configVersion: 1,
    })).toBeNull();
    expect(evaluatePolyglotSetupPolicy({
      repositoryRoot: "/tmp/r",
      polyglot: true,
      alreadyInitialized: false,
      configVersion: 1,
    })).toBeNull();
    expect(evaluatePolyglotSetupPolicy({
      repositoryRoot: "/tmp/r",
      polyglot: true,
      alreadyInitialized: true,
      configVersion: 2,
    })).toBeNull();

    const refused = evaluatePolyglotSetupPolicy({
      repositoryRoot: "/tmp/r",
      polyglot: true,
      alreadyInitialized: true,
      configVersion: 1,
    });
    expect(refused).not.toBeNull();
    expect(refused).toEqual(buildPolyglotRequiresConfigV2Report("/tmp/r", 1));
    expect(refused!.reasonCode).toBe(SETUP_POLYGLOT_V1_REFUSE_REASON_CODE);
    expect(refused!.reason).toBe(SETUP_POLYGLOT_V1_REFUSE_REASON);
    expect(refused!.nextSteps).toEqual([...SETUP_POLYGLOT_V1_REFUSE_NEXT_STEPS]);
    expect(refused!.verdict).toBe("SETUP_REFUSED");

    // Non-v2 surface is not v1-only (predicate is version === 2, else refuse).
    const refusedOther = evaluatePolyglotSetupPolicy({
      repositoryRoot: "/tmp/r",
      polyglot: true,
      alreadyInitialized: true,
      configVersion: 99,
    });
    expect(refusedOther).toEqual(buildPolyglotRequiresConfigV2Report("/tmp/r", 99));
  });

  it("computeSetupReadiness isolates each conjunct (falsifying pure unit cases)", () => {
    const ready = {
      bindingStatus: "valid" as const,
      canRunHighRiskControl: true,
      coverageStatus: "partial" as const,
      checkOk: true,
    };
    expect(computeSetupReadiness(ready)).toEqual({
      analysisReady: true,
      setupReady: true,
      verdict: "SETUP_READY",
    });

    // Freshness only: deleting canRunHighRiskControl conjunct would flip this to READY.
    expect(computeSetupReadiness({ ...ready, canRunHighRiskControl: false })).toEqual({
      analysisReady: false,
      setupReady: false,
      verdict: "SETUP_NOT_READY",
    });

    // Binding only.
    expect(computeSetupReadiness({ ...ready, bindingStatus: "invalid" })).toEqual({
      analysisReady: false,
      setupReady: false,
      verdict: "SETUP_NOT_READY",
    });
    expect(computeSetupReadiness({ ...ready, bindingStatus: "absent" })).toEqual({
      analysisReady: false,
      setupReady: false,
      verdict: "SETUP_NOT_READY",
    });

    // Coverage only.
    expect(computeSetupReadiness({ ...ready, coverageStatus: "insufficient" })).toEqual({
      analysisReady: false,
      setupReady: false,
      verdict: "SETUP_NOT_READY",
    });

    // check.ok only: analysisReady true but setupReady false.
    expect(computeSetupReadiness({ ...ready, checkOk: false })).toEqual({
      analysisReady: true,
      setupReady: false,
      verdict: "SETUP_NOT_READY",
    });
  });

  it("reports SETUP_NOT_READY when semantic check fails with analysis otherwise ready", () => {
    root = freshSample();
    asSetup(setupRepository(root, { now: "2026-08-01T12:00:00.000Z" }));
    // Corrupt authored semantic after first READY so re-run keeps analysis green-ish but check fails.
    writeFileSync(
      join(root, ".semctx", "semantic", "goals.sem"),
      "goal g.broken not a valid semantic document\n",
      "utf8",
    );
    const report = asSetup(setupRepository(root, { now: "2026-08-01T12:00:01.000Z" }));
    expect(report.check.ok).toBe(false);
    expect(report.check.errors).toBeGreaterThan(0);
    expect(report.setupReady).toBe(false);
    expect(report.verdict).toBe("SETUP_NOT_READY");
    // analysisReady may still be true if health is fine — either way setupReady must be false.
    if (report.analysisReady) {
      expect(computeSetupReadiness({
        bindingStatus: bindingStatus(report) as "valid" | "invalid" | "absent",
        canRunHighRiskControl: freshnessCanHigh(report),
        coverageStatus: coverageStatus(report) as "complete" | "partial" | "insufficient",
        checkOk: false,
      }).setupReady).toBe(false);
    }
  });

  it("reports SETUP_NOT_READY when selected v2 language is disabled", () => {
    root = mkdtempSync(join(tmpdir(), "semctx-setup-not-ready-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "value.py"), "def value():\n    return 1\n");
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "fixture");

    const base = createGlobSelectionConfig(root);
    saveConfig(root, {
      ...base,
      languages: {
        ...base.languages,
        python: "off",
      },
    });

    const report = asSetup(setupRepository(root, { now: "2026-08-01T12:00:00.000Z" }));
    expect(report.setupReady).toBe(false);
    expect(report.analysisReady).toBe(false);
    expect(report.verdict).toBe("SETUP_NOT_READY");
    expect(coverageStatus(report)).toBe("insufficient");
  });
});
