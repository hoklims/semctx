import { afterEach, describe, expect, it } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { TaskFrame } from "@semantic-context/core";
import {
  buildPlanningBundle,
  prepareTaskEnvelope,
  reconcileWorkingTree,
} from "@semantic-context/app-services/reconciliation";
import { indexRepository } from "@semantic-context/app-services";
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
import {
  serializeControlReport,
} from "@semantic-context/control-model/reconciliation";
import {
  controlPlanChangeTool,
  controlReconcileDiffTool,
} from "@semantic-context/mcp-server/reconciliation";
import { createSemctxServer } from "../src/server";

const roots: string[] = [];
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

describe("task reconciliation MCP adapters", () => {
  it("returns the exact shared planning bundle without execution authority", () => {
    const fixture = preparedRepository();
    const command = {
      ...fixture.command,
      rollbackDescription: "Restore the committed implementation.",
      repositoryEditExpectations: [fixture.edit],
      testReferences: ["test/capacity.test.ts"],
    };

    const actual = controlPlanChangeTool(fixture.root, command);
    expect(actual).toEqual(buildPlanningBundle(fixture.root, command));
    expect(actual.executionAuthority).toBe("none");
    expect(actual.taskEnvelope.executionAuthority).toBe("none");
    expect(actual.semanticChangeSet.executionAuthority).toBe("none");
  });

  it("returns REALIZED with the exact canonical app-service report bytes", () => {
    const fixture = preparedRepository();
    const bundle = controlPlanChangeTool(fixture.root, {
      ...fixture.command,
      rollbackDescription: "Restore the committed implementation.",
      repositoryEditExpectations: [fixture.edit],
    });
    const source = join(fixture.root, fixture.path);
    writeFileSync(source, `${readFileSync(source, "utf8")}\n// candidate\n`, "utf8");
    const input = { schemaVersion: 1 as const, planningBundle: bundle };
    const expected = reconcileWorkingTree(fixture.root, input);
    const actual = controlReconcileDiffTool(fixture.root, input);

    expect(expected.terminalStatus, serializeControlReport(expected)).toBe("REALIZED");
    expect(actual).toEqual(expected);
    expect(serializeControlReport(actual)).toBe(serializeControlReport(expected));
  });

  it("rejects caller-selected refs at the shared strict boundary", () => {
    const fixture = preparedRepository();
    const planningBundle = controlPlanChangeTool(fixture.root, {
      ...fixture.command,
      rollbackDescription: "Restore the committed implementation.",
      repositoryEditExpectations: [fixture.edit],
    });

    expect(() => controlReconcileDiffTool(fixture.root, {
      schemaVersion: 1,
      planningBundle,
      base: "HEAD~1",
    } as never)).toThrow();
  });

  it("serializes actual MCP planning and reconciliation as canonical shared bytes", async () => {
    const fixture = preparedRepository();
    const command = {
      ...fixture.command,
      rollbackDescription: "Restore the committed implementation.",
      repositoryEditExpectations: [fixture.edit],
    };
    const planningBundle = controlPlanChangeTool(fixture.root, command);
    const server = createSemctxServer(fixture.root);
    const client = new Client({ name: "semctx-reconciliation-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const planResult = await client.callTool({
        name: "semctx_control_plan_change",
        arguments: {
          repositoryRoot: fixture.root,
          command,
        },
      });
      expect(planResult.isError, JSON.stringify(planResult)).not.toBe(true);
      expect(textContent(planResult)).toBe(serializeControlReport(planningBundle));

      const source = join(fixture.root, fixture.path);
      writeFileSync(source, `${readFileSync(source, "utf8")}\n// candidate\n`, "utf8");
      const input = { schemaVersion: 1 as const, planningBundle };
      const expected = controlReconcileDiffTool(fixture.root, input);
      expect(expected.terminalStatus, serializeControlReport(expected)).toBe("REALIZED");
      const result = await client.callTool({
        name: "semctx_control_reconcile_diff",
        arguments: {
          repositoryRoot: fixture.root,
          input,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(textContent(result)).toBe(serializeControlReport(expected));

      const invalidReconciliation = await client.callTool({
        name: "semctx_control_reconcile_diff",
        arguments: {
          repositoryRoot: fixture.root,
          input: {
            ...input,
            head: "HEAD",
          },
        },
      });
      expect(invalidReconciliation.isError).toBe(true);
      expect(textContent(invalidReconciliation)).toContain("Input validation error");
      expect(textContent(invalidReconciliation)).toContain("\"head\"");

      const invalidPlan = await client.callTool({
        name: "semctx_control_plan_change",
        arguments: {
          repositoryRoot: fixture.root,
          command: {
            ...command,
            base: "HEAD~1",
          },
        },
      });
      expect(invalidPlan.isError).toBe(true);
      expect(textContent(invalidPlan)).toContain("Input validation error");
      expect(textContent(invalidPlan)).toContain("\"base\"");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps the actual MCP reconciliation export outside authority and writer modules", () => {
    const root = resolve(import.meta.dir, "..", "..", "..");
    const entry = resolve(root, "packages", "mcp-server", "src", "reconciliation-tools.ts");
    const closure = inspectReconciliationAuthorityClosure(root, entry);
    expect(closure.violations).toEqual([]);

    const entrySource = readFileSync(entry, "utf8");
    expect(entrySource).toContain("@semantic-context/app-services/reconciliation");
    expect(entrySource).toContain("@semantic-context/control-model/reconciliation");
    expect(entrySource).not.toContain('from "@semantic-context/app-services"');
    expect(entrySource).not.toContain('from "@semantic-context/control-model"');
  });
});

function textContent(result: unknown): string {
  const content = (result as {
    content: Array<{ type: string; text?: string }>;
  }).content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("expected MCP text result");
  }
  return content.text;
}

function preparedRepository() {
  const root = mkdtempSync(join(tmpdir(), "semctx-reconciliation-mcp-"));
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
    id: "change.task-envelope-mcp",
    statement: "Adjust capacity behavior through MCP.",
    lifecycle: "draft",
  });
  writeChangeFile(root, change);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  indexRepository(root, "2026-07-23T18:00:00.000Z");

  const frame: TaskFrame = {
    id: "task.issue-27-mcp",
    rawTask: "Adjust capacity behavior through MCP.",
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
  const command = {
    schemaVersion: 1 as const,
    taskFrameId: frame.id,
    changeId: change.id,
    explicitDiscoveries: coordinateIds.map((coordinateId) => ({
      coordinateId,
      repositoryPath: path,
      evidenceId: `discovery:mcp-test:${coordinateId}`,
      evidenceProvenance: "test" as const,
      scope: { kind: "file" as const, path },
    })),
  };
  const envelope = prepareTaskEnvelope(root, command).envelope;
  expect(envelope.resolvedBindings).toHaveLength(coordinateIds.length);
  const edit = {
    schemaVersion: 1 as const,
    editId: "edit.capacity",
    kind: "modify" as const,
    required: true,
    path,
    coordinateIds,
    expectedLiftedExpectationIds: [],
    acceptanceEvidenceIds: [],
  };
  return { root, path, command, edit };
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
