import { appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export type CiProfile = "contract" | "full" | "focused";
export type CiOs = "ubuntu-latest" | "windows-latest" | "macos-15";

export interface CiLane {
  os: CiOs;
  profile: CiProfile;
  targets: string;
  smoke: "true" | "false";
  /** `index/count` slice of the lane's test files, or "" for a lane that runs them all. */
  shard: string;
}

export interface CiPlan {
  mode: "docs" | "routing" | "affected" | "fallback";
  reason: string;
  matrix: { include: CiLane[] };
}

const PACKAGE_NAMES = new Set([
  "app-services", "change-authorization-verifier", "cocoindex-adapter", "context-engine",
  "control-engine", "control-model", "core", "eval", "github-action", "mcp-server",
  "plane-a-internal", "python-analyzer", "repository-store", "semantic-dsl",
  "semantic-engine", "semantic-model", "test-fixtures", "ts-analyzer",
  "workspace-analyzer-internal",
]);

const ROUTING_PATHS = new Set([
  ".github/workflows/ci.yml",
  "scripts/ci-plan.ts",
  "scripts/ci-gate.ts",
  "scripts/test/ci-plan.test.ts",
  "scripts/test/ci-gate.test.ts",
  "scripts/test/governance-files.test.ts",
]);

const ROOT_DOCUMENTS = new Set([
  "README.md", "README.fr.md", "CONTRIBUTING.md", "CHANGELOG.md", "SECURITY.md", "ROADMAP.md",
  ".github/pull_request_template.md",
]);

export const ROUTING_TESTS = [
  "scripts/test/ci-plan.test.ts",
  "scripts/test/ci-gate.test.ts",
  "scripts/test/governance-files.test.ts",
];

export const FOCUSED_TEST_TARGETS = new Set([
  ...[...PACKAGE_NAMES].map((name) => `packages/${name}/test`),
  "apps/cli/test",
  "plugins",
  "scripts/test/benchmark-multicore-index.test.ts",
  ...ROUTING_TESTS,
]);

// Test files stay serial inside a runner, as in the canonical gate, so per-test timing margins are
// those of one host. Suite lanes are split by file across this many runners per OS instead.
export const TEST_SHARDS: Readonly<Record<CiOs, number>> = {
  "ubuntu-latest": 2,
  "windows-latest": 4,
  "macos-15": 2,
};

function lane(os: CiOs, profile: CiProfile, targets = "", smoke = false): CiLane {
  return { os, profile, targets, smoke: smoke ? "true" : "false", shard: "" };
}

function sharded(suite: CiLane): CiLane[] {
  const count = TEST_SHARDS[suite.os];
  return Array.from({ length: count }, (_, index) => ({ ...suite, shard: `${index + 1}/${count}` }));
}

const CONTRACT = lane("ubuntu-latest", "contract");
const CROSS_OS: readonly CiOs[] = ["windows-latest", "macos-15"];

function fallback(reason: string): CiPlan {
  return {
    mode: "fallback",
    reason,
    matrix: { include: [CONTRACT, ...sharded(lane("ubuntu-latest", "full", "", true)),
      ...CROSS_OS.flatMap((os) => sharded(lane(os, "full", "", true)))] },
  };
}

function validPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\")
    && !path.split("/").some((part) => part === "" || part === "." || part === "..")
    && !/[\r\n\0]/.test(path);
}

function isWorkerPath(path: string): boolean {
  return path === "packages/app-services/src/indexing.ts"
    || path === "packages/app-services/src/plane-a-runtime.ts"
    || path.startsWith("packages/ts-analyzer/")
    || path === "scripts/benchmark-multicore-index.ts"
    || path.startsWith("scripts/benchmark-multicore-index/")
    || path === "scripts/test/benchmark-multicore-index.test.ts";
}

function isDocumentationPath(path: string): boolean {
  return ROOT_DOCUMENTS.has(path) || (path.startsWith("docs/") && path.endsWith(".md"))
    || (path.startsWith("docs/assets/") && path.endsWith(".svg"));
}

