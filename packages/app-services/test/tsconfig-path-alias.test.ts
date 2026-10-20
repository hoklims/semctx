import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChangeImpactReportSchema, type ChangeImpactReport, type SemctxConfig } from "@semantic-context/core";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import { discoverFiles } from "@semantic-context/ts-analyzer";
import { controlStatus, fingerprintAnalysisInputs, indexRepository, indexRepositoryAsync, runChangeImpact, runVerify } from "../src";

/**
 * Issue #354: a repository that imports exclusively by tsconfig `paths` alias used to index with
 * no `imports` edge, no cross-file `calls` edge and no test link, so impact and verification
 * returned empty sets that read as "nothing depends on this".
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(
    ["git", "-c", "core.autocrlf=false", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", ...args],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const tsconfig = (paths: Record<string, string[]>): string => JSON.stringify({
  compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, rootDir: ".", noEmit: true, paths },
  include: ["src"],
}, null, 2) + "\n";

const ALIAS = { "@r/pkg/*": ["./src/*", "./src/*.ts"] };

function aliasRepository(indexNow = true): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "semctx-path-alias-"))).replaceAll("\\", "/");
  roots.push(root);
  write(root, {
    ".gitignore": ".semctx/\n",
    "package.json": JSON.stringify({ name: "repro-root", private: true, packageManager: "pnpm@10.0.0" }),
    "pnpm-workspace.yaml": 'packages:\n  - "pkg"\n',
    "pkg/package.json": JSON.stringify({ name: "@r/pkg", version: "1.0.0" }),
    "pkg/tsconfig.json": tsconfig(ALIAS),
    "pkg/src/feat/handler.ts": "export function handle(n: number): number { return n + 1; }\n",
    "pkg/src/feat/alias-js-user.ts": 'import { handle } from "@r/pkg/feat/handler.js";\nexport function viaAliasJs(): number { return handle(1); }\n',
    "pkg/src/feat/alias-noext-user.ts": 'import { handle } from "@r/pkg/feat/handler";\nexport function viaAliasNoExt(): number { return handle(1); }\n',
    "pkg/src/feat/relative-user.ts": 'import { handle } from "./handler.js";\nexport function viaRelative(): number { return handle(2); }\n',
    "pkg/src/feat/handler.spec.ts": 'import { handle } from "@r/pkg/feat/handler.js";\nexport const result = handle(3);\n',
  });
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");
  initWorkspace(root, {
    version: 2,
    selectionMode: "globs-v1",
    include: ["pkg/**/*.ts"],
    exclude: [],
    languages: { typescript: "on", javascript: "off", python: "off", markdown: "off", sql: "off" },
  });
  if (indexNow) indexRepository(root, "2026-10-14T10:00:00.000Z");
  return root;
}

const reached = (report: ChangeImpactReport): string[] => [
  ...(report.directlyAffected ?? []),
  ...(report.transitivelyAffected ?? []),
  ...(report.possiblyAffected ?? []),
].map(target => target.id).sort();

