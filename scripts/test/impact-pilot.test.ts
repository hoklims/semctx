import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractRelativeImportSpecifiers, oneHopImportNeighborhoodBaseline, type ImportGraphFile } from "../pilot/baselines";
import { runBounded, TIMED_OUT_EXIT_CODE } from "../pilot/child";
import {
  baselineInputDigest,
  baselineOutputDigest,
  collectCases,
  parseVerifyReport,
  toolOutputDigest,
  validateLocalSourcesFile,
  validateRawCollectionBundle,
  type RawCollectionBundleV1,
} from "../pilot/collect";
import { canonicalJson, digestCanonical } from "../pilot/digest";
import {
  freezeProtocol,
  resolveRunnerIdentity,
  validateDraftProtocol,
  validateFrozenProtocol,
  type CorpusCaseSpec,
  type DraftProtocolInput,
  type FrozenProtocolV1,
  type LabelStatus,
} from "../pilot/protocol";
import { buildPublicSummary, buildResultReport, scoreTool } from "../pilot/report";
import { parseFlags } from "../pilot/cli-args";
import { writeJsonExclusive } from "../impact-pilot";

const temporaryDirectories: string[] = [];
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirectories.push(dir);
  return dir;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function runImpactPilotCli(cwd: string, args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "impact-pilot.ts"), ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

const HEX_BASE = "a".repeat(40);
function hexHead(i: number): string {
  const hex = i.toString(16);
  return `b${"0".repeat(39 - hex.length)}${hex}`;
}

// --- a stand-in candidate CLI: real subprocess, real git, canned analysis result ---
const STUB_CANDIDATE_SOURCE = `
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const rootFlag = args.indexOf("--root");
const root = rootFlag >= 0 ? args[rootFlag + 1] : process.env.SEMCTX_ROOT ?? process.cwd();
function mutateCheckout(stage) {
  const mode = process.env.SEMCTX_PILOT_TEST_MUTATE_CHECKOUT;
  if (mode === "tracked:" + stage) writeFileSync(root + "/src/critical.ts", "export const value = 999;\\n");
  if (mode === "staged:" + stage) {
    writeFileSync(root + "/src/critical.ts", "export const value = 999;\\n");
    Bun.spawnSync(["git", "add", "--", "src/critical.ts"], { cwd: root });
  }
  if (mode === "index-flags:" + stage) Bun.spawnSync(["git", "update-index", "--assume-unchanged", "src/critical.ts"], { cwd: root });
  if (mode === "untracked:" + stage || mode === "ignored:" + stage) writeFileSync(root + "/src/injected.ts", "export const injected = true;\\n");
  if (mode === "head:" + stage) {
    Bun.spawnSync(["git", "-c", "user.name=pilot test", "-c", "user.email=pilot@example.invalid", "commit", "--allow-empty", "-m", "candidate moved head"], { cwd: root });
  }
}
if (args[0] === "init") {
  mkdirSync(root + "/.semctx", { recursive: true });
  writeFileSync(root + "/.semctx/stub-marker", "initialized");
  if (process.env.SEMCTX_PILOT_TEST_GITIGNORE === "canonical") {
    writeFileSync(root + "/.gitignore", "node_modules\\n.semctx/*\\n!.semctx/semantic/\\n!.semctx/semantic/**\\n!.semctx/config.json\\n");
  }
  if (process.env.SEMCTX_PILOT_TEST_GITIGNORE === "canonical-missing") {
    writeFileSync(root + "/.gitignore", ".semctx/*\\n!.semctx/semantic/\\n!.semctx/semantic/**\\n!.semctx/config.json\\n");
  }
  if (process.env.SEMCTX_PILOT_TEST_GITIGNORE === "poison") writeFileSync(root + "/.gitignore", "*\\n");
  mutateCheckout("init");
  if (process.env.SEMCTX_PILOT_TEST_MUTATE_SELF === "1") appendFileSync(import.meta.path, "\\n// mutated during collection\\n");
  process.exit(0);
}
if (args[0] === "index") { mutateCheckout("index"); process.exit(0); }
if (args[0] === "verify" && args[1] === "diff") {
  const base = args[args.indexOf("--base") + 1];
  const head = args[args.indexOf("--head") + 1];
  const merge = Bun.spawnSync(["git", "merge-base", "--", base, head], { cwd: root, stdout: "pipe" });
  const mergeBase = new TextDecoder().decode(merge.stdout).trim();
  const diff = Bun.spawnSync(["git", "diff", "--name-only", mergeBase, head], { cwd: root, stdout: "pipe" });
  const changedFiles = new TextDecoder().decode(diff.stdout).trim().split("\\n").filter(Boolean).sort();
  mutateCheckout("verify");
  const blocks = changedFiles.includes("src/critical.ts");
  const report = {
    schemaVersion: 1, verdict: blocks ? "BLOCK" : "PASS", base, head, mergeBase,
    range: mergeBase.slice(0, 12) + ".." + head.slice(0, 12),
    changedFiles, changedSymbols: [], impactedContracts: [], impactedInvariants: [],
    recommendedTests: [], contradictions: [], unknowns: [],
    findings: blocks ? [{
      rule: "fixture-block", tier: "strict", severity: "block", message: "fixture block", nodeIds: [], locations: [],
    }] : [],
    summary: { blockCount: blocks ? 1 : 0, warnCount: 0 },
  };
  console.log(JSON.stringify(report));
  process.exit(blocks ? 3 : 0);
}
process.exit(1);
`;

function makeFixtureRepoRoot(): string {
  const root = tempDir("semctx-pilot-fixture-repo-");
  mkdirSync(join(root, "apps", "cli", "src"), { recursive: true });
  mkdirSync(join(root, "scripts", "pilot"), { recursive: true });
  mkdirSync(join(root, "node_modules", "typescript", "lib"), { recursive: true });
  mkdirSync(join(root, "packages", "core", "src"), { recursive: true });
  mkdirSync(join(root, "packages", "semantic-engine", "src"), { recursive: true });
  mkdirSync(join(root, "packages", "core", "node_modules", "zod", "v3"), { recursive: true });
  writeFileSync(join(root, "apps", "cli", "package.json"), JSON.stringify({ name: "semctx-fixture", version: "0.0.1" }));
  writeFileSync(join(root, "apps", "cli", "src", "index.ts"), STUB_CANDIDATE_SOURCE);
  writeFileSync(join(root, "scripts", "impact-pilot.ts"), "// fixture placeholder\n");
  writeFileSync(join(root, "node_modules", "typescript", "package.json"), JSON.stringify({ name: "typescript", version: "0.0.0" }));
  writeFileSync(join(root, "node_modules", "typescript", "lib", "typescript.js"), "// fixture typescript runtime\n");
  writeFileSync(join(root, "packages", "core", "src", "verify-report.ts"), 'import { z } from "zod";\nexport const VerifyReportSchema = z.object({});\n');
  writeFileSync(join(root, "packages", "semantic-engine", "src", "gitignore.ts"), "export const computeGitignore = () => ({ content: '', changed: false });\n");
  writeFileSync(join(root, "packages", "core", "package.json"), JSON.stringify({
    name: "@semantic-context/core",
    type: "module",
    dependencies: { zod: "^3.23.8" },
  }));
  writeFileSync(join(root, "packages", "core", "node_modules", "zod", "package.json"), JSON.stringify({
    name: "zod",
    version: "3.25.76",
    type: "module",
    main: "./index.cjs",
    module: "./index.js",
    exports: { ".": { import: "./index.js", require: "./index.cjs" } },
  }));
  writeFileSync(join(root, "packages", "core", "node_modules", "zod", "index.js"), 'export * from "./v3/external.js";\n');
  writeFileSync(join(root, "packages", "core", "node_modules", "zod", "index.cjs"), 'module.exports = require("./v3/external.cjs");\n');
  writeFileSync(join(root, "packages", "core", "node_modules", "zod", "v3", "external.js"), "export const z = {};\n");
  writeFileSync(join(root, "packages", "core", "node_modules", "zod", "v3", "external.cjs"), "exports.z = {};\n");
  return root;
}

function makeSourceRepo(trackedGitignore: boolean | string = false): { cwd: string; base: string; head: string } {
  const cwd = tempDir("semctx-pilot-source-");
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "pilot@example.invalid"]);
  git(cwd, ["config", "user.name", "pilot test"]);
  mkdirSync(join(cwd, "src"), { recursive: true });
  if (trackedGitignore) writeFileSync(join(cwd, ".gitignore"), typeof trackedGitignore === "string" ? trackedGitignore : "node_modules\n");
  writeFileSync(join(cwd, "src", "critical.ts"), "export const value = 1;\n");
  writeFileSync(join(cwd, "src", "consumer.ts"), 'import { value } from "./critical";\nexport const doubled = value * 2;\n');
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "base"]);
  const base = git(cwd, ["rev-parse", "HEAD"]);
  writeFileSync(join(cwd, "src", "critical.ts"), "export const value = 2;\n");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "head"]);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  return { cwd, base, head };
}

function makeDivergedSourceRepo(): { cwd: string; base: string; head: string; mergeBase: string } {
  const cwd = tempDir("semctx-pilot-diverged-source-");
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "pilot@example.invalid"]);
  git(cwd, ["config", "user.name", "pilot test"]);
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "critical.ts"), "export const value = 1;\n");
  writeFileSync(join(cwd, "src", "consumer.ts"), 'import { value } from "./critical";\nexport const doubled = value * 2;\n');
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "common"]);
  const mergeBase = git(cwd, ["rev-parse", "HEAD"]);
  git(cwd, ["checkout", "-q", "-b", "base-side"]);
  writeFileSync(join(cwd, "src", "base-only.ts"), "export const baseOnly = true;\n");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "base side"]);
  const base = git(cwd, ["rev-parse", "HEAD"]);
  git(cwd, ["checkout", "-q", "--detach", mergeBase]);
  writeFileSync(join(cwd, "src", "critical.ts"), "export const value = 2;\n");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "head side"]);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  return { cwd, base, head, mergeBase };
}

