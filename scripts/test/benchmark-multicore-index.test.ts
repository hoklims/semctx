import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { indexHealth, indexRepository } from "@semantic-context/app-services";
import { digestCanonical } from "@semantic-context/plane-a-internal";
import { openStore } from "@semantic-context/repository-store";
import {
  buildPersistedFingerprintComponents,
  buildReturnedFingerprintComponents,
  compareFingerprints,
  FINGERPRINT_COMPONENTS,
  type SampleFingerprint,
} from "../benchmark-multicore-index/fingerprint";
import { captureImplementationIdentity } from "../benchmark-multicore-index/host-identity";
import { materializeCorpus } from "../benchmark-multicore-index/fixtures";
import { expectedParallelism, parallelismMismatch } from "../benchmark-multicore-index/parallelism";
import { buildSamplePlan, WORKER_COUNTS, type SamplePlanEntry } from "../benchmark-multicore-index/plan";
import { observeCpuTime, observePeakRssBytes } from "../benchmark-multicore-index/resource-usage";
import { summarizeDurations, summarizePeakRss } from "../benchmark-multicore-index/summary";

const SCRIPT_PATH = resolve(import.meta.dir, "..", "benchmark-multicore-index.ts");

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function sha(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function buildFingerprint(seed: string): SampleFingerprint {
  const fingerprint = {} as Record<string, string>;
  for (const component of FINGERPRINT_COMPONENTS) fingerprint[component] = sha(`${seed}:${component}`);
  return fingerprint as unknown as SampleFingerprint;
}

describe("buildSamplePlan", () => {
  test("emits the exact deterministic alternating orders, three repetitions each", () => {
    expect(WORKER_COUNTS).toEqual([1, 2, 4]);
    const expected: SamplePlanEntry[] = [
      { position: 0, repetition: 1, workers: 1 },
      { position: 1, repetition: 1, workers: 2 },
      { position: 2, repetition: 1, workers: 4 },
      { position: 3, repetition: 2, workers: 4 },
      { position: 4, repetition: 2, workers: 1 },
      { position: 5, repetition: 2, workers: 2 },
      { position: 6, repetition: 3, workers: 2 },
      { position: 7, repetition: 3, workers: 4 },
      { position: 8, repetition: 3, workers: 1 },
    ];
    expect(buildSamplePlan()).toEqual(expected);
    expect(buildSamplePlan()).toEqual(expected);
  });
});

describe("expectedParallelism / parallelismMismatch", () => {
  const GLOBAL_REASON = "global script: /tmp/fixture/packages/package-000/src/hostile-global-script.ts";
  const AUGMENTATION_REASON = "global or module augmentation: /tmp/fixture/packages/package-000/src/hostile-augmentation.ts";

  test("accepts every path the Ubuntu and macOS CI runs of 2026-09-22 reported", () => {
    const observed = [
      ["disconnected-modules", 1, 1, "single", null],
      ["disconnected-modules", 2, 2, "parallel", null],
      ["disconnected-modules", 4, 4, "parallel", null],
      ["global-script-fallback", 1, 1, "single", null],
      ["global-script-fallback", 2, 1, "preflight-fallback", GLOBAL_REASON],
      ["global-script-fallback", 4, 1, "preflight-fallback", GLOBAL_REASON],
      ["module-augmentation-fallback", 1, 1, "single", null],
      ["module-augmentation-fallback", 2, 1, "preflight-fallback", AUGMENTATION_REASON],
      ["module-augmentation-fallback", 4, 1, "preflight-fallback", AUGMENTATION_REASON],
    ] as const;
    for (const [corpus, requestedWorkers, usedWorkers, mode, reason] of observed) {
      expect(parallelismMismatch(corpus, { requestedWorkers, usedWorkers, mode, reason })).toBeNull();
    }
  });

  test("a disconnected-modules sample that silently ran on one worker is refused", () => {
    const mismatch = parallelismMismatch("disconnected-modules", {
      requestedWorkers: 4, usedWorkers: 1, mode: "single", reason: null,
    });
    expect(mismatch).toContain('expected mode "parallel" with 4 worker(s)');
    expect(mismatch).toContain('observed mode "single" with 1 worker(s)');
  });

  test("a parallel run on fewer workers than requested is refused", () => {
    expect(parallelismMismatch("disconnected-modules", {
      requestedWorkers: 4, usedWorkers: 2, mode: "parallel", reason: null,
    })).not.toBeNull();
  });

  test("a hostile corpus that ran in parallel instead of falling back is refused", () => {
    expect(parallelismMismatch("global-script-fallback", {
      requestedWorkers: 2, usedWorkers: 2, mode: "parallel", reason: null,
    })).toContain('expected mode "preflight-fallback" with 1 worker(s)');
  });

  test("a fallback without its named reason, or with another corpus's reason, is refused", () => {
    expect(parallelismMismatch("module-augmentation-fallback", {
      requestedWorkers: 4, usedWorkers: 1, mode: "preflight-fallback", reason: null,
    })).not.toBeNull();
    expect(parallelismMismatch("module-augmentation-fallback", {
      requestedWorkers: 4, usedWorkers: 1, mode: "preflight-fallback", reason: GLOBAL_REASON,
    })).not.toBeNull();
  });

  test("a single-worker sample carrying a fallback reason is refused", () => {
    expect(parallelismMismatch("disconnected-modules", {
      requestedWorkers: 1, usedWorkers: 1, mode: "single", reason: "unexpected",
    })).not.toBeNull();
  });

  test("the expected path follows the plan's worker counts", () => {
    expect(WORKER_COUNTS.map((workers) => expectedParallelism("disconnected-modules", workers).mode))
      .toEqual(["single", "parallel", "parallel"]);
  });
});

describe("summarizeDurations / summarizePeakRss", () => {
  test("summarizeDurations computes median and range over measured durations", () => {
    expect(summarizeDurations([30, 10, 20])).toEqual({
      status: "MEASURED", observedCount: 3, measuredCount: 3, missingCount: 0, median: 20, min: 10, max: 30, range: 20,
    });
  });

  test("summarizeDurations reports NOT_MEASURED for an empty sample set", () => {
    expect(summarizeDurations([])).toEqual({
      status: "NOT_MEASURED", observedCount: 0, missingCount: 0, reason: "no duration samples",
    });
  });

  test("summarizeDurations refuses a non-finite duration", () => {
    expect(() => summarizeDurations([10, Number.NaN, 30])).toThrow(/non-finite/);
  });

  test("summarizePeakRss ignores NOT_MEASURED observations but keeps their missing count", () => {
    expect(summarizePeakRss([
      { status: "MEASURED", bytes: 100 },
      { status: "NOT_MEASURED", reason: "native maxRSS was 0" },
      { status: "MEASURED", bytes: 300 },
    ])).toEqual({
      status: "MEASURED", observedCount: 3, measuredCount: 2, missingCount: 1, median: 200, min: 100, max: 300, range: 200,
    });
  });

  test("summarizePeakRss reports NOT_MEASURED with the observed count when every sample is missing", () => {
    expect(summarizePeakRss([
      { status: "NOT_MEASURED", reason: "a" },
      { status: "NOT_MEASURED", reason: "b" },
    ])).toEqual({
      status: "NOT_MEASURED", observedCount: 2, missingCount: 2, reason: "no sample reported a native peak RSS (2 sample(s) observed)",
    });
  });

  test("summarizePeakRss refuses a non-finite measured byte count", () => {
    expect(() => summarizePeakRss([{ status: "MEASURED", bytes: Number.NaN }])).toThrow(/non-finite/);
  });
});

describe("observePeakRssBytes / observeCpuTime", () => {
  test("a positive number or bigint maxRSS is measured", () => {
    expect(observePeakRssBytes({ maxRSS: 4096 })).toEqual({ status: "MEASURED", bytes: 4096 });
    expect(observePeakRssBytes({ maxRSS: 4096n })).toEqual({ status: "MEASURED", bytes: 4096 });
  });

  test("zero, negative, non-finite or unsafe-bigint maxRSS is never treated as a zero-memory measurement", () => {
    for (const maxRSS of [0, 0n, -1, -1n, Number.NaN, Number.POSITIVE_INFINITY, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
      const observation = observePeakRssBytes({ maxRSS });
      expect(observation.status).toBe("NOT_MEASURED");
    }
  });

  test("a missing resourceUsage report is NOT_MEASURED, never inferred from a post-run sample", () => {
    expect(observePeakRssBytes(undefined)).toEqual({
      status: "NOT_MEASURED", reason: "subprocess reported no resource usage",
    });
  });

  test("number and bigint CPU time are both measured, including an all-zero valid CPU time", () => {
    expect(observeCpuTime({ cpuTime: { user: 10, system: 20, total: 30 } })).toEqual({
      status: "MEASURED", userMicroseconds: 10, systemMicroseconds: 20, totalMicroseconds: 30,
    });
    expect(observeCpuTime({ cpuTime: { user: 10n, system: 20n, total: 30n } })).toEqual({
      status: "MEASURED", userMicroseconds: 10, systemMicroseconds: 20, totalMicroseconds: 30,
    });
    expect(observeCpuTime({ cpuTime: { user: 0, system: 0, total: 0 } })).toEqual({
      status: "MEASURED", userMicroseconds: 0, systemMicroseconds: 0, totalMicroseconds: 0,
    });
  });

  test("undefined, negative or unsafe-bigint CPU fields are NOT_MEASURED", () => {
    expect(observeCpuTime(undefined)).toEqual({
      status: "NOT_MEASURED", reason: "subprocess reported no native CPU time",
    });
    expect(observeCpuTime({ cpuTime: undefined })).toEqual({
      status: "NOT_MEASURED", reason: "subprocess reported no native CPU time",
    });
    expect(observeCpuTime({ cpuTime: { user: -1, system: 0, total: 0 } }).status).toBe("NOT_MEASURED");
    expect(observeCpuTime({ cpuTime: { user: 0, system: BigInt(Number.MAX_SAFE_INTEGER) + 1n, total: 0 } }).status).toBe("NOT_MEASURED");
  });

  test("unsafe numeric native counters cannot be reported as precise measurements", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    expect(observePeakRssBytes({ maxRSS: unsafe }).status).toBe("NOT_MEASURED");
    expect(observeCpuTime({ cpuTime: { user: 0, system: unsafe, total: unsafe } }).status).toBe("NOT_MEASURED");
  });
});

describe("compareFingerprints", () => {
  test("rejects an empty sample set", () => {
    expect(() => compareFingerprints([])).toThrow(/at least one sample/);
  });

  test("rejects a sample missing a fingerprint component", () => {
    const baseline = buildFingerprint("baseline") as unknown as Record<string, unknown>;
    delete baseline["seal"];
    expect(() => compareFingerprints([baseline as unknown as SampleFingerprint])).toThrow(/sample 0/);
  });

  test("rejects a malformed (non-sha256-shaped) component value", () => {
    const baseline = buildFingerprint("baseline");
    const candidate = { ...buildFingerprint("baseline"), returnedGraph: "not-a-digest" };
    expect(() => compareFingerprints([baseline, candidate])).toThrow(/returnedGraph/);
  });

  test("equivalent, identical repeated samples are accepted", () => {
    const baseline = buildFingerprint("baseline");
    const repeated = buildFingerprint("baseline");
    expect(compareFingerprints([baseline, repeated, { ...repeated }])).toEqual({ equivalent: true });
  });

  test.each([...FINGERPRINT_COMPONENTS])(
    "a divergence isolated to \"%s\" is reported as exactly that component, independent of the others",
    (component) => {
      const baseline = buildFingerprint("baseline");
      const candidate = { ...buildFingerprint("baseline"), [component]: sha(`divergent:${component}`) };
      expect(compareFingerprints([baseline, candidate])).toEqual({
        equivalent: false, divergentSampleIndex: 1, component,
      });
    },
  );
});

describe("persisted logical metadata", () => {
  test("fingerprints non-empty real claims and diagnostics rather than constant placeholders", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "semctx-benchmark-object-test-")));
    try {
      materializeCorpus("disconnected-modules", root, { packages: 1, filesPerPackage: 2 });
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs", "notes.md"), "---\ntype: doc\ncontradicts: [docs/absent.md]\n---\n\n# Notes\n");
      writeFileSync(join(root, "packages", "package-000", "src", "annotated.ts"),
        "/** @invariant positive: result must be positive */\nexport function positive(): number { return 1; }\n");
      const configPath = join(root, ".semctx", "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8")) as { include: string[] };
      config.include.push("docs/**/*.md");
      writeFileSync(configPath, `${JSON.stringify(config)}\n`);
      const indexed = indexRepository(root, "2026-08-25T00:00:00.000Z");
      expect(indexed.claims.length).toBeGreaterThan(0);
      expect(indexed.analysis.unresolvedReferences.length).toBeGreaterThan(0);
      const before = buildReturnedFingerprintComponents(indexed);
      expect(buildReturnedFingerprintComponents({ ...indexed, claims: [] }).returnedClaims)
        .not.toBe(before.returnedClaims);
      expect(buildReturnedFingerprintComponents({
        ...indexed, analysis: { ...indexed.analysis, unresolvedReferences: [] },
      }).returnedDiagnostic).not.toBe(before.returnedDiagnostic);
      const persisted = buildPersistedFingerprintComponents(root);
      expect(persisted.persistedClaims).toBe(before.returnedClaims);
      expect(persisted.persistedIndexHealth).toBe(digestCanonical(indexHealth(root)));
      expect(persisted.persistedIndexHealth).not.toBe(digestCanonical([]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects changed stored metadata even when graph and health projection agree", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "semctx-benchmark-metadata-test-")));
    try {
      materializeCorpus("disconnected-modules", root, { packages: 1, filesPerPackage: 2 });
      indexRepository(root, "2026-08-25T00:00:00.000Z");
      const before = buildPersistedFingerprintComponents(root);
      const writer = openStore(root);
      try {
        writer.setMeta("indexed_repository_graph_hash", sha("corrupted stored graph identity"));
      } finally {
        writer.close();
      }
      const after = buildPersistedFingerprintComponents(root);
      expect(after.persistedGraph).toBe(before.persistedGraph);
      expect(after.persistedIndexHealth).toBe(before.persistedIndexHealth);
      expect(after).not.toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("captureImplementationIdentity", () => {
  test("an untracked helper's presence and content change the state identity while tracked HEAD stays fixed", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "semctx-benchmark-identity-test-")));
    try {
      git(root, ["init", "-q"]);
      writeFileSync(join(root, "tracked.txt"), "tracked\n");
      git(root, ["add", "."]);
      git(root, ["-c", "user.name=Semctx Benchmark Test", "-c", "user.email=benchmark-test@semctx.test", "commit", "-q", "-m", "baseline"]);

      const beforeUntracked = captureImplementationIdentity(root);
      expect(beforeUntracked.repositoryRoot).toBe(realpathSync.native(root).replace(/\\/g, "/"));

      writeFileSync(join(root, "untracked-helper.ts"), "export const helper = 1;\n");
      const afterAddingUntracked = captureImplementationIdentity(root);
      expect(afterAddingUntracked.gitState.headCommit).toBe(beforeUntracked.gitState.headCommit);
      expect(afterAddingUntracked.gitState.headTreeHash).toBe(beforeUntracked.gitState.headTreeHash);
      expect(afterAddingUntracked.gitState.indexStateHash).toBe(beforeUntracked.gitState.indexStateHash);
      expect(afterAddingUntracked.gitState.contentStateHash).not.toBe(beforeUntracked.gitState.contentStateHash);
      expect(afterAddingUntracked.gitState.repositoryStateHash).not.toBe(beforeUntracked.gitState.repositoryStateHash);
      expect(afterAddingUntracked.gitState.workingStateHash).not.toBe(beforeUntracked.gitState.workingStateHash);

      writeFileSync(join(root, "untracked-helper.ts"), "export const helper = 2;\n");
      const afterEditingUntracked = captureImplementationIdentity(root);
      expect(afterEditingUntracked.gitState.headCommit).toBe(beforeUntracked.gitState.headCommit);
      expect(afterEditingUntracked.gitState.headTreeHash).toBe(beforeUntracked.gitState.headTreeHash);
      expect(afterEditingUntracked.gitState.contentStateHash).not.toBe(afterAddingUntracked.gitState.contentStateHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("script entrypoint boundary", () => {
  test("importing the script as a module runs no benchmark and produces no output", async () => {
    const scriptUrl = pathToFileURL(SCRIPT_PATH).href;
    const child = Bun.spawnSync(
      [process.execPath, "--eval", `await import(${JSON.stringify(scriptUrl)});`],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
    expect(new TextDecoder().decode(child.stdout)).toBe("");
  }, 30_000);

  test.each([
    ["0", "20", /expected an integer from 1 through 200/],
    ["24", "1", /expected an integer from 2 through 200/],
    ["abc", "20", /expected an integer from 1 through 200/],
  ] as const)("an invalid CLI dimension (%s packages, %s files) exits nonzero before any indexing runs", (packages, files, message) => {
    const child = Bun.spawnSync([process.execPath, SCRIPT_PATH, packages, files], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(child.stderr)).toMatch(message);
    expect(new TextDecoder().decode(child.stdout)).toBe("");
  }, 30_000);
});
