import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, planForPaths, planFromGit, TEST_SHARDS, type CiLane } from "../ci-plan";

const present = () => true;
const rows = (paths: string[]) => planForPaths(paths, present).matrix.include;
const lanes = (paths: string[]) => rows(paths).map((row) => [row.os, row.profile, row.shard]);

const UBUNTU_FULL = [["ubuntu-latest", "full", "1/2"], ["ubuntu-latest", "full", "2/2"]];
const shards = (os: CiLane["os"], profile: CiLane["profile"]) =>
  Array.from({ length: TEST_SHARDS[os] }, (_, index) => [os, profile, `${index + 1}/${TEST_SHARDS[os]}`]);

describe("adaptive CI plan", () => {
  test("documentation uses the contract lane; gate wiring also exercises the runner on both other OSes", () => {
    expect(planForPaths(["docs/reference/cli.md"], present).mode).toBe("docs");
    expect(lanes(["docs/reference/cli.md"])).toEqual([
      ["ubuntu-latest", "contract", ""],
    ]);
    expect(planForPaths([".github/workflows/ci.yml", "docs/adr/0013-contributor-autonomy-and-required-ci.md"], present).mode)
      .toBe("routing");
    expect(lanes(["scripts/ci-plan.ts"])).toEqual([
      ["ubuntu-latest", "contract", ""],
      ["windows-latest", "focused", ""],
      ["macos-15", "focused", ""],
    ]);
    expect(rows(["scripts/ci-plan.ts"]).slice(1).every((row) =>
      row.targets.includes("scripts/test/ci-plan.test.ts"))).toBe(true);
  });

  test("the translated README and the SVG figures it embeds are documentation; other docs data is not", () => {
    const readme = ["README.fr.md", "README.md", "docs/assets/readme/hero-dark.svg"];
    expect(planForPaths(readme, present).mode).toBe("docs");
    expect(lanes(readme)).toEqual([["ubuntu-latest", "contract", ""]]);
    expect(planForPaths(["docs/pilot/public-corpus-2026-09-08.json"], present).mode).toBe("fallback");
    expect(planForPaths(["docs/assets/readme/figure.js"], present).mode).toBe("fallback");
  });

  test("a product change runs the full Ubuntu gate and affected package tests on both other OSes", () => {
    const targets = "apps/cli/test,packages/app-services/test";
    const product = rows(["apps/cli/src/commands/install.ts", "packages/app-services/src/plugin-delivery.ts"]);
    expect(product[0]).toEqual({ os: "ubuntu-latest", profile: "contract", targets: "", smoke: "false", shard: "" });
    expect(product.slice(1).map((row) => [row.os, row.profile, row.shard])).toEqual([
      ...UBUNTU_FULL, ...shards("windows-latest", "focused"), ...shards("macos-15", "focused"),
    ]);
    expect(product.slice(1).map((row) => row.targets)).toEqual(product.slice(1).map((row) =>
      row.profile === "full" ? "" : targets));
    expect(product.every((row) => row.smoke === "false")).toBe(true);
  });

  test("Markdown inside plugins and packages is domain content, not documentation-only", () => {
    const plugin = rows(["plugins/shared/skills/semctx-control/SKILL.md"]);
    expect(plugin.map((row) => [row.os, row.profile, row.shard])).toEqual([
      ["ubuntu-latest", "contract", ""], ...UBUNTU_FULL,
      ...shards("windows-latest", "focused"), ...shards("macos-15", "focused"),
    ]);
    expect(plugin.filter((row) => row.profile === "focused").every((row) => row.targets === "plugins")).toBe(true);
    expect(rows(["packages/app-services/README.md"]).find((row) => row.profile === "focused")?.targets)
      .toBe("packages/app-services/test");
    expect(planForPaths(["scripts/README.md"], present).mode).toBe("fallback");
  });

  test("worker source also executes real small equivalence on all three OSes", () => {
    const workerRows = rows(["packages/ts-analyzer/src/index-worker.ts"]);
    expect(workerRows.filter((row) => row.smoke === "true").map((row) => [row.os, row.profile, row.shard])).toEqual([
      ...UBUNTU_FULL, ...shards("windows-latest", "focused"), ...shards("macos-15", "focused"),
    ]);
    expect(workerRows.filter((row) => row.profile === "focused").every((row) => row.targets === "packages/ts-analyzer/test"))
      .toBe(true);
    expect(new Set(rows(["packages/app-services/src/plane-a-runtime.ts"]).filter((row) => row.smoke === "true")
      .map((row) => row.os))).toEqual(new Set(["ubuntu-latest", "windows-latest", "macos-15"]));
  });

  test("every suite lane is split into one complete shard set per host; contract and routing lanes are whole", () => {
    expect(TEST_SHARDS).toEqual({ "ubuntu-latest": 2, "windows-latest": 4, "macos-15": 2 });
    const plans = [
      ["package.json"], ["packages/app-services/src/plane-a-runtime.ts"], ["plugins/claude-code/src/guard.ts"],
      ["scripts/ci-plan.ts"], ["docs/reference/cli.md"],
    ].map((paths) => planForPaths(paths, present));
    expect(plans.map((plan) => plan.mode)).toEqual(["fallback", "affected", "affected", "routing", "docs"]);
    for (const plan of plans) {
      const groups = new Map<string, string[]>();
      for (const row of plan.matrix.include) {
        if (row.profile === "contract" || plan.mode === "routing") {
          expect(row.shard).toBe("");
          continue;
        }
        const key = JSON.stringify([row.os, row.profile, row.targets, row.smoke]);
        groups.set(key, [...(groups.get(key) ?? []), row.shard]);
      }
      for (const [key, observed] of groups) {
        const os = (JSON.parse(key) as [CiLane["os"]])[0];
        expect(observed).toEqual(shards(os, "full").map((row) => row[2]!));
      }
    }
  });

  test.each([
    ["package.json"],
    ["bun.lock"],
    [".github/workflows/release.yml"],
    ["packages/new-domain/src/index.ts"],
    ["AGENTS.md"],
    ["scripts/unknown-verifier.ts"],
    ["docs/reference/cli.md", "package.json"],
    [],
  ].map((paths) => ({ paths })))("falls back to full cross-platform proof for unknown or sensitive paths: %j", ({ paths }) => {
    const plan = planForPaths(paths, present);
    expect(plan.mode).toBe("fallback");
    expect(plan.matrix.include.map((row) => [row.os, row.profile, row.shard])).toEqual([
      ["ubuntu-latest", "contract", ""],
      ...UBUNTU_FULL,
      ...shards("windows-latest", "full"),
      ...shards("macos-15", "full"),
    ]);
  });

  test("a missing focused test root cannot silently omit that host", () => {
    expect(planForPaths(["apps/cli/src/commands/install.ts"], () => false).mode).toBe("fallback");
  });

  test("rejects malformed path bytes and never returns an empty matrix", () => {
    for (const path of ["../packages/core/src/index.ts", "packages\\core\\src\\index.ts", "docs/a\nb.md", ""] ) {
      const plan = planForPaths([path], present);
      expect(plan.mode).toBe("fallback");
      expect(plan.matrix.include.length).toBeGreaterThan(0);
    }
  });
});

test("Git diff treats a rename as both deletion and addition and missing base as maximal", () => {
  const cwd = mkdtempSync(join(tmpdir(), "semctx-ci-plan-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    git("init", "--quiet");
    git("config", "user.email", "ci-plan@example.invalid");
    git("config", "user.name", "CI Plan Test");
    writeFileSync(join(cwd, "old.md"), "old\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("mv", "old.md", "AGENTS.md");
    git("commit", "--quiet", "-m", "rename");
    expect(changedPaths(base, cwd)).toEqual(["AGENTS.md", "old.md"]);
    expect(planFromGit(base, cwd).mode).toBe("fallback");
    expect(planFromGit("missing-base", cwd).mode).toBe("fallback");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