function baseDraft(overrides: Partial<DraftProtocolInput["config"]> = {}): DraftProtocolInput["config"] {
  return {
    perCaseTimeoutMs: 30_000,
    baselines: ["changed-files", "one-hop-import-neighborhood"],
    selection: { rule: "manual", note: "fixture" },
    ...overrides,
  };
}

function makeCase(caseId: string, repositoryAlias: string, label: LabelStatus, extra: Partial<CorpusCaseSpec> = {}): CorpusCaseSpec {
  return {
    caseId,
    repositoryAlias,
    synthetic: false,
    publicSource: null,
    baseRef: HEX_BASE,
    headRef: hexHead(1),
    changedFiles: [],
    split: "dev",
    label,
    ...extra,
  };
}

/** Builds a syntactically valid frozen protocol without going through freeze()'s filesystem identity resolution. */
function makeFrozenProtocolFixture(corpus: FrozenProtocolV1["corpus"]): FrozenProtocolV1 {
  const withoutDigest = {
    schemaVersion: 1 as const,
    experimentId: "impact-pilot-test-fixture",
    createdAt: "2026-09-08T00:00:00.000Z",
    candidate: {
      packaging: "dist" as const,
      entryPath: "apps/cli/dist/index.js",
      entryDigest: `sha256:${"0".repeat(64)}`,
      packageName: "semctx",
      packageVersion: "0.0.0",
      bunVersion: "1.4.0",
      bunExecutableDigest: `sha256:${"2".repeat(64)}`,
      supportFiles: [],
    },
    runner: {
      entryPath: "scripts/impact-pilot.ts",
      entryDigest: `sha256:${"1".repeat(64)}`,
      toolSchemaVersion: 1 as const,
      supportFiles: [],
    },
    config: baseDraft(),
    corpus,
  };
  return { ...withoutDigest, digest: digestCanonical(withoutDigest) };
}

function researchCorpus(labels: readonly LabelStatus[], reposCount = 3): FrozenProtocolV1["corpus"] {
  const cases = labels.map((label, i) => makeCase(`case-${i}`, `repo-${i % reposCount}`, label, { headRef: hexHead(i + 1) }));
  return { kind: "research", cases };
}

// ============================================================================================
// draft / freeze structural validation
// ============================================================================================

describe("draft protocol structural validation", () => {
  test("accepts a minimal synthetic-smoke draft", () => {
    const draft = validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase("s-1", "repo-fixture", { status: "UNKNOWN" }, { synthetic: true })] },
    });
    expect(draft.corpus.cases).toHaveLength(1);
  });

  test("rejects a research corpus with fewer than 30 cases", () => {
    expect(() =>
      validateDraftProtocol({
        schemaVersion: 1,
        candidate: { packaging: "dist" },
        config: baseDraft(),
        corpus: researchCorpus(Array.from({ length: 5 }, () => ({ status: "UNKNOWN" }) as LabelStatus)),
      }),
    ).toThrow(/>= 30 cases/);
  });

  test("rejects a research corpus spanning fewer than 3 repositories", () => {
    expect(() =>
      validateDraftProtocol({
        schemaVersion: 1,
        candidate: { packaging: "dist" },
        config: baseDraft(),
        corpus: researchCorpus(Array.from({ length: 30 }, () => ({ status: "UNKNOWN" }) as LabelStatus), 1),
      }),
    ).toThrow(/>= 3 distinct repositories/);
  });

  test("rejects a synthetic case inside a research corpus (invariant 2: synthetic never counts as real evidence)", () => {
    const corpus = researchCorpus(Array.from({ length: 30 }, () => ({ status: "UNKNOWN" }) as LabelStatus));
    (corpus.cases as CorpusCaseSpec[])[0]!.synthetic = true;
    expect(() =>
      validateDraftProtocol({ schemaVersion: 1, candidate: { packaging: "dist" }, config: baseDraft(), corpus }),
    ).toThrow(/is synthetic/);
  });

  test("rejects a non-synthetic case inside a synthetic-smoke corpus", () => {
    expect(() =>
      validateDraftProtocol({
        schemaVersion: 1,
        candidate: { packaging: "dist" },
        config: baseDraft(),
        corpus: { kind: "synthetic-smoke", cases: [makeCase("s-1", "repo-fixture", { status: "UNKNOWN" })] },
      }),
    ).toThrow(/not marked synthetic/);
  });

  test("rejects duplicate caseIds", () => {
    expect(() =>
      validateDraftProtocol({
        schemaVersion: 1,
        candidate: { packaging: "dist" },
        config: baseDraft(),
        corpus: {
          kind: "synthetic-smoke",
          cases: [
            makeCase("dup", "repo-a", { status: "UNKNOWN" }, { synthetic: true }),
            makeCase("dup", "repo-b", { status: "UNKNOWN" }, { synthetic: true, headRef: hexHead(2) }),
          ],
        },
      }),
    ).toThrow(/duplicate caseId/);
  });

  test("rejects an unknown field (governed input, ADR 0019)", () => {
    expect(() =>
      validateDraftProtocol({
        schemaVersion: 1,
        candidate: { packaging: "dist" },
        config: baseDraft(),
        corpus: { kind: "synthetic-smoke", cases: [], extraField: true },
      }),
    ).toThrow(/unknown field/);
  });

  test("rejects a critical file absent from expectedImpactedFiles", () => {
    expect(() =>
      validateDraftProtocol({
        schemaVersion: 1,
        candidate: { packaging: "dist" },
        config: baseDraft(),
        corpus: {
          kind: "synthetic-smoke",
          cases: [
            makeCase("s-1", "repo-a", {
              status: "LABELLED",
              provenance: "automated-review",
              expectedImpactedFiles: ["a.ts"],
              criticalFiles: ["b.ts"],
            }, { synthetic: true }),
          ],
        },
      }),
    ).toThrow(/not also in expectedImpactedFiles/);
  });

  test("rejects source-dev packaging for research evidence", () => {
    expect(() => validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: researchCorpus(Array.from({ length: 30 }, () => ({ status: "UNKNOWN" }) as LabelStatus)),
    })).toThrow(/research protocols require "dist"/);
  });
});

describe("strict CLI flags", () => {
  test("rejects unknown and duplicate options", () => {
    expect(() => parseFlags(["--unknown"], ["input"])).toThrow(/unknown option/);
    expect(() => parseFlags(["--input", "a", "--input", "b"], ["input"])).toThrow(/duplicate option/);
  });
});

describe("freeze: candidate/runner identity binding", () => {
  test("freezes and round-trips through validateFrozenProtocol", () => {
    const repoRoot = makeFixtureRepoRoot();
    const draft = validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase("s-1", "repo-fixture", { status: "UNKNOWN" }, { synthetic: true })] },
    });
    const frozen = freezeProtocol(draft, repoRoot);
    expect(frozen.candidate.packageName).toBe("semctx-fixture");
    expect(frozen.candidate.entryDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const reparsed = validateFrozenProtocol(JSON.parse(JSON.stringify(frozen)));
    expect(reparsed.digest).toBe(frozen.digest);
  });

  test("refuses a frozen protocol whose digest was hand-edited after the fact", () => {
    const repoRoot = makeFixtureRepoRoot();
    const draft = validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase("s-1", "repo-fixture", { status: "UNKNOWN" }, { synthetic: true })] },
    });
    const frozen = freezeProtocol(draft, repoRoot);
    const tampered = { ...frozen, config: { ...frozen.config, perCaseTimeoutMs: frozen.config.perCaseTimeoutMs + 1 } };
    expect(() => validateFrozenProtocol(tampered)).toThrow(/does not match recomputed/);
  });

  test("throws when packaging \"dist\" is requested but the build artifact is missing", () => {
    const repoRoot = makeFixtureRepoRoot();
    const draft = validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "dist" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase("s-1", "repo-fixture", { status: "UNKNOWN" }, { synthetic: true })] },
    });
    expect(() => freezeProtocol(draft, repoRoot)).toThrow(/not readable/);
  });

  test("binds every file in the built dist support tree", () => {
    const repoRoot = makeFixtureRepoRoot();
    mkdirSync(join(repoRoot, "apps", "cli", "dist", "typescript"), { recursive: true });
    writeFileSync(join(repoRoot, "apps", "cli", "dist", "index.js"), "// bundled cli\n");
    writeFileSync(join(repoRoot, "apps", "cli", "dist", "semctx-index-worker.js"), "// worker\n");
    writeFileSync(join(repoRoot, "apps", "cli", "dist", "typescript", "lib.d.ts"), "declare const x: number;\n");
    const frozen = freezeProtocol(validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "dist" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase("s-1", "repo-fixture", { status: "UNKNOWN" }, { synthetic: true })] },
    }), repoRoot);
    expect(frozen.candidate.supportFiles.map((file) => file.path)).toEqual([
      "apps/cli/dist/semctx-index-worker.js",
      "apps/cli/dist/typescript/lib.d.ts",
      "apps/cli/package.json",
    ]);
  });

  test("binds runner support-module changes into the frozen identity", () => {
    const repoRoot = makeFixtureRepoRoot();
    writeFileSync(join(repoRoot, "scripts", "pilot", "helper.ts"), "export const value = 1;\n");
    const frozen = freezeProtocol(validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase("s-1", "repo-fixture", { status: "UNKNOWN" }, { synthetic: true })] },
    }), repoRoot);
    expect(frozen.runner.supportFiles.map((file) => file.path)).toEqual([
      "node_modules/typescript/lib/typescript.js",
      "node_modules/typescript/package.json",
      "packages/core/node_modules/zod/index.cjs",
      "packages/core/node_modules/zod/index.js",
      "packages/core/node_modules/zod/package.json",
      "packages/core/node_modules/zod/v3/external.cjs",
      "packages/core/node_modules/zod/v3/external.js",
      "packages/core/package.json",
      "packages/core/src/verify-report.ts",
      "packages/semantic-engine/src/gitignore.ts",
      "scripts/pilot/helper.ts",
    ]);
  });

  test("changes runner identity when a bound source dependency or resolved runtime drifts", () => {
    const repoRoot = makeFixtureRepoRoot();
    const original = digestCanonical(resolveRunnerIdentity(repoRoot));
    const gitignorePath = join(repoRoot, "packages", "semantic-engine", "src", "gitignore.ts");
    writeFileSync(gitignorePath, `${readFileSync(gitignorePath, "utf8")}\n// gitignore policy drift\n`);
    const gitignoreDrifted = digestCanonical(resolveRunnerIdentity(repoRoot));
    expect(gitignoreDrifted).not.toBe(original);

    const schemaPath = join(repoRoot, "packages", "core", "src", "verify-report.ts");
    writeFileSync(schemaPath, `${readFileSync(schemaPath, "utf8")}\n// schema drift\n`);
    const schemaDrifted = digestCanonical(resolveRunnerIdentity(repoRoot));
    expect(schemaDrifted).not.toBe(gitignoreDrifted);

    const zodRuntimePath = join(repoRoot, "packages", "core", "node_modules", "zod", "v3", "external.js");
    writeFileSync(zodRuntimePath, `${readFileSync(zodRuntimePath, "utf8")}\n// runtime drift\n`);
    expect(digestCanonical(resolveRunnerIdentity(repoRoot))).not.toBe(schemaDrifted);
  });
});

