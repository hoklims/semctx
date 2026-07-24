import { afterEach, describe, expect, it } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  join,
  resolve,
} from "node:path";
import type { TaskFrame } from "@semantic-context/core";
import { indexRepository } from "@semantic-context/app-services";
import {
  buildPlanningBundle,
  reconcileWorkingTree,
} from "@semantic-context/app-services/reconciliation";
import {
  serializeControlReport,
  type ReconcileWorkingTreeInputV1,
} from "@semantic-context/control-model/reconciliation";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import {
  initSemanticScaffold,
  newChangeContract,
  writeChangeFile,
} from "@semantic-context/semantic-engine";
import {
  inspectReconciliationAuthorityClosure,
  SAMPLE_REPO,
  must,
} from "@semantic-context/test-fixtures";
import { CONTROL_RECONCILIATION_HELP } from "../src/commands/control-reconciliation";

const roots: string[] = [];
const CLI = join(import.meta.dir, "..", "src", "index.ts");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "semctx-test",
  GIT_AUTHOR_EMAIL: "semctx-test@example.com",
  GIT_COMMITTER_NAME: "semctx-test",
  GIT_COMMITTER_EMAIL: "semctx-test@example.com",
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("control reconciliation CLI transport", () => {
  it("documents only bounded pre-edit planning and read-only reconciliation", () => {
    expect(CONTROL_RECONCILIATION_HELP).toContain("plan-change <change-id>");
    expect(CONTROL_RECONCILIATION_HELP).toContain("executionAuthority \"none\"");
    expect(CONTROL_RECONCILIATION_HELP).toContain("reconcile-diff <input.json>");
    expect(CONTROL_RECONCILIATION_HELP).toContain("no caller-selected Git refs");
    expect(CONTROL_RECONCILIATION_HELP).not.toContain("--base");
    expect(CONTROL_RECONCILIATION_HELP).not.toContain("--head");
  });

  it("emits the exact canonical PlanningBundle returned by app-services", () => {
    const fixture = preparedRepository();
    const inputFile = temporaryJson("planner.json", fixture.plannerInputs);
    const expected = buildPlanningBundle(fixture.root, fixture.command);

    const result = runCli(fixture.root, [
      "control",
      "plan-change",
      fixture.changeId,
      "--task-id",
      fixture.taskFrameId,
      "--input",
      inputFile,
      "--json",
    ]);

    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe(`${serializeControlReport(expected)}\n`);
    expect(JSON.parse(result.out)).toEqual(expected);
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: 1,
      kind: "planning_bundle",
      executionAuthority: "none",
    });
  });

  it("returns REALIZED with canonical app-service bytes for the actual worktree diff", () => {
    const fixture = preparedRepository();
    const bundle = buildPlanningBundle(fixture.root, fixture.command);
    const source = join(fixture.root, fixture.path);
    writeFileSync(source, `${readFileSync(source, "utf8")}\n// candidate\n`, "utf8");
    const input: ReconcileWorkingTreeInputV1 = {
      schemaVersion: 1,
      planningBundle: bundle,
    };
    const inputFile = temporaryJson("reconciliation.json", input);
    const expected = reconcileWorkingTree(fixture.root, input);

    const result = runCli(fixture.root, [
      "control",
      "reconcile-diff",
      inputFile,
      "--json",
    ]);

    expect(expected.terminalStatus, serializeControlReport(expected)).toBe("REALIZED");
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe(`${serializeControlReport(expected)}\n`);
    expect(JSON.parse(result.out)).toEqual(expected);
  });

  it("rejects Git reference flags and extra fields in the shared input", () => {
    const fixture = preparedRepository();
    const bundle = buildPlanningBundle(fixture.root, fixture.command);
    const inputFile = temporaryJson("reconciliation-extra-ref.json", {
      schemaVersion: 1,
      planningBundle: bundle,
      baseRef: "HEAD~1",
    });

    const callerRef = runCli(fixture.root, [
      "control",
      "reconcile-diff",
      inputFile,
      "--base",
      "HEAD~1",
    ]);
    expect(callerRef.code).not.toBe(0);
    expect(callerRef.err).toContain("does not accept caller-selected Git refs");

    const extraInput = runCli(fixture.root, [
      "control",
      "reconcile-diff",
      inputFile,
    ]);
    expect(extraInput.code).not.toBe(0);
    expect(extraInput.err).toContain("Unrecognized key");
  });

  it("rejects planner files that attempt to redefine CLI-bound identities", () => {
    const fixture = preparedRepository();
    const inputFile = temporaryJson("planner-reserved.json", {
      ...fixture.plannerInputs,
      changeId: "change.caller-override",
    });

    const result = runCli(fixture.root, [
      "control",
      "plan-change",
      fixture.changeId,
      "--task-id",
      fixture.taskFrameId,
      "--input",
      inputFile,
    ]);

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("must not redefine CLI-bound fields");
  });

  it("has no recursive runtime path to authorization, writers, or execution", () => {
    const repositoryRoot = resolve(import.meta.dir, "..", "..", "..");
    const entry = resolve(
      repositoryRoot,
      "apps",
      "cli",
      "src",
      "commands",
      "control-reconciliation.ts",
    );
    const closure = inspectReconciliationAuthorityClosure(repositoryRoot, entry);
    expect(closure.violations).toEqual([]);

    const source = readFileSync(entry, "utf8");
    expect(source).toContain("@semantic-context/app-services/reconciliation");
    expect(source).toContain("@semantic-context/control-model/reconciliation");
    expect(source).not.toContain('from "@semantic-context/app-services"');
    expect(source).not.toContain('from "@semantic-context/control-model"');
  });

});