export function planForPaths(paths: readonly string[], targetExists: (path: string) => boolean): CiPlan {
  if (paths.length === 0) return fallback("empty diff");
  const targets = new Set<string>();
  let hasSource = false;
  let hasRouting = false;
  let hasDocs = false;
  let smoke = false;

  for (const path of paths) {
    if (!validPath(path)) return fallback("invalid path");
    if (ROUTING_PATHS.has(path)) {
      hasRouting = true;
      continue;
    }
    if (isDocumentationPath(path)) {
      hasDocs = true;
      continue;
    }
    const packageMatch = /^packages\/([^/]+)\//.exec(path);
    if (packageMatch !== null) {
      const name = packageMatch[1]!;
      if (!PACKAGE_NAMES.has(name)) return fallback("unknown package");
      targets.add(`packages/${name}/test`);
      hasSource = true;
    } else if (path.startsWith("apps/cli/")) {
      targets.add("apps/cli/test");
      hasSource = true;
    } else if (path.startsWith("plugins/")) {
      targets.add("plugins");
      hasSource = true;
    } else if (isWorkerPath(path)) {
      targets.add("scripts/test/benchmark-multicore-index.test.ts");
      hasSource = true;
    } else if (path.startsWith("site/") || path.startsWith("examples/")
      || path.startsWith("benchmarks/")) {
      hasSource = true;
    } else {
      return fallback("unclassified path");
    }
    smoke ||= isWorkerPath(path);
  }

  if (!hasSource && !hasRouting) {
    return { mode: "docs", reason: "documentation only", matrix: { include: [CONTRACT] } };
  }
  if (!hasSource && hasRouting) {
    if (ROUTING_TESTS.some((target) => !targetExists(target))) return fallback("missing routing test target");
    return { mode: "routing", reason: hasDocs ? "routing and documentation" : "routing only",
      matrix: { include: [CONTRACT, ...CROSS_OS.map((os) =>
        lane(os, "focused", ROUTING_TESTS.join(",")))] } };
  }
  if (hasRouting) ROUTING_TESTS.forEach((target) => targets.add(target));
  for (const target of targets) {
    if (!targetExists(target)) return fallback("missing test target");
  }
  const focusedTargets = [...targets].sort().join(",");
  const matrix = [CONTRACT, ...sharded(lane("ubuntu-latest", "full", "", smoke))];
  if (focusedTargets.length > 0) {
    matrix.push(...CROSS_OS.flatMap((os) => sharded(lane(os, "focused", focusedTargets, smoke))));
  } else if (smoke) {
    matrix.push(...CROSS_OS.flatMap((os) =>
      sharded(lane(os, "focused", "scripts/test/benchmark-multicore-index.test.ts", true))));
  }
  return { mode: "affected", reason: "source or integration change", matrix: { include: matrix } };
}

export function changedPaths(base: string, cwd = process.cwd()): string[] | null {
  const child = Bun.spawnSync(["git", "diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`],
    { cwd, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) return null;
  const bytes = child.stdout;
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).slice(0, -1).split("\0");
  } catch {
    return null;
  }
}

export function planFromGit(base: string, cwd = process.cwd()): CiPlan {
  const paths = changedPaths(base, cwd);
  return paths === null ? fallback("diff unavailable")
    : planForPaths(paths, (target) => existsSync(resolve(cwd, target)));
}

if (import.meta.main) {
  const base = process.env.SEMCTX_VERIFY_BASE || "origin/main";
  const event = process.env.GITHUB_EVENT_NAME;
  const plan = event !== undefined && event !== "pull_request" && event !== "push"
    ? fallback("unsupported event") : planFromGit(base);
  const matrix = JSON.stringify(plan.matrix);
  console.log(`[ci-plan] ${plan.mode}: ${plan.reason}; ${plan.matrix.include.length} lane(s)`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\nmode=${plan.mode}\n`);
  } else {
    console.log(JSON.stringify(plan));
  }
}