describe("canonical digest", () => {
  test("preserves an own __proto__ member", () => {
    const value = JSON.parse('{"normal":1,"__proto__":{"polluted":true}}');
    expect(canonicalJson(value)).toBe('{"__proto__":{"polluted":true},"normal":1}');
    expect(digestCanonical(value)).not.toBe(digestCanonical({ normal: 1 }));
  });
});

// ============================================================================================
// collect(): real subprocess, real git, confinement
// ============================================================================================

describe("collect: real process observation and confinement", () => {
  test.each(["repository-routing", "external-index"] as const)("ignores ambient %s for Git and the real candidate child", (mode) => {
    const repoRoot = makeFixtureRepoRoot();
    const source = makeSourceRepo();
    const sentinel = makeSourceRepo();
    const externalIndex = join(sentinel.cwd, "outside-index");
    const inheritedRoot = tempDir("semctx-pilot-routing-root-");
    const poison: Record<string, string> = {
      GIT_INDEX_FILE: externalIndex,
      SEMCTX_ROOT: inheritedRoot,
      gIt_UnReGiStErEd_RoUtInG: "must-not-reach-child",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.worktree",
      GIT_CONFIG_VALUE_0: sentinel.cwd,
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: sentinel.cwd,
    };
    if (mode === "repository-routing") Object.assign(poison, {
      GIT_DIR: join(sentinel.cwd, ".git"),
      GIT_WORK_TREE: sentinel.cwd,
      GIT_COMMON_DIR: join(sentinel.cwd, ".git"),
      GIT_OBJECT_DIRECTORY: join(sentinel.cwd, ".git", "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(sentinel.cwd, ".git", "objects"),
    });
    const forbidden = Object.keys(poison).filter(key => !["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"].includes(key));
    const probe = `
const forbiddenEnvironmentKeys = ${JSON.stringify(forbidden)};
if (Object.keys(process.env).some(key => forbiddenEnvironmentKeys.some(name => name.toUpperCase() === key.toUpperCase()))) {
  console.error("ambient repository routing reached the candidate"); process.exit(72);
}
`;
    writeFileSync(join(repoRoot, "apps", "cli", "src", "index.ts"), probe + STUB_CANDIDATE_SOURCE);
    const protocol = freezeProtocol(validateDraftProtocol({
      schemaVersion: 1, candidate: { packaging: "source-dev" }, config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase(
        "case-1", "fixture-repo", { status: "UNKNOWN" },
        { synthetic: true, baseRef: source.base, headRef: source.head, changedFiles: ["src/critical.ts"] },
      )] },
    }), repoRoot);
    const before = [source, sentinel].map(repo => readFileSync(join(repo.cwd, ".git", "index")));
    const savedEnvironment = Object.entries(process.env).filter(([key]) => Object.keys(poison).some(name => name.toUpperCase() === key.toUpperCase()));
    let bundle: RawCollectionBundleV1;
    try {
      for (const [key] of savedEnvironment) delete process.env[key];
      Object.assign(process.env, poison);
      bundle = collectCases(protocol, validateLocalSourcesFile({ schemaVersion: 1, paths: { "case-1": source.cwd } }), repoRoot);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (Object.keys(poison).some(name => name.toUpperCase() === key.toUpperCase())) delete process.env[key];
      }
      for (const [key, value] of savedEnvironment) process.env[key] = value;
    }
    expect(bundle.cases[0]).toMatchObject({ status: "OBSERVED", changedFiles: ["src/critical.ts"], semctx: { verificationStatus: "TRUSTED" } });
    expect(existsSync(externalIndex)).toBe(false);
    expect(existsSync(join(inheritedRoot, ".semctx"))).toBe(false);
    for (const [index, repo] of [source, sentinel].entries()) {
      expect(readFileSync(join(repo.cwd, ".git", "index"))).toEqual(before[index]!);
      expect(git(repo.cwd, ["rev-parse", "HEAD"])).toBe(repo.head);
      expect(git(repo.cwd, ["status", "--porcelain"])).toBe("");
      expect(existsSync(join(repo.cwd, ".semctx"))).toBe(false);
    }
  }, 60_000);

  test("observes a real case end to end and never mutates the source repository", () => {
    const repoRoot = makeFixtureRepoRoot();
    const source = makeSourceRepo();
    const corpus: FrozenProtocolV1["corpus"] = {
      kind: "synthetic-smoke",
      cases: [
        makeCase(
          "case-1",
          "fixture-repo",
          { status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["src/critical.ts"], criticalFiles: ["src/critical.ts"] },
          { synthetic: true, baseRef: source.base, headRef: source.head, changedFiles: ["src/critical.ts"] },
        ),
      ],
    };
    const draft = validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus,
    });
    const protocol = freezeProtocol(draft, repoRoot);
    const sources = validateLocalSourcesFile({ schemaVersion: 1, paths: { "case-1": source.cwd } });
    const inheritedRoot = tempDir("semctx-pilot-inherited-root-");
    const previousRoot = process.env.SEMCTX_ROOT;
    const previousExternalDiff = process.env.GIT_EXTERNAL_DIFF;
    try {
      process.env.SEMCTX_ROOT = inheritedRoot;
      process.env.GIT_EXTERNAL_DIFF = "definitely-not-a-command";

      const createdDirs: string[] = [];
      const bundle = collectCases(protocol, sources, repoRoot, {
        mkTempDir: (prefix) => {
          const dir = mkdtempSync(join(tmpdir(), prefix));
          createdDirs.push(dir);
          return dir;
        },
      });

      expect(bundle.cases).toHaveLength(1);
      const observed = bundle.cases[0]!;
      expect(observed.status).toBe("OBSERVED");
      expect(observed.changedFiles).toEqual(["src/critical.ts"]);
      expect(observed.semctx?.verify.exitCode).toBe(3); // BLOCK, recorded rather than hidden
      expect(observed.semctx?.verificationStatus).toBe("TRUSTED");
      expect(observed.semctx?.init.argv).toContain("--root");
      expect(observed.semctx?.verdict).toBe("BLOCK");
      expect(observed.semctx?.suggestedFiles).toEqual(["src/critical.ts"]);
      expect(observed.baselineChangedFiles?.suggestedFiles).toEqual(["src/critical.ts"]);
      expect(observed.baselineImportNeighborhood?.suggestedFiles).toContain("src/consumer.ts");
      expect(validateRawCollectionBundle(JSON.parse(JSON.stringify(bundle)))).toEqual(bundle);

      // confinement: the disposable workspace is gone, and the source repository is untouched.
      expect(createdDirs.length).toBeGreaterThan(0);
      for (const dir of createdDirs) expect(existsSync(dir)).toBe(false);
      expect(git(source.cwd, ["status", "--porcelain"])).toBe("");
      expect(git(source.cwd, ["rev-parse", "HEAD"])).toBe(source.head);
      expect(existsSync(join(source.cwd, ".semctx"))).toBe(false);
      expect(existsSync(join(inheritedRoot, ".semctx"))).toBe(false);
    } finally {
      if (previousRoot === undefined) delete process.env.SEMCTX_ROOT;
      else process.env.SEMCTX_ROOT = previousRoot;
      if (previousExternalDiff === undefined) delete process.env.GIT_EXTERNAL_DIFF;
      else process.env.GIT_EXTERNAL_DIFF = previousExternalDiff;
    }
  }, 60_000);

  test("rejects a candidate artifact that changes during collection", () => {
    const repoRoot = makeFixtureRepoRoot();
    const source = makeSourceRepo();
    const draft = validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase(
        "case-1", "fixture-repo", { status: "UNKNOWN" },
        { synthetic: true, baseRef: source.base, headRef: source.head, changedFiles: ["src/critical.ts"] },
      )] },
    });
    const protocol = freezeProtocol(draft, repoRoot);
    const previous = process.env.SEMCTX_PILOT_TEST_MUTATE_SELF;
    process.env.SEMCTX_PILOT_TEST_MUTATE_SELF = "1";
    try {
      expect(() => collectCases(
        protocol,
        validateLocalSourcesFile({ schemaVersion: 1, paths: { "case-1": source.cwd } }),
        repoRoot,
      )).toThrow(/candidate CLI on disk no longer matches/);
    } finally {
      if (previous === undefined) delete process.env.SEMCTX_PILOT_TEST_MUTATE_SELF;
      else process.env.SEMCTX_PILOT_TEST_MUTATE_SELF = previous;
    }
  }, 60_000);

  test.each([
    ["tracked:init", "init"],
    ["tracked:index", "index"],
    ["tracked:verify", "verify"],
    ["staged:index", "index"],
    ["index-flags:index", "index"],
    ["head:init", "init"],
  ] as const)("marks candidate %s drift in the disposable checkout untrusted", (mode, stage) => {
    const repoRoot = makeFixtureRepoRoot();
    const source = makeSourceRepo();
    const protocol = freezeProtocol(validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase(
        "case-1", "fixture-repo", { status: "UNKNOWN" },
        { synthetic: true, baseRef: source.base, headRef: source.head, changedFiles: ["src/critical.ts"] },
      )] },
    }), repoRoot);
    const previous = process.env.SEMCTX_PILOT_TEST_MUTATE_CHECKOUT;
    try {
      process.env.SEMCTX_PILOT_TEST_MUTATE_CHECKOUT = mode;
      const bundle = collectCases(
        protocol,
        validateLocalSourcesFile({ schemaVersion: 1, paths: { "case-1": source.cwd } }),
        repoRoot,
      );
      expect(bundle.cases[0]).toMatchObject({
        status: "OBSERVED",
        failureReason: null,
        semctx: {
          verificationStatus: "SOURCE_DRIFT",
          sourceDriftReason: expect.stringMatching(new RegExp(`disposable checkout changed after candidate ${stage}`)),
          verdict: null,
          suggestedFiles: [],
          init: { exitCode: 0 },
          index: { exitCode: 0 },
        },
      });
      expect(bundle.cases[0]?.baselineImportNeighborhood?.suggestedFiles).toContain("src/consumer.ts");
    } finally {
      if (previous === undefined) delete process.env.SEMCTX_PILOT_TEST_MUTATE_CHECKOUT;
      else process.env.SEMCTX_PILOT_TEST_MUTATE_CHECKOUT = previous;
    }
  }, 60_000);

  test.each([
    ["untracked:index", false],
    ["ignored:index", "node_modules\nsrc/injected.ts\n"],
  ] as const)("marks candidate %s source additions untrusted", (mode, trackedGitignore) => {
    const repoRoot = makeFixtureRepoRoot();
    const source = makeSourceRepo(trackedGitignore);
    const protocol = freezeProtocol(validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase(
        "case-1", "fixture-repo", { status: "UNKNOWN" },
        { synthetic: true, baseRef: source.base, headRef: source.head, changedFiles: ["src/critical.ts"] },
      )] },
    }), repoRoot);
    const previous = process.env.SEMCTX_PILOT_TEST_MUTATE_CHECKOUT;
    try {
      process.env.SEMCTX_PILOT_TEST_MUTATE_CHECKOUT = mode;
      const bundle = collectCases(
        protocol,
        validateLocalSourcesFile({ schemaVersion: 1, paths: { "case-1": source.cwd } }),
        repoRoot,
      );
      expect(bundle.cases[0]).toMatchObject({
        status: "OBSERVED",
        semctx: {
          verificationStatus: "SOURCE_DRIFT",
          sourceDriftReason: expect.stringMatching(/disposable checkout changed after candidate index/),
          init: { exitCode: 0 },
          index: { exitCode: 0 },
          verify: { exitCode: 3 },
        },
      });
    } finally {
      if (previous === undefined) delete process.env.SEMCTX_PILOT_TEST_MUTATE_CHECKOUT;
      else process.env.SEMCTX_PILOT_TEST_MUTATE_CHECKOUT = previous;
    }
  }, 60_000);

  test.each([
    ["canonical", "OBSERVED", "TRUSTED"],
    ["canonical-missing", "OBSERVED", "TRUSTED"],
    ["poison", "OBSERVED", "SOURCE_DRIFT"],
  ] as const)("classifies a %s .gitignore update precisely", (mode, status, verificationStatus) => {
    const repoRoot = makeFixtureRepoRoot();
    const source = makeSourceRepo(mode === "canonical-missing" ? false : true);
    const protocol = freezeProtocol(validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase(
        "case-1", "fixture-repo", { status: "UNKNOWN" },
        { synthetic: true, baseRef: source.base, headRef: source.head, changedFiles: ["src/critical.ts"] },
      )] },
    }), repoRoot);
    const previous = process.env.SEMCTX_PILOT_TEST_GITIGNORE;
    try {
      process.env.SEMCTX_PILOT_TEST_GITIGNORE = mode;
      const bundle = collectCases(
        protocol,
        validateLocalSourcesFile({ schemaVersion: 1, paths: { "case-1": source.cwd } }),
        repoRoot,
      );
      expect(bundle.cases[0]).toMatchObject({ status, semctx: { verificationStatus } });
    } finally {
      if (previous === undefined) delete process.env.SEMCTX_PILOT_TEST_GITIGNORE;
      else process.env.SEMCTX_PILOT_TEST_GITIGNORE = previous;
    }
  }, 60_000);

  test("records a frozen changedFiles mismatch as missing evidence before running the candidate", () => {
    const repoRoot = makeFixtureRepoRoot();
    const source = makeSourceRepo();
    const protocol = freezeProtocol(validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase(
        "case-1", "fixture-repo", { status: "UNKNOWN" },
        { synthetic: true, baseRef: source.base, headRef: source.head, changedFiles: ["wrong.ts"] },
      )] },
    }), repoRoot);
    const bundle = collectCases(protocol, validateLocalSourcesFile({ schemaVersion: 1, paths: { "case-1": source.cwd } }), repoRoot);
    expect(bundle.cases[0]?.status).toBe("FAILED");
    expect(bundle.cases[0]?.failureReason).toMatch(/does not match changedFiles/);
  }, 60_000);

  test("observes a diverged base through the same merge-base range as verify diff", () => {
    const repoRoot = makeFixtureRepoRoot();
    const source = makeDivergedSourceRepo();
    const protocol = freezeProtocol(validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase(
        "case-1", "fixture-repo", { status: "UNKNOWN" },
        { synthetic: true, baseRef: source.base, headRef: source.head, changedFiles: ["src/critical.ts"] },
      )] },
    }), repoRoot);
    const bundle = collectCases(
      protocol,
      validateLocalSourcesFile({ schemaVersion: 1, paths: { "case-1": source.cwd } }),
      repoRoot,
    );
    expect(bundle.cases[0]).toMatchObject({
      status: "OBSERVED",
      git: {
        baseRef: source.base,
        headRef: source.head,
        mergeBase: source.mergeBase,
        range: `${source.mergeBase.slice(0, 12)}..${source.head.slice(0, 12)}`,
      },
      changedFiles: ["src/critical.ts"],
      semctx: { verificationStatus: "TRUSTED" },
    });
  }, 60_000);

  test("records a FAILED case (not a thrown error) when the source path does not exist", () => {
    const repoRoot = makeFixtureRepoRoot();
    const corpus: FrozenProtocolV1["corpus"] = {
      kind: "synthetic-smoke",
      cases: [makeCase("missing-1", "fixture-repo", { status: "UNKNOWN" }, { synthetic: true })],
    };
    const draft = validateDraftProtocol({ schemaVersion: 1, candidate: { packaging: "source-dev" }, config: baseDraft(), corpus });
    const protocol = freezeProtocol(draft, repoRoot);
    const sources = validateLocalSourcesFile({ schemaVersion: 1, paths: {} });

    const bundle = collectCases(protocol, sources, repoRoot);
    expect(bundle.cases[0]?.status).toBe("FAILED");
    expect(bundle.cases[0]?.failureReason).toMatch(/no local source path/);
  });

  test("refuses to collect once the on-disk candidate no longer matches the frozen identity", () => {
    const repoRoot = makeFixtureRepoRoot();
    const draft = validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase("s-1", "repo-fixture", { status: "UNKNOWN" }, { synthetic: true })] },
    });
    const protocol = freezeProtocol(draft, repoRoot);
    writeFileSync(join(repoRoot, "apps", "cli", "src", "index.ts"), `${STUB_CANDIDATE_SOURCE}\n// mutated after freeze\n`);
    const sources = validateLocalSourcesFile({ schemaVersion: 1, paths: {} });
    expect(() => collectCases(protocol, sources, repoRoot)).toThrow(/no longer matches the frozen protocol identity/);
  });
});