describe("tsconfig path aliases in an indexed TypeScript-only repository", () => {
  it("reaches the aliased importers and their test from a change to the target", () => {
    const root = aliasRepository();
    const store = openStore(root);
    try {
      const graph = store.loadGraph();
      const imports = graph.edges.filter(edge => edge.kind === "imports").map(edge => `${edge.from} -> ${edge.to}`).sort();
      expect(imports).toEqual([
        "mod:pkg/src/feat/alias-js-user.ts -> mod:pkg/src/feat/handler.ts",
        "mod:pkg/src/feat/alias-noext-user.ts -> mod:pkg/src/feat/handler.ts",
        "mod:pkg/src/feat/relative-user.ts -> mod:pkg/src/feat/handler.ts",
        "test:pkg/src/feat/handler.spec.ts -> mod:pkg/src/feat/handler.ts",
      ]);
    } finally {
      store.close();
    }
    write(root, { "pkg/src/feat/handler.ts": "export function handle(n: number): number { return n + 2; }\n" });

    const impact = runChangeImpact(root, { kind: "working-tree" });
    ChangeImpactReportSchema.parse(impact);
    expect(reached(impact)).toEqual(expect.arrayContaining([
      "sym:function:pkg/src/feat/alias-js-user.ts:viaAliasJs",
      "sym:function:pkg/src/feat/alias-noext-user.ts:viaAliasNoExt",
      "sym:function:pkg/src/feat/relative-user.ts:viaRelative",
      "test:pkg/src/feat/handler.spec.ts",
    ]));
    expect(impact.blastRadius.scope).not.toBe("unknown");

    const verification = runVerify(root, { kind: "working-tree" }).report;
    expect(verification.recommendedTests.map(test => test.file)).toContain("pkg/src/feat/handler.spec.ts");
  });

  // `semctx index` runs the asynchronous path with one worker unless told otherwise.
  it("indexes the alias edges through the default single-worker path", async () => {
    const root = aliasRepository(false);
    const index = await indexRepositoryAsync(root, "2026-10-14T10:00:00.000Z", 1);
    expect(index.parallelism).toMatchObject({ requested: 1, mode: "single" });
    const store = openStore(root);
    try {
      const imports = store.loadGraph().edges.filter(edge => edge.kind === "imports").map(edge => edge.from).sort();
      expect(imports).toEqual([
        "mod:pkg/src/feat/alias-js-user.ts",
        "mod:pkg/src/feat/alias-noext-user.ts",
        "mod:pkg/src/feat/relative-user.ts",
        "test:pkg/src/feat/handler.spec.ts",
      ]);
    } finally {
      store.close();
    }
  });

  it("withdraws the index when the alias mapping changes", () => {
    const root = aliasRepository();
    expect(controlStatus(root).verdict).toBe("FRESH");
    write(root, { "pkg/tsconfig.json": tsconfig({ "@r/pkg/*": ["./elsewhere/*"] }) });
    // The tracked configuration also differs from the indexed working diff; the analysis input
    // reason is the one that withdraws the alias edges, whatever else is reported.
    const stale = controlStatus(root);
    expect(stale.verdict).toBe("STALE");
    expect(stale.reasons).toContain("ANALYSIS_INPUT_MISMATCH");
    write(root, { "pkg/tsconfig.json": tsconfig(ALIAS) });
    expect(controlStatus(root).verdict).toBe("FRESH");
  });
});

/**
 * The same reproduction in a version 1 configuration, which a repository created before
 * configuration v2 still uses: its tests import by alias, so no test link was produced and
 * `verify` reported invariant-constrained code as changed without a covering test.
 */
const BASE_URL_TSCONFIG = (paths: Record<string, string[]>): string => JSON.stringify({
  compilerOptions: { baseUrl: ".", paths, moduleResolution: "bundler", module: "esnext", target: "es2022" },
}, null, 2) + "\n";

function v1Repository(tsconfigText: string, indexNow = true): { root: string; config: SemctxConfig } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "semctx-path-alias-v1-"))).replaceAll("\\", "/");
  roots.push(root);
  write(root, {
    ".gitignore": ".semctx/\n",
    "tsconfig.json": tsconfigText,
    "src/lib/guard.ts": "export function guard(enabled: boolean): boolean {\n  return enabled;\n}\n",
    "src/lib/relative-user.ts": 'import { guard } from "./guard";\nexport function viaRelative(): boolean { return guard(true); }\n',
    "src/lib/alias-user.ts": 'import { guard } from "@/lib/guard";\nexport function viaAlias(): boolean { return guard(true); }\n',
    "src/__tests__/guard.test.ts": 'import { guard } from "@/lib/guard";\nexport const denied = guard(false);\n',
  });
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");
  const config = initWorkspace(root, { version: 1, include: ["src/**/*.ts"], exclude: [], testGlobs: ["**/*.test.ts"] });
  if (indexNow) indexRepository(root, "2026-10-14T10:00:00.000Z");
  return { root, config };
}

