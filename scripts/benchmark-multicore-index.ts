import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, type SemctxConfigV2 } from "@semantic-context/core";
import { indexRepositoryAsync } from "@semantic-context/app-services";
import { digestCanonical } from "@semantic-context/plane-a-internal";
import { initWorkspace } from "@semantic-context/repository-store";

const capturedAt = "2026-08-25T00:00:00.000Z";

interface BenchmarkResult {
  workers: number;
  used: number;
  mode: string;
  durationMs: number;
  rssBytesAfter: number;
  graphDigest: string;
  sealHash: string;
  nodes: number;
  edges: number;
}

if (process.argv[2] === "--worker-run") {
  const workerRoot = process.argv[3];
  const workers = boundedInteger(process.argv[4], 1, 1, 8);
  if (workerRoot === undefined) throw new Error("benchmark worker run requires a repository root");
  Bun.gc(true);
  const started = performance.now();
  const indexed = await indexRepositoryAsync(workerRoot, capturedAt, workers);
  process.stdout.write(`${JSON.stringify({
    workers,
    used: indexed.parallelism?.used ?? 1,
    mode: indexed.parallelism?.mode ?? "single",
    durationMs: Math.round((performance.now() - started) * 100) / 100,
    rssBytesAfter: process.memoryUsage().rss,
    graphDigest: digestCanonical(indexed.analysis.graph),
    sealHash: indexed.freshnessSeal.sealHash,
    nodes: indexed.analysis.graph.nodes.length,
    edges: indexed.analysis.graph.edges.length,
  })}\n`);
  process.exit(0);
}

const packageCount = boundedInteger(process.argv[2], 24, 1, 200);
const filesPerPackage = boundedInteger(process.argv[3], 20, 2, 200);
const root = mkdtempSync(join(tmpdir(), "semctx-multicore-benchmark-"));

try {
  materializeMonorepo(root, packageCount, filesPerPackage);
  const results: BenchmarkResult[] = [];
  for (const workers of [1, 2, 4] as const) {
    const child = Bun.spawnSync([
      process.execPath,
      import.meta.path,
      "--worker-run",
      root,
      String(workers),
    ], { stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
    results.push(JSON.parse(new TextDecoder().decode(child.stdout)) as BenchmarkResult);
  }
  const identities = new Set(results.map((result) => `${result.graphDigest}:${result.sealHash}`));
  if (identities.size !== 1) throw new Error("benchmark worker counts produced different index bytes");
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    fixture: { packages: packageCount, filesPerPackage, totalTypeScriptFiles: packageCount * filesPerPackage + 1 },
    note: "Observational benchmark only; CI applies no wall-time threshold.",
    results,
  }, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`expected an integer from ${minimum} through ${maximum}, received ${value}`);
  }
  return parsed;
}

function materializeMonorepo(repositoryRoot: string, packages: number, files: number): void {
  writeFileSync(join(repositoryRoot, "package.json"), `${JSON.stringify({
    name: "semctx-multicore-benchmark",
    private: true,
    workspaces: ["packages/*"],
  }, null, 2)}\n`);
  writeFileSync(join(repositoryRoot, ".gitignore"), ".semctx/\n");
  writeFileSync(join(repositoryRoot, "shared.d.ts"), "declare interface BenchmarkContext { value: number }\n");
  for (let packageIndex = 0; packageIndex < packages; packageIndex += 1) {
    const packageName = `package-${String(packageIndex).padStart(3, "0")}`;
    const packageRoot = join(repositoryRoot, "packages", packageName);
    const source = join(packageRoot, "src");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({
      name: `@semctx-benchmark/${packageName}`,
      private: true,
    }, null, 2)}\n`);
    for (let fileIndex = 0; fileIndex < files; fileIndex += 1) {
      const predecessor = fileIndex === 0 ? undefined : `./file-${String(fileIndex - 1).padStart(3, "0")}`;
      writeFileSync(
        join(source, `file-${String(fileIndex).padStart(3, "0")}.ts`),
        `${predecessor === undefined ? "" : `import { value${fileIndex - 1} } from '${predecessor}';\n`}`
          + `export function value${fileIndex}(context: BenchmarkContext): number { return context.value + ${fileIndex}`
          + `${predecessor === undefined ? "" : ` + value${fileIndex - 1}(context)`}; }\n`,
      );
    }
  }
  git(repositoryRoot, "init", "-q");
  git(repositoryRoot, "add", ".");
  git(repositoryRoot, "-c", "user.name=Semctx Benchmark", "-c", "user.email=benchmark@semctx.test", "commit", "-q", "-m", "fixture");
  const config: SemctxConfigV2 = {
    ...createGlobSelectionConfig(repositoryRoot),
    include: ["packages/**/*.ts", "shared.d.ts"],
  };
  initWorkspace(repositoryRoot, config);
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}