// ============================================================================================
// scoring: no fake effectiveness
// ============================================================================================

function makeObservation(
  caseId: string,
  suggested: readonly string[] | null,
  spec?: CorpusCaseSpec,
): RawCollectionBundleV1["cases"][number] {
  if (suggested === null) {
    return { caseId, status: "FAILED", failureReason: "infra failure", git: null, changedFiles: [], semctx: null, baselineChangedFiles: null, baselineImportNeighborhood: null };
  }
  const baseRef = spec?.baseRef ?? HEX_BASE;
  const headRef = spec?.headRef ?? hexHead(1);
  const gitIdentity = {
    baseRef,
    headRef,
    mergeBase: baseRef,
    range: `${baseRef.slice(0, 12)}..${headRef.slice(0, 12)}`,
    headTree: "c".repeat(40),
    trackedFilesDigest: `sha256:${"d".repeat(64)}`,
    trackedIndexDigest: `sha256:${"e".repeat(64)}`,
  };
  const changedFiles = [...(spec?.changedFiles ?? [])];
  const changedAlgorithm = "changed-files-v1" as const;
  const importAlgorithm = "one-hop-import-neighborhood-v1" as const;
  const candidatePrefix = ["C:\\pilot\\bun.exe", "run", "C:\\pilot\\runner\\apps\\cli\\dist\\index.js"];
  const invocation = (argv: readonly string[], stdout = "") => ({
    argv,
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    stdout,
    stderr: "",
    outputDigest: toolOutputDigest(stdout, ""),
  });
  const verifyStdout = JSON.stringify({
    schemaVersion: 1,
    verdict: "PASS",
    base: baseRef,
    head: headRef,
    mergeBase: gitIdentity.mergeBase,
    range: gitIdentity.range,
    changedFiles: spec?.changedFiles ?? [],
    changedSymbols: [],
    impactedContracts: [],
    impactedInvariants: [],
    recommendedTests: [],
    contradictions: [],
    unknowns: [],
    findings: [],
    impactedConsumers: [{
      symbol: { id: "sym:source", name: "source", kind: "function" },
      consumers: suggested.map((file, index) => ({ id: `sym:consumer:${index}`, name: `consumer${index}`, kind: "function", file })),
    }],
    summary: { blockCount: 0, warnCount: 0 },
  });
  return {
    caseId,
    status: "OBSERVED",
    failureReason: null,
    git: gitIdentity,
    changedFiles: [...(spec?.changedFiles ?? [])],
    semctx: {
      init: invocation([...candidatePrefix, "init", "--root", "C:\\pilot\\case"]),
      index: invocation([...candidatePrefix, "index", "--root", "C:\\pilot\\case"]),
      verify: invocation([
        ...candidatePrefix, "verify", "diff", "--base", baseRef, "--head", headRef,
        "--format", "json", "--root", "C:\\pilot\\case",
      ], verifyStdout),
      verdict: "PASS",
      verificationStatus: "TRUSTED",
      sourceDriftReason: null,
      suggestedFiles: [...suggested],
    },
    baselineChangedFiles: {
      algorithm: changedAlgorithm,
      suggestedFiles: changedFiles,
      durationMs: 1,
      inputDigest: baselineInputDigest(changedAlgorithm, gitIdentity, changedFiles),
      outputDigest: baselineOutputDigest(changedAlgorithm, changedFiles),
    },
    baselineImportNeighborhood: {
      algorithm: importAlgorithm,
      suggestedFiles: [],
      durationMs: 1,
      inputDigest: baselineInputDigest(importAlgorithm, gitIdentity, changedFiles),
      outputDigest: baselineOutputDigest(importAlgorithm, []),
    },
  };
}