describe("tsconfig path aliases in a version 1 configuration", () => {
  const ALIAS_PATHS = { "@/*": ["./src/*"] };

  it("links a test that imports by alias exactly as it links one that imports relatively", () => {
    const { root } = v1Repository(BASE_URL_TSCONFIG(ALIAS_PATHS));
    const store = openStore(root);
    try {
      const graph = store.loadGraph();
      const guard = "sym:function:src/lib/guard.ts:guard";
      expect(graph.edges.filter(edge => edge.kind === "imports").map(edge => `${edge.from} -> ${edge.to}`).sort()).toEqual([
        "mod:src/lib/alias-user.ts -> mod:src/lib/guard.ts",
        "mod:src/lib/relative-user.ts -> mod:src/lib/guard.ts",
        "test:src/__tests__/guard.test.ts -> mod:src/lib/guard.ts",
      ]);
      expect(graph.edges.filter(edge => edge.kind === "tested_by").map(edge => `${edge.from} -> ${edge.to}`)).toEqual([`${guard} -> test:src/__tests__/guard.test.ts`]);
      expect(graph.edges.filter(edge => edge.kind === "covers").map(edge => `${edge.from} -> ${edge.to}`)).toEqual([`test:src/__tests__/guard.test.ts -> ${guard}`]);
    } finally {
      store.close();
    }
  });

  it("recommends the aliased test when the guarded symbol changes", () => {
    const { root } = v1Repository(BASE_URL_TSCONFIG(ALIAS_PATHS));
    write(root, { "src/lib/guard.ts": "export function guard(enabled: boolean): boolean {\n  return enabled === true;\n}\n" });
    const verification = runVerify(root, { kind: "working-tree" }).report;
    expect(verification.recommendedTests.map(test => test.file)).toContain("src/__tests__/guard.test.ts");
  });

  it("withdraws the index when the alias mapping changes", () => {
    const { root } = v1Repository(BASE_URL_TSCONFIG(ALIAS_PATHS));
    expect(controlStatus(root).verdict).toBe("FRESH");
    write(root, { "tsconfig.json": BASE_URL_TSCONFIG({ "@/*": ["./elsewhere/*"] }) });
    const stale = controlStatus(root);
    expect(stale.verdict).toBe("STALE");
    expect(stale.reasons).toContain("ANALYSIS_INPUT_MISMATCH");
    write(root, { "tsconfig.json": BASE_URL_TSCONFIG(ALIAS_PATHS) });
    expect(controlStatus(root).verdict).toBe("FRESH");
  });

  it("binds the configuration into the analysis input identity only while it can change a resolution", () => {
    const { root, config } = v1Repository(BASE_URL_TSCONFIG(ALIAS_PATHS), false);
    const identity = (tsconfigText: string): string => {
      write(root, { "tsconfig.json": tsconfigText });
      return fingerprintAnalysisInputs(config, discoverFiles(config));
    };
    const plain = JSON.stringify({ compilerOptions: { strict: true } });
    // No `paths` or `baseUrl`: the identity of a version 1 repository is what it was before.
    expect(identity(plain)).toBe(identity(JSON.stringify({ compilerOptions: { strict: false } })));
    // A governing mapping: its content is part of the identity.
    expect(identity(BASE_URL_TSCONFIG(ALIAS_PATHS))).not.toBe(identity(BASE_URL_TSCONFIG({ "@/*": ["./elsewhere/*"] })));
    expect(identity(BASE_URL_TSCONFIG(ALIAS_PATHS))).not.toBe(identity(plain));
  });

  it.each([false, true])("binds every selected package configuration (inherited: %s)", (inherited) => {
    const { root } = v1Repository(JSON.stringify({ compilerOptions: { strict: true } }), false);
    const mapping = BASE_URL_TSCONFIG({ "@local/*": ["./impl/*"] });
    const changedMapping = BASE_URL_TSCONFIG({ "@local/*": ["./other/*"] });
    write(root, {
      "src/a/tsconfig.json": mapping,
      "src/a/impl/guard.ts": "export function localGuard(): boolean { return true; }\n",
      "src/a/guard.test.ts": 'import { localGuard } from "@local/guard";\nexport const result = localGuard();\n',
      "src/b/tsconfig.json": inherited ? JSON.stringify({ extends: "./tsconfig.base.json" }) : mapping,
      ...(inherited ? { "src/b/tsconfig.base.json": mapping } : {}),
      "src/b/impl/guard.ts": "export function localGuard(): boolean { return true; }\n",
      "src/b/other/guard.ts": "export function localGuard(): boolean { return false; }\n",
      "src/b/guard.test.ts": 'import { localGuard } from "@local/guard";\nexport const result = localGuard();\n',
    });
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "independent package configurations");
    indexRepository(root, "2026-10-20T10:00:00.000Z");
    expect(controlStatus(root).verdict).toBe("FRESH");
    const mappingPath = inherited ? "src/b/tsconfig.base.json" : "src/b/tsconfig.json";
    write(root, { [mappingPath]: changedMapping });
    const stale = controlStatus(root);
    expect(stale.verdict).toBe("STALE");
    expect(stale.reasons).toContain("ANALYSIS_INPUT_MISMATCH");
    write(root, { [mappingPath]: mapping });
    expect(controlStatus(root).verdict).toBe("FRESH");
  });
});
