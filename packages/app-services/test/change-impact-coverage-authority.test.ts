import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChangeImpactReportSchema, createDefaultConfig, type ChangeImpactReport } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runChangeImpact } from "../src";
import { __setVerifyControlBarrierForTesting } from "../src/verify";

/**
 * Two properties `impact diff` must make visible on any change: which changed files were actually
 * analysed (a PASS over files no producer read proves nothing), and a literal declared to have a
 * single source that is copied elsewhere (the trust-digest-in-six-files case).
 */

const DIGEST = `sha256:${"6d14a9ee".repeat(8)}`;
const RETIRED = `sha256:${"0ld0ld00".repeat(8)}`;
const NEXT = `sha256:${"9f9f9f9f".repeat(8)}`;
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Semctx Test",
  GIT_AUTHOR_EMAIL: "semctx@example.test",
  GIT_COMMITTER_NAME: "Semctx Test",
  GIT_COMMITTER_EMAIL: "semctx@example.test",
  GIT_AUTHOR_DATE: "2026-10-09T10:00:00Z",
  GIT_COMMITTER_DATE: "2026-10-09T10:00:00Z",
};
const parents: string[] = [];

afterAll(() => {
  __setVerifyControlBarrierForTesting(undefined);
  for (const parent of parents) rmSync(parent, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "core.autocrlf=false", ...args], { cwd: root, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function invariant(meta: string[]): string {
  return [
    "invariant invariant.trust-policy.single-source",
    "  rule: The trust-policy digest has exactly one source.",
    ...meta.map((line) => `  meta: ${line}`),
    "",
  ].join("\n");
}

const AUTHORITY = [`authority.value=${DIGEST}`, "authority.source=src/policy.ts"];

function repository(semantic: string = invariant(AUTHORITY)): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-impact-coverage-"));
  parents.push(root);
  write(root, ".gitignore", ".semctx/\n");
  write(root, "package.json", '{"name":"coverage-fixture","version":"1.0.0","type":"module"}\n');
  write(root, "src/policy.ts", `export const TRUST_POLICY_DIGEST = "${DIGEST}";\n`);
  write(root, "src/consumer.ts", [
    'import { TRUST_POLICY_DIGEST } from "./policy";',
    "",
    `export const pinned = "${DIGEST}";`,
    "export function trusted(digest: string): boolean {",
    "  return digest === TRUST_POLICY_DIGEST;",
    "}",
    "",
  ].join("\n"));
  write(root, "src/unrelated.ts", "export const unrelated = 1;\n");
  write(root, "native/Installer.cs", `class Installer { const string Digest = "${DIGEST}"; }\n`);
  write(root, "native/lib.rs", "pub fn answer() -> u32 { 42 }\n");
  write(root, "deploy.yml", "steps: []\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");
  initWorkspace(root, createDefaultConfig(root));
  write(root, ".semctx/semantic/invariants.sem", semantic);
  indexRepository(root, "2026-10-09T10:00:00.000Z");
  return root;
}

function edit(root: string, path: string, before: string, after: string): void {
  const text = readFileSync(join(root, path), "utf8");
  if (!text.includes(before)) throw new Error(`fixture drifted: ${path}`);
  writeFileSync(join(root, path), text.replace(before, after));
}

function analyse(root: string, source: Parameters<typeof runChangeImpact>[1] = { kind: "working-tree" }): ChangeImpactReport {
  const report = runChangeImpact(root, source);
  ChangeImpactReportSchema.parse(report);
  return report;
}

const coverageByPath = (report: ChangeImpactReport) =>
  Object.fromEntries(report.changes.files.map((file) => [file.path, file.coverage]));

describe("impact diff — per-file coverage", () => {
  it("states for every changed file whether it was analysed, and names unsupported languages", () => {
    const root = repository();
    edit(root, "src/unrelated.ts", "= 1", "= 2");
    edit(root, "native/lib.rs", "42", "43");
    write(root, "deploy.yml", "steps: [build]\n");
    edit(root, "native/Installer.cs", "class Installer", "sealed class Installer");
    const report = analyse(root);

    expect(report.analysis.binding.status).toBe("bound");
    expect(coverageByPath(report)).toEqual({
      "src/unrelated.ts": { status: "analyzed", language: "typescript" },
      "native/lib.rs": { status: "not_analyzed", language: "rust", reason: "LANGUAGE_UNSUPPORTED" },
      "deploy.yml": { status: "not_analyzed", language: "yaml", reason: "LANGUAGE_UNSUPPORTED" },
      "native/Installer.cs": { status: "not_analyzed", language: "csharp", reason: "LANGUAGE_UNSUPPORTED" },
    });
    expect(report.analysis.fileCoverage).toEqual({ files: 4, analyzed: 1, notAnalyzed: 3, reasons: { LANGUAGE_UNSUPPORTED: 3 } });
  });

  it("makes a change that analysed no file detectable", () => {
    const root = repository();
    edit(root, "native/Installer.cs", "class Installer", "sealed class Installer");
    const report = analyse(root);
    expect(report.changes.units).toEqual([]);
    expect(report.analysis.fileCoverage).toMatchObject({ files: 1, analyzed: 0, notAnalyzed: 1 });
  });

  it("never reports a file as analysed through a broken binding", () => {
    const root = repository();
    const base = git(root, "rev-parse", "HEAD");
    edit(root, "src/unrelated.ts", "= 1", "= 2");
    edit(root, "native/lib.rs", "42", "43");
    git(root, "commit", "-qam", "change");
    const report = analyse(root, { kind: "range", base });
    expect(report.analysis.binding.status).toBe("broken");
    expect(coverageByPath(report)).toEqual({
      "src/unrelated.ts": { status: "not_analyzed", language: "typescript", reason: "INDEX_BINDING_BROKEN" },
      "native/lib.rs": { status: "not_analyzed", language: "rust", reason: "LANGUAGE_UNSUPPORTED" },
    });
  });

  it("names the language of the side the analysis read for a rename", () => {
    const root = repository();
    git(root, "mv", "src/unrelated.ts", "src/unrelated.cs");
    const report = analyse(root);
    const renamed = report.changes.files.find((file) => file.path === "src/unrelated.cs");
    expect(renamed).toMatchObject({ oldPath: "src/unrelated.ts", status: "renamed" });
    expect(renamed?.coverage).toEqual({ status: "analyzed", language: "typescript" });
  });

  it("the contract rejects a summary that disagrees with the files", () => {
    const root = repository();
    edit(root, "src/unrelated.ts", "= 1", "= 2");
    const report = analyse(root);
    const forged = { ...report, analysis: { ...report.analysis, fileCoverage: { ...report.analysis.fileCoverage!, analyzed: 0, notAnalyzed: 1 } } };
    expect(ChangeImpactReportSchema.safeParse(forged).success).toBe(false);
  });
});

describe("impact diff — single-authority invariant", () => {
  it("surfaces the invariant when a change touches one of two files carrying the same digest", () => {
    const root = repository();
    edit(root, "src/consumer.ts", "export function trusted", "export function isTrusted");
    const report = analyse(root);
    const authority = report.authorityInvariants?.find((entry) => entry.id === "invariant.trust-policy.single-source");
    expect(authority).toBeDefined();
    expect(authority).toMatchObject({ value: DIGEST, source: "src/policy.ts", status: "duplicated" });
    const current = authority!.occurrences.filter((occurrence) => occurrence.side === "new");
    expect(current.map((occurrence) => [occurrence.file, occurrence.authoritative, occurrence.changed])).toEqual([
      ["native/Installer.cs", false, false],
      ["src/consumer.ts", false, true],
      ["src/policy.ts", true, false],
    ]);
  });

  it("holds through a broken binding: the scan reads Git, not the index", () => {
    const root = repository();
    const base = git(root, "rev-parse", "HEAD");
    edit(root, "native/Installer.cs", "class Installer", "sealed class Installer");
    git(root, "commit", "-qam", "touch a copy");
    const report = analyse(root, { kind: "range", base });
    expect(report.analysis.binding.status).toBe("broken");
    expect(report.authorityInvariants?.map((entry) => [entry.id, entry.status])).toEqual([["invariant.trust-policy.single-source", "duplicated"]]);
  });

  it("stays silent when the change touches no file holding the value", () => {
    const root = repository();
    edit(root, "src/unrelated.ts", "= 1", "= 2");
    expect(analyse(root).authorityInvariants).toEqual([]);
  });

  it("reports a single source once the copies are gone", () => {
    const root = repository();
    edit(root, "src/consumer.ts", `export const pinned = "${DIGEST}";`, "export const pinned = TRUST_POLICY_DIGEST;");
    edit(root, "native/Installer.cs", `"${DIGEST}"`, "Policy.Digest");
    const authority = analyse(root).authorityInvariants?.[0];
    expect(authority?.status).toBe("single_source");
  });

  it("reports a divergence when the source moves on and a copy keeps a retired value", () => {
    const root = repository(invariant([`authority.value=${NEXT}`, "authority.source=src/policy.ts", `authority.retired=${DIGEST},${RETIRED}`]));
    edit(root, "src/policy.ts", DIGEST, NEXT);
    const authority = analyse(root).authorityInvariants?.[0];
    expect(authority?.status).toBe("diverged");
    expect(authority?.occurrences.filter((occurrence) => occurrence.side === "new" && occurrence.kind === "retired").map((occurrence) => occurrence.file))
      .toEqual(["native/Installer.cs", "src/consumer.ts"]);
  });

  it("counts a copy in a file Git treats as binary instead of reporting a single source", () => {
    const root = repository();
    edit(root, "src/consumer.ts", `export const pinned = "${DIGEST}";`, "export const pinned = TRUST_POLICY_DIGEST;");
    edit(root, "native/Installer.cs", `"${DIGEST}"`, "Policy.Digest");
    writeFileSync(join(root, "native/trust.bin"), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(DIGEST, "utf8"), Buffer.from([0])]));
    const authority = analyse(root).authorityInvariants?.[0];
    expect(authority?.status).toBe("duplicated");
    expect(authority?.occurrences.filter((occurrence) => occurrence.side === "new" && !occurrence.authoritative))
      .toEqual([{ file: "native/trust.bin", line: null, side: "new", kind: "authority", authoritative: false, changed: true }]);
  });

  it("voids the scan when the worktree moves while it is searched", () => {
    const root = repository();
    edit(root, "src/consumer.ts", "export function trusted", "export function isTrusted");
    __setVerifyControlBarrierForTesting(() => edit(root, "native/Installer.cs", `"${DIGEST}"`, "Policy.Digest"));
    const report = analyse(root);
    expect(report.analysis.binding.breaks).toContain("WORKING_TREE_CHANGED_DURING_ANALYSIS");
    expect(report.authorityInvariants).toBeNull();
    expect(report.unresolved).toContainEqual(expect.objectContaining({ code: "AUTHORITY_SCAN_UNSTABLE", affects: "claims" }));
  });

  it("reports an unusable declaration instead of scanning for a trivial literal", () => {
    const root = repository(invariant(["authority.value=1", "authority.source=src/policy.ts"]));
    edit(root, "src/policy.ts", DIGEST, NEXT);
    const report = analyse(root);
    expect(report.authorityInvariants).toEqual([]);
    expect(report.unresolved.find((gap) => gap.code === "AUTHORITY_DECLARATION_INVALID")).toMatchObject({
      nodeId: "invariant.trust-policy.single-source",
      affects: "claims",
    });
  });
});