describe("scoreTool: a no-op analyzer must not pass as a positive witness", () => {
  test("an empty suggestion set scores zero, not a perfect score, on a known-positive case", () => {
    const corpus = new Map([
      ["known-positive", makeCase("known-positive", "repo-a", {
        status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["a.ts"], criticalFiles: ["a.ts"],
      })],
    ]);
    const noOp = scoreTool("semctx", [makeObservation("known-positive", [])], corpus);
    expect(noOp.precision).toBe(0);
    expect(noOp.recall).toBe(0);
    expect(noOp.criticalRecall).toBe(0);

    const correct = scoreTool("semctx", [makeObservation("known-positive", ["a.ts"])], corpus);
    expect(correct.precision).toBe(1);
    expect(correct.recall).toBe(1);
    expect(correct.criticalRecall).toBe(1);
  });

  test("UNKNOWN-labelled cases are excluded from scoring, never treated as negatives", () => {
    const corpus = new Map<string, CorpusCaseSpec>([
      ["labelled", makeCase("labelled", "repo-a", { status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["a.ts"], criticalFiles: [] })],
      ["unknown", makeCase("unknown", "repo-a", { status: "UNKNOWN" })],
    ]);
    const score = scoreTool("semctx", [makeObservation("labelled", ["a.ts"]), makeObservation("unknown", [])], corpus);
    expect(score.labelledCasesScored).toBe(1);
    expect(score.precision).toBe(1);
  });
});

describe("buildResultReport: verdict ladder", () => {
  test("EVIDENCE_MISSING when the corpus is synthetic-smoke, regardless of scores", () => {
    const corpus: FrozenProtocolV1["corpus"] = {
      kind: "synthetic-smoke",
      cases: [makeCase("s-1", "repo-a", { status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["a.ts"], criticalFiles: [] }, { synthetic: true })],
    };
    const protocol = makeFrozenProtocolFixture(corpus);
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: [makeObservation("s-1", ["a.ts"], corpus.cases[0])],
    };
    const report = buildResultReport(protocol, raw);
    expect(report.evidenceKind).toBe("smoke");
    expect(report.verdict).toBe("EVIDENCE_MISSING");
  });

  test("EVIDENCE_MISSING on a research corpus with zero labelled cases", () => {
    const corpus = researchCorpus(Array.from({ length: 30 }, () => ({ status: "UNKNOWN" }) as LabelStatus));
    const protocol = makeFrozenProtocolFixture(corpus);
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: corpus.cases.map((c) => makeObservation(c.caseId, [], c)),
    };
    expect(buildResultReport(protocol, raw).verdict).toBe("EVIDENCE_MISSING");
  });

  test("INCONCLUSIVE when fewer than 30 cases are actually labelled", () => {
    const labels: LabelStatus[] = Array.from({ length: 30 }, (_, i) =>
      i < 10 ? { status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["a.ts"], criticalFiles: [] } : { status: "UNKNOWN" },
    );
    const corpus = researchCorpus(labels);
    const protocol = makeFrozenProtocolFixture(corpus);
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: corpus.cases.map((c) => makeObservation(c.caseId, ["a.ts"], c)),
    };
    expect(buildResultReport(protocol, raw).verdict).toBe("INCONCLUSIVE");
  });

  test("POSITIVE when 30+ labelled cases are perfectly matched", () => {
    const labels: LabelStatus[] = Array.from({ length: 30 }, () => ({
      status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["a.ts"], criticalFiles: ["a.ts"],
    }));
    const corpus = researchCorpus(labels);
    const protocol = makeFrozenProtocolFixture(corpus);
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: corpus.cases.map((c) => makeObservation(c.caseId, ["a.ts"], c)),
    };
    const report = buildResultReport(protocol, raw);
    expect(report.verdict).toBe("POSITIVE");
    expect(report.scores?.find((s) => s.tool === "semctx")?.precision).toBe(1);
  });

  test("NEGATIVE when 30+ labelled cases exist but the candidate never suggests anything", () => {
    const labels: LabelStatus[] = Array.from({ length: 30 }, () => ({
      status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["a.ts"], criticalFiles: ["a.ts"],
    }));
    const corpus = researchCorpus(labels);
    const protocol = makeFrozenProtocolFixture(corpus);
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: corpus.cases.map((c) => makeObservation(c.caseId, [], c)),
    };
    expect(buildResultReport(protocol, raw).verdict).toBe("NEGATIVE");
  });
});

// ============================================================================================
// identity / completeness
// ============================================================================================