function preparedRepository() {
  const root = mkdtempSync(join(tmpdir(), "semctx-cli-reconciliation-"));
  roots.push(root);
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (source) => !source.includes(".semctx") && !source.includes("node_modules"),
  });
  git(root, "init", "-q");
  initWorkspace(root);
  initSemanticScaffold(root);
  const path = "src/local-patch.ts";
  writeFileSync(
    join(root, path),
    "export function localPatchValue(): number {\n  return 1;\n}\n",
    "utf8",
  );
  const change = newChangeContract({
    id: "change.cli-task-envelope",
    statement: "Adjust capacity behavior.",
    lifecycle: "draft",
  });
  writeChangeFile(root, change);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  indexRepository(root, "2026-07-23T18:00:00.000Z");

  const frame: TaskFrame = {
    id: "task.cli-issue-27",
    rawTask: "Adjust capacity behavior.",
    mode: "bugfix",
    capabilities: ["capacity"],
    observedBehavior: [],
    expectedBehavior: [],
    boundedContexts: [],
    hardInvariants: [],
    softConstraints: [],
    acceptanceEvidence: [],
    nonGoals: [],
    riskSurfaces: [],
    hypotheses: [],
    createdAt: "2026-07-23T17:00:00.000Z",
  };
  const store = openStore(root);
  const nodes = store.loadGraph().nodes.filter((candidate) =>
    candidate.filePath?.replaceAll("\\", "/") === path
  );
  must(nodes[0]);
  store.saveTaskFrame(frame);
  store.close();

  const coordinateIds = nodes.map((node) => `repo:${node.id}` as const).sort();
  const plannerInputs = {
    explicitDiscoveries: coordinateIds.map((coordinateId) => ({
      coordinateId,
      repositoryPath: path,
      evidenceId: `discovery:cli-test:${coordinateId}`,
      evidenceProvenance: "test" as const,
      scope: { kind: "file" as const, path },
    })),
    rollbackDescription: "Restore the committed implementation.",
    repositoryEditExpectations: [{
      schemaVersion: 1 as const,
      editId: "edit.capacity",
      kind: "modify" as const,
      required: true,
      path,
      coordinateIds,
      expectedLiftedExpectationIds: [],
      acceptanceEvidenceIds: [],
    }],
    testReferences: ["test/capacity.test.ts"],
  };
  const command = {
    schemaVersion: 1 as const,
    taskFrameId: frame.id,
    changeId: change.id,
    ...plannerInputs,
  };
  return {
    root,
    path,
    taskFrameId: frame.id,
    changeId: change.id,
    plannerInputs,
    command,
  };
}

function temporaryJson(name: string, value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "semctx-cli-reconciliation-input-"));
  roots.push(directory);
  const file = join(directory, name);
  writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

function git(root: string, ...args: string[]): string {
  const process = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (process.exitCode !== 0) throw new Error(new TextDecoder().decode(process.stderr));
  return new TextDecoder().decode(process.stdout).trim();
}

function runCli(
  root: string,
  argv: readonly string[],
): { code: number; out: string; err: string } {
  const process = Bun.spawnSync(
    ["bun", "run", CLI, ...argv, "--root", root],
    { stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: process.exitCode ?? 1,
    out: new TextDecoder().decode(process.stdout),
    err: new TextDecoder().decode(process.stderr),
  };
}