describe("report identity and completeness gates", () => {
  function fixture(): { protocol: FrozenProtocolV1; raw: RawCollectionBundleV1 } {
    const corpus: FrozenProtocolV1["corpus"] = {
      kind: "synthetic-smoke",
      cases: [makeCase("s-1", "repo-a", { status: "UNKNOWN" }, { synthetic: true })],
    };
    const protocol = makeFrozenProtocolFixture(corpus);
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: [makeObservation("s-1", [], corpus.cases[0])],
    };
    return { protocol, raw };
  }

  test("rejects a raw bundle whose protocolDigest does not match the frozen protocol", () => {
    const { protocol, raw } = fixture();
    expect(() => buildResultReport(protocol, { ...raw, protocolDigest: `sha256:${"9".repeat(64)}` })).toThrow(/protocolDigest/);
  });

  test("rejects a changed-files baseline that contradicts the captured changed files", () => {
    const { protocol, raw } = fixture();
    const observation = raw.cases[0]!;
    if (observation.status !== "OBSERVED" || observation.baselineChangedFiles === null) throw new Error("invalid fixture");
    const wrongSuggestions = ["wrong.ts"];
    const tampered: RawCollectionBundleV1 = {
      ...raw,
      cases: [{
        ...observation,
        baselineChangedFiles: {
          ...observation.baselineChangedFiles,
          suggestedFiles: wrongSuggestions,
          outputDigest: baselineOutputDigest("changed-files-v1", wrongSuggestions),
        },
      }],
    };
    expect(() => buildResultReport(protocol, tampered)).toThrow(/changed-files baseline/);
  });

  test("rejects duplicate baseline paths and stale baseline digests", () => {
    const { protocol, raw } = fixture();
    const observation = raw.cases[0]!;
    if (observation.status !== "OBSERVED" || observation.baselineChangedFiles === null) throw new Error("invalid fixture");
    const duplicate = JSON.parse(JSON.stringify(raw));
    duplicate.cases[0].baselineChangedFiles.suggestedFiles = ["same.ts", "same.ts"];
    duplicate.cases[0].baselineChangedFiles.outputDigest = baselineOutputDigest("changed-files-v1", ["same.ts", "same.ts"]);
    expect(() => validateRawCollectionBundle(duplicate)).toThrow(/sorted and contain no duplicates/);
    expect(() => buildResultReport(protocol, duplicate as RawCollectionBundleV1)).toThrow(/sorted and contain no duplicates/);

    const staleOutput: RawCollectionBundleV1 = {
      ...raw,
      cases: [{
        ...observation,
        baselineChangedFiles: { ...observation.baselineChangedFiles, outputDigest: `sha256:${"9".repeat(64)}` },
      }],
    };
    expect(() => buildResultReport(protocol, staleOutput)).toThrow(/outputDigest/);

    const staleInput: RawCollectionBundleV1 = {
      ...raw,
      cases: [{
        ...observation,
        baselineChangedFiles: { ...observation.baselineChangedFiles, inputDigest: `sha256:${"8".repeat(64)}` },
      }],
    };
    expect(() => buildResultReport(protocol, staleInput)).toThrow(/inputDigest/);

    const wrongAlgorithm = JSON.parse(JSON.stringify(raw)) as RawCollectionBundleV1;
    const changedBaseline = wrongAlgorithm.cases[0]!.baselineChangedFiles!;
    (changedBaseline as { algorithm: string }).algorithm = "one-hop-import-neighborhood-v1";
    changedBaseline.inputDigest = baselineInputDigest(changedBaseline.algorithm, observation.git!, observation.changedFiles);
    changedBaseline.outputDigest = baselineOutputDigest(changedBaseline.algorithm, changedBaseline.suggestedFiles);
    expect(() => buildResultReport(protocol, wrongAlgorithm)).toThrow(/algorithm/);

  });

  test("report rejects a stale candidate output digest", () => {
    const { protocol, raw } = fixture();
    const staleCandidateOutput = structuredClone(raw);
    staleCandidateOutput.cases[0]!.semctx!.verify.outputDigest = `sha256:${"7".repeat(64)}`;
    expect(() => buildResultReport(protocol, staleCandidateOutput)).toThrow(/outputDigest/);
  });

  test("rejects a raw bundle missing a registered case", () => {
    const { protocol } = fixture();
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0", cases: [],
    };
    expect(() => buildResultReport(protocol, raw)).toThrow(/missing case/);
  });

  test("rejects a raw bundle with a case not in the frozen protocol", () => {
    const { protocol, raw } = fixture();
    expect(() => buildResultReport(protocol, { ...raw, cases: [...raw.cases, makeObservation("not-registered", [])] })).toThrow(
      /not registered/,
    );
  });

  test("validateRawCollectionBundle rejects duplicate caseIds before identity checks even run", () => {
    const observation = makeObservation("dup", []);
    expect(() => validateRawCollectionBundle({
      schemaVersion: 1, experimentId: "e", protocolDigest: `sha256:${"0".repeat(64)}`,
      collectedAt: "now", observedBunVersion: "1.4.0", cases: [observation, observation],
    })).toThrow(/duplicate caseId/);
  });

  test("rejects a raw bundle produced by a different Bun runtime", () => {
    const { protocol, raw } = fixture();
    expect(() => buildResultReport(protocol, { ...raw, observedBunVersion: "0.0.0" })).toThrow(/observedBunVersion/);
  });

  test("rejects candidate command metadata that contradicts the frozen stage, range, entry, runtime, or root", () => {
    const mutateArgv = (change: (argv: string[], observation: RawCollectionBundleV1["cases"][number]) => void): RawCollectionBundleV1 => {
      const { raw } = fixture();
      const observation = structuredClone(raw.cases[0]!);
      if (observation.semctx === null) throw new Error("fixture must contain a semctx run");
      change(observation.semctx.verify.argv as string[], observation);
      return { ...raw, cases: [observation] };
    };
    const { protocol } = fixture();
    expect(() => buildResultReport(protocol, mutateArgv((argv) => { argv[3] = "index"; }))).toThrow(/registered candidate stage/);
    expect(() => buildResultReport(protocol, mutateArgv((argv) => { argv[6] = "c".repeat(40); }))).toThrow(/frozen Git range/);
    expect(() => buildResultReport(protocol, mutateArgv((argv) => { argv[2] = "C:\\pilot\\runner\\other.js"; }))).toThrow(/frozen candidate entry path/);
    expect(() => buildResultReport(protocol, mutateArgv((argv) => { argv[0] = "C:\\other\\bun.exe"; }))).toThrow(/same Bun executable/);
    expect(() => buildResultReport(protocol, mutateArgv((argv) => { argv[argv.length - 1] = "C:\\other\\case"; }))).toThrow(/same disposable root/);

    const differentEntry = fixture().raw;
    const differentEntryObservation = structuredClone(differentEntry.cases[0]!);
    if (differentEntryObservation.semctx === null) throw new Error("fixture must contain a semctx run");
    (differentEntryObservation.semctx.index.argv as string[])[2] = "C:\\other\\apps\\cli\\dist\\index.js";
    (differentEntryObservation.semctx.verify.argv as string[])[2] = "C:\\other\\apps\\cli\\dist\\index.js";
    expect(() => buildResultReport(protocol, { ...differentEntry, cases: [differentEntryObservation] }))
      .toThrow(/frozen candidate entry path/);
  });

  test("accepts portable Windows and POSIX candidate entry paths, including empty failed-stage output", () => {
    for (const entry of ["C:\\pilot\\runner\\apps\\cli\\dist\\index.js", "/pilot/runner/apps/cli/dist/index.js"]) {
      const { protocol, raw } = fixture();
      const observation = structuredClone(raw.cases[0]!);
      if (observation.semctx === null) throw new Error("fixture must contain a semctx run");
      for (const invocation of [observation.semctx.init, observation.semctx.index, observation.semctx.verify]) {
        invocation.argv = [...invocation.argv];
        (invocation.argv as string[])[2] = entry;
      }
      observation.semctx.init.exitCode = 2;
      observation.semctx.init.stdout = "";
      observation.semctx.init.stderr = "";
      observation.semctx.init.outputDigest = toolOutputDigest("", "");
      observation.semctx.verificationStatus = "PREREQUISITE_FAILED";
      observation.semctx.verdict = null;
      observation.semctx.suggestedFiles = [];
      expect(() => buildResultReport(protocol, { ...raw, cases: [observation] })).not.toThrow();
    }
  });

  test("rejects a raw Git identity that does not bind the frozen case", () => {
    const { protocol, raw } = fixture();
    const observation = raw.cases[0]!;
    if (observation.git === null) throw new Error("fixture must be observed");
    const changed = {
      ...observation,
      git: { ...observation.git, baseRef: "c".repeat(40) },
    };
    expect(() => buildResultReport(protocol, { ...raw, cases: [changed] })).toThrow(/does not bind the frozen base\/head/);
  });

  test("revalidates a trusted raw report against the independently observed merge-base", () => {
    const { protocol, raw } = fixture();
    const observation = structuredClone(raw.cases[0]!);
    if (observation.semctx === null) throw new Error("fixture must contain a semctx run");
    const report = JSON.parse(observation.semctx.verify.stdout) as Record<string, unknown>;
    report.mergeBase = "c".repeat(40);
    observation.semctx.verify.stdout = JSON.stringify(report);
    observation.semctx.verify.outputDigest = toolOutputDigest(observation.semctx.verify.stdout, observation.semctx.verify.stderr);
    expect(() => buildResultReport(protocol, { ...raw, cases: [observation] })).toThrow(/trusted projection disagrees/);
  });

  test("an infrastructure failure produces no score and EVIDENCE_MISSING", () => {
    const labels: LabelStatus[] = Array.from({ length: 30 }, () => ({
      status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["a.ts"], criticalFiles: [],
    }));
    const corpus = researchCorpus(labels);
    const protocol = makeFrozenProtocolFixture(corpus);
    const cases = corpus.cases.map((c, index): RawCollectionBundleV1["cases"][number] => index === 0
      ? { caseId: c.caseId, status: "FAILED", failureReason: "local clone failed", git: null, changedFiles: [], semctx: null,
        baselineChangedFiles: null, baselineImportNeighborhood: null }
      : makeObservation(c.caseId, ["a.ts"], c));
    const report = buildResultReport(protocol, {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0", cases,
    });
    expect(report.verdict).toBe("EVIDENCE_MISSING");
    expect(report.scores).toBeNull();
    expect(report.totals.failedCases).toBe(1);
    expect(report.totals.untrustedCases).toBe(0);
  });

  test("one observed untrusted case prevents a labelled research corpus from scoring", () => {
    const labels: LabelStatus[] = Array.from({ length: 30 }, () => ({
      status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["a.ts"], criticalFiles: [],
    }));
    const corpus = researchCorpus(labels);
    const protocol = makeFrozenProtocolFixture(corpus);
    const cases = corpus.cases.map((spec, index) => {
      const observation = makeObservation(spec.caseId, ["a.ts"], spec);
      if (index === 0 && observation.semctx !== null) {
        observation.semctx.verificationStatus = "DIFF_MISMATCH";
        observation.semctx.verdict = null;
        observation.semctx.suggestedFiles = [];
      }
      return observation;
    });
    const report = buildResultReport(protocol, {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0", cases,
    });
    expect(report.verdict).toBe("EVIDENCE_MISSING");
    expect(report.scores).toBeNull();
    expect(report.totals).toMatchObject({ observedCases: 30, failedCases: 0, untrustedCases: 1 });
    expect(buildPublicSummary(protocol, report).totals.untrustedCases).toBe(1);
  });

  test("reports independent per-repository scores and preserves local missing-evidence boundaries", () => {
    const labelled: LabelStatus = {
      status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["a.ts"], criticalFiles: ["a.ts"],
    };
    const corpus: FrozenProtocolV1["corpus"] = {
      kind: "synthetic-smoke",
      cases: [
        makeCase("good", "repo-good", labelled, { synthetic: true }),
        makeCase("bad", "repo-bad", labelled, { synthetic: true, headRef: hexHead(2) }),
        makeCase("unknown", "repo-unknown", { status: "UNKNOWN" }, { synthetic: true, headRef: hexHead(3) }),
        makeCase("failed", "repo-failed", labelled, { synthetic: true, headRef: hexHead(4) }),
        makeCase("untrusted", "repo-untrusted", labelled, { synthetic: true, headRef: hexHead(5) }),
      ],
    };
    const protocol = makeFrozenProtocolFixture(corpus);
    const untrusted = makeObservation("untrusted", ["a.ts"], corpus.cases[4]);
    if (untrusted.semctx === null) throw new Error("fixture must contain a semctx run");
    untrusted.semctx.verificationStatus = "DIFF_MISMATCH";
    untrusted.semctx.verdict = null;
    untrusted.semctx.suggestedFiles = [];
    const report = buildResultReport(protocol, {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: [
        makeObservation("good", ["a.ts"], corpus.cases[0]),
        makeObservation("bad", [], corpus.cases[1]),
        makeObservation("unknown", [], corpus.cases[2]),
        makeObservation("failed", null, corpus.cases[3]),
        untrusted,
      ],
    });
    const repositories = new Map(report.perRepository.map((repository) => [repository.repositoryAlias, repository]));
    const goodScore = repositories.get("repo-good")?.scores?.find((score) => score.tool === "semctx");
    const badScore = repositories.get("repo-bad")?.scores?.find((score) => score.tool === "semctx");
    if (goodScore?.recall !== 1 || badScore?.recall !== 0) {
      process.stderr.write("PILOT_PER_REPOSITORY_SCORES_MISMATCH\n");
    }
    expect(report.scores).toBeNull();
    expect(goodScore)
      .toMatchObject({ labelledCasesScored: 1, precision: 1, recall: 1, criticalRecall: 1 });
    expect(badScore)
      .toMatchObject({ labelledCasesScored: 1, precision: 0, recall: 0, criticalRecall: 0 });
    expect(repositories.get("repo-unknown")?.scores).toBeNull();
    expect(repositories.get("repo-failed")?.scores).toBeNull();
    expect(repositories.get("repo-untrusted")?.scores).toBeNull();
    expect(report.verdict).toBe("EVIDENCE_MISSING");
  });
});

// ============================================================================================
// process truth
// ============================================================================================

describe("validateRawCollectionBundle: process truth", () => {
  const base = {
    schemaVersion: 1 as const, experimentId: "e", protocolDigest: `sha256:${"0".repeat(64)}`,
    collectedAt: "now", observedBunVersion: "1.4.0",
  };

  test("rejects a boolean exit code", () => {
    const observation = makeObservation("c-1", ["a.ts"]);
    (observation.semctx as unknown as { verify: { exitCode: unknown } }).verify.exitCode = true;
    expect(() => validateRawCollectionBundle({ ...base, cases: [observation] })).toThrow(/expected a finite number/);
  });

  test("rejects a non-finite duration", () => {
    const observation = makeObservation("c-1", ["a.ts"]);
    (observation.semctx as unknown as { verify: { durationMs: unknown } }).verify.durationMs = Number.POSITIVE_INFINITY;
    expect(() => validateRawCollectionBundle({ ...base, cases: [observation] })).toThrow(/finite/);
  });

  test("rejects a stale candidate output digest", () => {
    const observation = makeObservation("c-1", ["a.ts"]);
    if (observation.semctx === null) throw new Error("fixture must contain a semctx run");
    observation.semctx.verify.outputDigest = `sha256:${"9".repeat(64)}`;
    expect(() => validateRawCollectionBundle({ ...base, cases: [observation] })).toThrow(/outputDigest/);
  });

  test("rejects a malformed verdict value", () => {
    const observation = makeObservation("c-1", ["a.ts"]);
    (observation.semctx as unknown as { verdict: unknown }).verdict = "MAYBE";
    expect(() => validateRawCollectionBundle({ ...base, cases: [observation] })).toThrow(/PASS \| WARN \| BLOCK/);
  });

  test("rejects an OBSERVED case missing its semctx run", () => {
    const observation = { ...makeObservation("c-1", ["a.ts"]), semctx: undefined };
    expect(() => validateRawCollectionBundle({ ...base, cases: [observation] })).toThrow();
  });

  test("rejects a pre-fix OBSERVED case without a bound Git identity", () => {
    const { git: _git, ...oldObservation } = makeObservation("c-1", ["a.ts"]);
    expect(() => validateRawCollectionBundle({ ...base, cases: [oldObservation] })).toThrow(/expected an object/);
  });

  test("rejects a non-canonical raw range", () => {
    const observation = makeObservation("c-1", ["a.ts"]);
    if (observation.git === null) throw new Error("fixture must be observed");
    observation.git.range = "cccccccccccc..dddddddddddd";
    expect(() => validateRawCollectionBundle({ ...base, cases: [observation] })).toThrow(/canonical merge-base/);
  });

  test("rejects incoherent timeout and unknown raw fields", () => {
    const observation = makeObservation("c-1", ["a.ts"]);
    if (observation.semctx !== null) observation.semctx.verify.timedOut = true;
    expect(() => validateRawCollectionBundle({ ...base, cases: [observation] })).toThrow(/timedOut/);
    expect(() => validateRawCollectionBundle({ ...base, cases: [makeObservation("c-1", [] )], extra: true })).toThrow(/unknown field/);
  });

  test("rejects an untrusted status that still claims a PASS verdict", () => {
    const observation = makeObservation("c-1", ["a.ts"]);
    if (observation.semctx !== null) observation.semctx.verificationStatus = "EXIT_MISMATCH";
    expect(() => validateRawCollectionBundle({ ...base, cases: [observation] })).toThrow(/untrusted verification/);
  });
});

describe("verify output trust", () => {
  const expected = {
    baseRef: HEX_BASE,
    headRef: hexHead(1),
    mergeBase: HEX_BASE,
    range: `${HEX_BASE.slice(0, 12)}..${hexHead(1).slice(0, 12)}`,
    changedFiles: ["a.ts"],
  };
  const report = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
    schemaVersion: 1,
    verdict: "PASS",
    base: HEX_BASE,
    head: hexHead(1),
    mergeBase: expected.mergeBase,
    range: expected.range,
    changedFiles: ["a.ts"],
    changedSymbols: [],
    impactedContracts: [],
    impactedInvariants: [],
    recommendedTests: [],
    contradictions: [],
    unknowns: [],
    findings: [],
    summary: { blockCount: 0, warnCount: 0 },
    ...overrides,
  });

  test("trusts only a bound report whose verdict agrees with the process exit", () => {
    expect(parseVerifyReport(report(), 0, expected).verificationStatus).toBe("TRUSTED");
    expect(parseVerifyReport(report(), 3, expected)).toMatchObject({ verdict: null, verificationStatus: "EXIT_MISMATCH" });
    expect(parseVerifyReport(report({ changedFiles: ["other.ts"] }), 0, expected)).toMatchObject({
      verdict: null,
      verificationStatus: "DIFF_MISMATCH",
    });
    expect(parseVerifyReport(report({ mergeBase: "c".repeat(40) }), 0, expected)).toMatchObject({
      verdict: null,
      verificationStatus: "DIFF_MISMATCH",
    });
    expect(parseVerifyReport(report({ range: "cccccccccccc..dddddddddddd" }), 0, expected)).toMatchObject({
      verdict: null,
      verificationStatus: "DIFF_MISMATCH",
    });
    expect(parseVerifyReport("not-json", 0, expected)).toMatchObject({ verdict: null, verificationStatus: "MALFORMED_OUTPUT" });
  });

  test("rejects incomplete, contradictory, and unconfined verify reports", () => {
    const incomplete = JSON.stringify({
      schemaVersion: 1, verdict: "PASS", base: HEX_BASE, head: hexHead(1), changedFiles: ["a.ts"],
    });
    expect(parseVerifyReport(incomplete, 0, expected).verificationStatus).toBe("MALFORMED_OUTPUT");
    expect(parseVerifyReport(report({
      summary: { blockCount: 1, warnCount: 0 },
      findings: [{
        rule: "contradiction", tier: "strict", severity: "block", message: "blocked", nodeIds: [], locations: [],
      }],
    }), 0, expected).verificationStatus).toBe("MALFORMED_OUTPUT");
    expect(parseVerifyReport(report({
      impactedConsumers: [{
        symbol: { id: "sym:source", name: "source", kind: "function", file: "a.ts" },
        consumers: [{ id: "sym:consumer", name: "consumer", kind: "function", file: "../../private/secret.ts" }],
      }],
    }), 0, expected).verificationStatus).toBe("MALFORMED_OUTPUT");
  });
});

describe("local source and output path safety", () => {
  test("preserves __proto__ as an own local source key without prototype mutation", () => {
    const value = validateLocalSourcesFile(JSON.parse(
      '{"schemaVersion":1,"paths":{"__proto__":"/private/repo","normal":"/normal"}}',
    ));
    expect(Object.getPrototypeOf(value.paths)).toBeNull();
    expect(Object.hasOwn(value.paths, "__proto__")).toBe(true);
    expect(value.paths["__proto__"]).toBe(resolve("/private/repo"));
  });

  test("rejects relative local source paths before collection", () => {
    expect(() => validateLocalSourcesFile({ schemaVersion: 1, paths: { "case-1": "relative/repo" } }))
      .toThrow(/absolute local repository path/);
  });

  test("fully qualifies an accepted host-absolute local source path", () => {
    const sourcePath = "/repo";
    const sources = validateLocalSourcesFile({ schemaVersion: 1, paths: { "case-1": sourcePath } });
    expect(sources.paths["case-1"]).toBe(resolve(sourcePath));
  });

  test("refuses exclusive output through a symlink or junction ancestor", () => {
    const parent = tempDir("semctx-pilot-output-parent-");
    const outside = tempDir("semctx-pilot-output-outside-");
    const linked = join(parent, "linked");
    symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
    expect(() => writeJsonExclusive(join(linked, "public.json"), { safe: true })).toThrow(/symbolic link|junction/);
    expect(existsSync(join(outside, "public.json"))).toBe(false);
  });
});

describe("impact-pilot report CLI", () => {
  test("rejects preview output flags before reading inputs or writing files", () => {
    const cwd = tempDir("semctx-pilot-preview-conflict-");
    for (const outputFlag of ["--out", "--export"] as const) {
      const output = join(cwd, `${outputFlag.slice(2)}.json`);
      const result = runImpactPilotCli(cwd, [
        "report",
        "--protocol", join(cwd, "missing-protocol.json"),
        "--raw", join(cwd, "missing-raw.json"),
        "--preview",
        outputFlag, output,
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(`[impact-pilot] ERROR --preview cannot be combined with ${outputFlag}`);
      expect(result.stderr).not.toContain("ENOENT");
      expect(existsSync(output)).toBe(false);
    }
  });

  test("valid preview prints the public summary without creating an artifact", () => {
    const cwd = tempDir("semctx-pilot-preview-readonly-");
    const corpus: FrozenProtocolV1["corpus"] = {
      kind: "synthetic-smoke",
      cases: [makeCase("s-1", "repo-a", { status: "UNKNOWN" }, { synthetic: true })],
    };
    const protocol = makeFrozenProtocolFixture(corpus);
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1,
      experimentId: protocol.experimentId,
      protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z",
      observedBunVersion: "1.4.0",
      cases: [makeObservation("s-1", [], corpus.cases[0])],
    };
    const protocolPath = join(cwd, "protocol.json");
    const rawPath = join(cwd, "raw.json");
    writeFileSync(protocolPath, JSON.stringify(protocol));
    writeFileSync(rawPath, JSON.stringify(raw));
    const filesBefore = readdirSync(cwd).sort();

    for (const outputFlag of ["--out", "--export"] as const) {
      const forbiddenOutput = join(cwd, `forbidden-${outputFlag.slice(2)}.json`);
      const conflict = runImpactPilotCli(cwd, [
        "report", "--protocol", protocolPath, "--raw", rawPath, "--preview",
        outputFlag, forbiddenOutput,
      ]);
      expect(existsSync(forbiddenOutput)).toBe(false);
      expect(conflict.exitCode).toBe(2);
      expect(conflict.stderr).toContain(`[impact-pilot] ERROR --preview cannot be combined with ${outputFlag}`);
      expect(readdirSync(cwd).sort()).toEqual(filesBefore);
    }

    const result = runImpactPilotCli(cwd, ["report", "--protocol", protocolPath, "--raw", rawPath, "--preview"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"evidenceKind": "smoke"');
    expect(result.stdout).toContain("[impact-pilot] verdict=EVIDENCE_MISSING evidenceKind=smoke");
    expect(readdirSync(cwd).sort()).toEqual(filesBefore);
  });

  test("ordinary report output and public export remain available together", () => {
    const cwd = tempDir("semctx-pilot-report-output-");
    const corpus: FrozenProtocolV1["corpus"] = {
      kind: "synthetic-smoke",
      cases: [makeCase("s-1", "repo-a", { status: "UNKNOWN" }, { synthetic: true })],
    };
    const protocol = makeFrozenProtocolFixture(corpus);
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1,
      experimentId: protocol.experimentId,
      protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z",
      observedBunVersion: "1.4.0",
      cases: [makeObservation("s-1", [], corpus.cases[0])],
    };
    const protocolPath = join(cwd, "protocol.json");
    const rawPath = join(cwd, "raw.json");
    const reportPath = join(cwd, "report.json");
    const exportPath = join(cwd, "public.json");
    writeFileSync(protocolPath, JSON.stringify(protocol));
    writeFileSync(rawPath, JSON.stringify(raw));

    const result = runImpactPilotCli(cwd, [
      "report", "--protocol", protocolPath, "--raw", rawPath,
      "--out", reportPath, "--export", exportPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(readFileSync(reportPath, "utf8")).perRepository[0].repositoryAlias).toBe("repo-a");
    expect(JSON.parse(readFileSync(exportPath, "utf8")).perRepository[0].repositoryAlias).toBe("repository-1");
  });
});

// ============================================================================================
// privacy: public export allowlist
// ============================================================================================

describe("buildPublicSummary: privacy allowlist", () => {
  test("preserves declared public source provenance while replacing private identifiers and critical paths", () => {
    const secret = "SENSITIVE_PUBLIC_IDENTIFIER_DO_NOT_EXPORT";
    const publicCase = makeCase(`${secret}-case`, `${secret}-repository`, {
      status: "LABELLED", provenance: "automated-review",
      expectedImpactedFiles: [`src/${secret}.ts`], criticalFiles: [`src/${secret}.ts`],
    }, { synthetic: true, publicSource: { url: "https://example.invalid/public", license: "MIT" } });
    const corpus: FrozenProtocolV1["corpus"] = { kind: "synthetic-smoke", cases: [publicCase] };
    const original = makeFrozenProtocolFixture(corpus);
    const { digest: _digest, ...withoutDigest } = original;
    const rewrittenWithoutDigest = { ...withoutDigest, experimentId: `${secret}-experiment` };
    const protocol = validateFrozenProtocol({
      ...rewrittenWithoutDigest,
      digest: digestCanonical(rewrittenWithoutDigest),
    });
    const report = buildResultReport(protocol, {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: [makeObservation(publicCase.caseId, [], publicCase)],
    }, () => "2026-09-08T00:00:00.000Z");

    const publicSummary = buildPublicSummary(protocol, report);
    const serialized = JSON.stringify(publicSummary);
    if (serialized.includes(secret)) process.stderr.write("PILOT_PUBLIC_IDENTITY_ALLOWLIST_MISMATCH\n");
    expect(serialized).not.toContain(secret);
    expect(publicSummary.experimentId).toMatch(/^experiment-[0-9a-f]{12}$/);
    expect(publicSummary.perRepository[0]?.repositoryAlias).toBe("repository-1");
    expect(publicSummary.perRepository[0]?.publicSource).toEqual({
      url: "https://example.invalid/public", license: "MIT",
    });
    expect(publicSummary.criticalMisses).toEqual([{
      caseId: "case-1", repositoryAlias: "repository-1", missedFileCount: 1,
    }]);
  });

  test("rejects a non-canonical generatedAt before public export", () => {
    const corpus: FrozenProtocolV1["corpus"] = {
      kind: "synthetic-smoke",
      cases: [makeCase("s-1", "repo-a", { status: "UNKNOWN" }, { synthetic: true })],
    };
    const protocol = makeFrozenProtocolFixture(corpus);
    const report = buildResultReport(protocol, {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: [makeObservation("s-1", [], corpus.cases[0])],
    }, () => "SENSITIVE_GENERATED_AT_SENTINEL");
    expect(() => buildPublicSummary(protocol, report)).toThrow(/canonical ISO timestamp/);
  });

  test("never leaks failure-reason free text, stdout/stderr, or local paths", () => {
    const secret = "sk-fake-secret-DO-NOT-LEAK";
    const leakyPath = "C:\\Users\\hoklims\\private-repo";
    const corpus: FrozenProtocolV1["corpus"] = {
      kind: "synthetic-smoke",
      cases: [makeCase("s-1", "repo-a", { status: "UNKNOWN" }, { synthetic: true })],
    };
    const protocol = makeFrozenProtocolFixture(corpus);
    const failedCase: RawCollectionBundleV1["cases"][number] = {
      caseId: "s-1", status: "FAILED", failureReason: `git clone failed: ${secret} at ${leakyPath}`,
      git: null, changedFiles: [], semctx: null, baselineChangedFiles: null, baselineImportNeighborhood: null,
    };
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0", cases: [failedCase],
    };
    const report = buildResultReport(protocol, raw);
    expect(JSON.stringify(report)).toContain(secret); // present in the private report, by design

    const publicSummary = buildPublicSummary(protocol, report);
    const serialized = JSON.stringify(publicSummary);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(leakyPath);
    expect(serialized).not.toContain("failureReason");
    expect(serialized).not.toContain("repo-a");
    expect(serialized).toContain("repository-1");
  });

  test("includes anonymized critical-miss counts for public and private cases without their details", () => {
    const publicCase = makeCase("public-1", "repo-public", {
      status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["public.ts"], criticalFiles: ["public.ts"],
    }, { synthetic: true, publicSource: { url: "https://example.invalid/public", license: "MIT" } });
    const privateCase = makeCase("private-1", "repo-private", {
      status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["private.ts"], criticalFiles: ["private.ts"],
    }, { synthetic: true, headRef: hexHead(2) });
    const corpus: FrozenProtocolV1["corpus"] = { kind: "synthetic-smoke", cases: [publicCase, privateCase] };
    const protocol = makeFrozenProtocolFixture(corpus);
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: [makeObservation("public-1", [], publicCase), makeObservation("private-1", [], privateCase)],
    };
    const report = buildResultReport(protocol, raw);
    expect(report.criticalMisses.map((m) => m.caseId).sort()).toEqual(["private-1", "public-1"]);

    const publicSummary = buildPublicSummary(protocol, report);
    expect(publicSummary.perRepository.map(({ repositoryAlias, publicSource, scores }) => ({
      repositoryAlias, publicSource, hasScores: scores !== null,
    }))).toEqual([
      {
        repositoryAlias: "repository-2", publicSource: null, hasScores: true,
      },
      {
        repositoryAlias: "repository-1",
        publicSource: { url: "https://example.invalid/public", license: "MIT" },
        hasScores: true,
      },
    ]);
    expect(publicSummary.criticalMisses).toEqual([
      { caseId: "case-1", repositoryAlias: "repository-1", missedFileCount: 1 },
      { caseId: "case-2", repositoryAlias: "repository-2", missedFileCount: 1 },
    ]);
    expect(JSON.stringify(publicSummary)).not.toContain("public.ts");
    expect(JSON.stringify(publicSummary)).not.toContain("private.ts");
    expect(JSON.stringify(publicSummary)).not.toContain("repo-public");
    expect(JSON.stringify(publicSummary)).not.toContain("repo-private");
  });

  test("fails closed when a repository alias mixes public and private source declarations", () => {
    const alias = "secret-owner/secret-repo";
    const publicCase = makeCase("public-1", alias, {
      status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["public.ts"], criticalFiles: ["public.ts"],
    }, { synthetic: true, publicSource: { url: "https://example.invalid/public", license: "MIT" } });
    const privateCase = makeCase("private-1", alias, { status: "UNKNOWN" }, { synthetic: true, headRef: hexHead(2) });
    const corpus: FrozenProtocolV1["corpus"] = { kind: "synthetic-smoke", cases: [publicCase, privateCase] };
    const protocol = makeFrozenProtocolFixture(corpus);
    const report = buildResultReport(protocol, {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: [makeObservation("public-1", [], publicCase), makeObservation("private-1", [], privateCase)],
    });
    expect(() => buildPublicSummary(protocol, report)).toThrow(/inconsistent publicSource declarations/);
  });
});

// ============================================================================================
// bounded subprocess execution
// ============================================================================================

describe("runBounded", () => {
  test("captures a real process exit code and finite timing", () => {
    const result = runBounded(["git", "--version"], { cwd: process.cwd(), timeoutMs: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(Number.isFinite(result.durationMs)).toBe(true);
    expect(result.stdout).toContain("git version");
  });

  test("kills a slow child at the timeout and reports it truthfully, never as a normal exit", () => {
    const result = runBounded([process.execPath, "-e", "await new Promise((r) => setTimeout(r, 5000));"], {
      cwd: process.cwd(),
      timeoutMs: 150,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(TIMED_OUT_EXIT_CODE);
  });
});

// ============================================================================================
// baselines
// ============================================================================================

describe("baselines", () => {
  test("extractRelativeImportSpecifiers keeps only relative specifiers", () => {
    const source = `
      import { a } from "./a";
      import "./b";
      export * from "../c";
      import fs from "node:fs";
      const load = async () => import("./d");
    `;
    const specifiers = extractRelativeImportSpecifiers(source, "file.ts");
    expect(specifiers.sort()).toEqual(["../c", "./a", "./b", "./d"]);
  });

  test("one-hop neighborhood includes importers and imports of changed files, excluding the changed files themselves", () => {
    const root = tempDir("semctx-pilot-baseline-");
    const files: ImportGraphFile[] = [
      { relativePath: "changed.ts", absolutePath: join(root, "changed.ts") },
      { relativePath: "importer.ts", absolutePath: join(root, "importer.ts") },
      { relativePath: "imported.ts", absolutePath: join(root, "imported.ts") },
      { relativePath: "unrelated.ts", absolutePath: join(root, "unrelated.ts") },
    ];
    writeFileSync(files[0]!.absolutePath, 'import { x } from "./imported";\nexport const y = x;\n');
    writeFileSync(files[1]!.absolutePath, 'import { y } from "./changed";\nexport const z = y;\n');
    writeFileSync(files[2]!.absolutePath, "export const x = 1;\n");
    writeFileSync(files[3]!.absolutePath, "export const w = 1;\n");

    const neighborhood = oneHopImportNeighborhoodBaseline(root, ["changed.ts"], files);
    expect(neighborhood.sort()).toEqual(["imported.ts", "importer.ts"]);
  });
});
