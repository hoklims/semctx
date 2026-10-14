import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { ControlQueryEnvelopeV1Schema, TraversalReportV2Schema, type AgentLifecycleCheckpointRequestV1 } from "@semantic-context/control-model";
import { initSemanticScaffold, newChangeContract, writeChangeFile } from "@semantic-context/semantic-engine";
import { initWorkspace } from "@semantic-context/repository-store";
import {
  controlAgentLifecycleCheckpoint,
  controlStatus,
  indexRepository,
  queryControlDeletionAuthorization,
  queryControlGraph,
} from "@semantic-context/app-services";
import { controlAuthorizeDeletionTool, controlGraphTool, controlPlanTool, controlStatusTool, controlTraceTool } from "../src/control-tools";
import { createSemctxServer } from "../src/server";

let root: string;
const CHANGE = "change.control-plane-mcp";
const BLOCKED_CHANGE = "change.control-plane-mcp-open-unknown";

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function snapshot(dir: string): string {
  const records: Array<{ path: string; bytes: string }> = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) records.push({ path: relative(dir, full).replace(/\\/g, "/"), bytes: readFileSync(full).toString("base64") });
    }
  };
  visit(dir);
  return JSON.stringify(records);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-control-mcp-"));
  cpSync(SAMPLE_REPO, root, { recursive: true, filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
  git(root, "init");
  initWorkspace(root);
  initSemanticScaffold(root);
  writeChangeFile(root, newChangeContract({
    id: CHANGE,
    statement: "expose Plane C MCP tools",
    lifecycle: "active",
    provenance: "author",
  }));
  writeChangeFile(root, newChangeContract({
    id: BLOCKED_CHANGE,
    statement: "MCP migration with unresolved runtime dependency",
    lifecycle: "active",
    provenance: "author",
    openUnknowns: ["unknown.runtime-consumer"],
  }));
  writeFileSync(join(root, ".semctx/semantic/trace.sem"),
    "goal goal.trace\n  statement: Synthetic mapped trace goal.\n  status: declared\n  provenance: author\n  appliesAtLevel: 2\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-m", "fixture");
  indexRepository(root, "2026-07-19T00:00:00.000Z");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("Plane C MCP handlers", () => {
  it("reports the explicit freshness verdict without mutating the repository", () => {
    const before = snapshot(root);
    expect(controlStatusTool(root)).toMatchObject({
      kind: "control_freshness_status",
      basis: "control_index_snapshot_v1",
      verdict: "FRESH",
      canRunHighRiskControl: true,
      reasons: [],
    });
    expect(snapshot(root)).toBe(before);
  });

  it("returns BLOCKED without a target and READY with an explicit target", () => {
    const blocked = controlPlanTool(root, { changeId: CHANGE });
    expect(blocked.plan.status).toBe("BLOCKED");
    expect(blocked.plan.blockedReason).toBe("target_architecture_missing");
    expect(blocked.freshnessSeal?.sealHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const current = blocked.plan.current;
    const ready = controlPlanTool(root, {
      changeId: CHANGE,
      target: { ...current, id: "target:mcp", capturedAt: "2026-07-19T01:00:00.000Z" },
    });
    expect(ready.plan.status).toBe("READY");
    expect(ready.plan.steps.map((step) => step.kind)).toContain("deletion_check");
  });

  it("returns the exact shared graph and authorization envelopes", () => {
    expect(controlGraphTool(root)).toEqual(queryControlGraph(root));
    const query = {
      subject: "change.demo",
      planningCommit: "git:not-current",
      evaluatedAt: "2026-07-23T12:00:00.000Z",
      attestationRequests: [],
    };
    expect(controlAuthorizeDeletionTool(root, query)).toEqual(queryControlDeletionAuthorization(root, query));
    expect(controlAuthorizeDeletionTool(root, query)).toMatchObject({
      terminalStatus: "refused",
      reasonCodes: ["PLANNING_COMMIT_MISMATCH"],
      payload: null,
    });
  });

  it("traces without mutating the repository", () => {
    const sourceId = controlGraphTool(root).payload?.nodes.find((node) => !node.id.startsWith("sha256:"))?.id;
    if (sourceId === undefined) throw new Error("expected at least one architecture element");
    const before = snapshot(root);
    const report = controlTraceTool(root, { sourceId: sourceId as `repo:${string}` | `semantic:${string}`, direction: "lift", maxDepth: 4, maxResults: 10 });
    expect(report.schemaVersion).toBe(2);
    expect(report.sourceId).toBe(sourceId);
    expect(report.freshnessSeal?.sealHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(snapshot(root)).toBe(before);
  });

  it.each(["lift", "lower"] as const)("keeps fresh trace and traversal facts equal through MCP in %s direction", async (direction) => {
    await withMcpClient(root, async (client) => {
      const input = { repositoryRoot: root, sourceId: "semantic:goal.trace", targetLevel: 2, direction, maxDepth: 3, maxResults: 5 };
      const trace = await client.callTool({ name: "semctx_control_trace", arguments: input });
      const traversal = await client.callTool({ name: "semctx_control_traversal", arguments: input });
      expect(trace.isError).not.toBe(true);
      expect(traversal.isError).not.toBe(true);
      const { freshnessSeal, ...facts } = TraversalReportV2Schema.parse(trace.structuredContent);
      const envelope = ControlQueryEnvelopeV1Schema.parse(traversal.structuredContent);
      expect(facts.terminalStatus).toBe("success");
      expect(facts.visitedCoordinateIds).toEqual(["semantic:goal.trace"]);
      expect(envelope.kind).toBe("traversal");
      expect(envelope.freshness).toMatchObject({ verdict: "FRESH", seal: freshnessSeal });
      expect(envelope.payload).toEqual(facts);
    });
  });

  it("projects Plane B unknowns into a fail-closed plan", () => {
    const current = controlPlanTool(root, { changeId: CHANGE }).plan.current;
    const report = controlPlanTool(root, {
      changeId: BLOCKED_CHANGE,
      target: { ...current, id: "target:mcp-blocked", capturedAt: "2026-07-19T01:00:00.000Z" },
    });

    expect(report.plan.status).toBe("BLOCKED");
    expect(report.plan.blockedReason).toBe("open_unknowns");
    expect(report.plan.blockedDetails[0]?.subjectIds).toEqual(["unknown.runtime-consumer"]);
  });
});

describe("MCP preflight on an unprojectable semantic model", () => {
  let drifted: string;

  beforeAll(() => {
    drifted = mkdtempSync(join(tmpdir(), "semctx-control-mcp-drift-"));
    cpSync(SAMPLE_REPO, drifted, { recursive: true, filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
    git(drifted, "init");
    initWorkspace(drifted);
    initSemanticScaffold(drifted);
    git(drifted, "add", ".");
    git(drifted, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-m", "fixture");
    indexRepository(drifted, "2026-07-25T00:00:00.000Z");
  });

  afterAll(() => rmSync(drifted, { recursive: true, force: true }));

  it("returns the same bounded verdict as the CLI instead of raising a config error", () => {
    expect(controlStatusTool(drifted).canRunHighRiskControl).toBe(true);

    // Authored lifecycle drifts after the seal was captured: two non-terminal contracts, no pointer.
    writeChangeFile(drifted, newChangeContract({ id: "change.drift.a", statement: "A", lifecycle: "active", provenance: "author" }));
    writeChangeFile(drifted, newChangeContract({ id: "change.drift.b", statement: "B", lifecycle: "active", provenance: "author" }));
    writeFileSync(join(drifted, ".semctx", "working", "active-change.sem"), "not a semantic block\n", "utf8");

    const report = controlStatusTool(drifted);

    expect(report).toMatchObject({
      kind: "control_freshness_status",
      verdict: "UNSEALED",
      canRunHighRiskControl: false,
      reasons: ["SEMANTIC_LIFECYCLE_INVALID"],
      freshnessSeal: null,
    });
    expect(controlStatus(drifted)).toEqual(report);
  });
});

const LIFECYCLE_TOOL = "semctx_control_agent_lifecycle";
const lifecycleRequest: AgentLifecycleCheckpointRequestV1 = {
  schemaVersion: 1,
  checkpoint: "after_repository_edits",
  profile: "implementation",
  requiredAltitude: 2,
  recordedStageIds: ["inspect_repository", "status"],
  priorTouchedCoordinateIds: ["repo:zeta", "repo:alpha"],
  newlyObservedTouchedCoordinateIds: ["semantic:beta", "repo:alpha"],
};

async function withMcpClient<T>(
  boundRoot: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createSemctxServer(boundRoot);
  const client = new Client({ name: "semctx-lifecycle-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function expectLifecycleInvalidBeforeEvaluation(
  client: Client,
  request: unknown,
): Promise<void> {
  const result = await client.callTool({
    name: LIFECYCLE_TOOL,
    arguments: {
      repositoryRoot: join(root, "missing"),
      request,
    },
  });
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{
    type: "text",
    text: JSON.stringify({
      code: "INVALID_ARGUMENTS",
      error: "Tool arguments are invalid",
    }),
  }]);
  expect(JSON.stringify(result)).not.toContain("agent_lifecycle_report");
  expect(JSON.stringify(result)).not.toContain("reportHash");
}

describe("agent lifecycle MCP transport", () => {
  it("advertises one strict top-level request with a strict shared nested schema", async () => {
    await withMcpClient(root, async (client) => {
      const tool = (await client.listTools()).tools.find(({ name }) => name === LIFECYCLE_TOOL);
      expect(tool).toBeDefined();
      expect(tool?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["repositoryRoot", "request"],
        properties: {
          repositoryRoot: { type: "string" },
          request: {
            type: "object",
            additionalProperties: false,
            required: [
              "schemaVersion",
              "checkpoint",
              "profile",
              "requiredAltitude",
              "recordedStageIds",
              "priorTouchedCoordinateIds",
              "newlyObservedTouchedCoordinateIds",
            ],
          },
        },
      });
    });
  });

  it("rejects unknown top-level and nested authority/source/applicability fields before evaluation", async () => {
    await withMcpClient(root, async (client) => {
      const invalidCalls = [
        {
          repositoryRoot: join(root, "missing"),
          request: lifecycleRequest,
          unknownTopLevel: true,
        },
        {
          repositoryRoot: join(root, "missing"),
          request: { ...lifecycleRequest, executionAuthority: "none" },
        },
        {
          repositoryRoot: join(root, "missing"),
          request: { ...lifecycleRequest, sourceContentCollected: false },
        },
        {
          repositoryRoot: join(root, "missing"),
          request: { ...lifecycleRequest, applicability: "eligible" },
        },
      ];

      for (const arguments_ of invalidCalls) {
        const result = await client.callTool({
          name: LIFECYCLE_TOOL,
          arguments: arguments_,
        });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{
          type: "text",
          text: JSON.stringify({
            code: "INVALID_ARGUMENTS",
            error: "Tool arguments are invalid",
          }),
        }]);
        expect(JSON.stringify(result)).not.toContain("reportHash");
      }
    });
  });

  it("requires an absolute repository root", async () => {
    await withMcpClient(root, async (client) => {
      const result = await client.callTool({
        name: LIFECYCLE_TOOL,
        arguments: { repositoryRoot: ".", request: lifecycleRequest },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("INVALID_ARGUMENTS");
      expect(JSON.stringify(result)).not.toContain("reportHash");
    });
  });

  it("rejects invalid coordinate namespaces before lifecycle evaluation", async () => {
    await withMcpClient(root, async (client) => {
      await expectLifecycleInvalidBeforeEvaluation(client, {
        ...lifecycleRequest,
        newlyObservedTouchedCoordinateIds: ["file:not-a-lifecycle-coordinate"],
      });
    });
  });

  it("rejects whitespace and control characters in coordinate ids before lifecycle evaluation", async () => {
    await withMcpClient(root, async (client) => {
      for (const coordinateId of [" repo:leading-space", "repo:line\nbreak"]) {
        await expectLifecycleInvalidBeforeEvaluation(client, {
          ...lifecycleRequest,
          newlyObservedTouchedCoordinateIds: [coordinateId],
        });
      }
    });
  });

  it("rejects a 513-id accumulated union before lifecycle evaluation", async () => {
    await withMcpClient(root, async (client) => {
      await expectLifecycleInvalidBeforeEvaluation(client, {
        ...lifecycleRequest,
        priorTouchedCoordinateIds: Array.from(
          { length: 512 },
          (_, index) => `repo:prior-${index}`,
        ),
        newlyObservedTouchedCoordinateIds: ["semantic:new"],
      });
    });
  });

  it("returns the exact shared non-Semctx NO_OP report", async () => {
    const nonSemctxRoot = mkdtempSync(join(tmpdir(), "semctx-lifecycle-no-op-"));
    try {
      await withMcpClient(nonSemctxRoot, async (client) => {
        const result = await client.callTool({
          name: LIFECYCLE_TOOL,
          arguments: { repositoryRoot: nonSemctxRoot, request: lifecycleRequest },
        });
        const expected = controlAgentLifecycleCheckpoint(nonSemctxRoot, lifecycleRequest);
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual(expected);
        expect(result.content).toEqual([{
          type: "text",
          text: JSON.stringify(expected, null, 2),
        }]);
        expect(expected).toMatchObject({
          applicability: "not_applicable",
          repositoryState: "non_semctx",
          stagePresenceVerdict: "NO_OP",
          reasonCodes: ["NON_SEMCTX_REPOSITORY"],
          requiredStageIds: [],
          recordedStageIds: [],
          missingStageIds: [],
          accumulatedTouchedCoordinateIds: [],
          enforcementMode: "shadow",
          blockingEnabled: false,
          executionAuthority: "none",
          sourceContentCollected: false,
        });
      });
    } finally {
      rmSync(nonSemctxRoot, { recursive: true, force: true });
    }
  });

  it("returns canonical identical content for permutation-equivalent calls", async () => {
    await withMcpClient(root, async (client) => {
      const first = await client.callTool({
        name: LIFECYCLE_TOOL,
        arguments: { repositoryRoot: root, request: lifecycleRequest },
      });
      const second = await client.callTool({
        name: LIFECYCLE_TOOL,
        arguments: {
          repositoryRoot: root,
          request: {
            ...lifecycleRequest,
            recordedStageIds: ["status", "inspect_repository"],
            priorTouchedCoordinateIds: ["repo:alpha", "repo:zeta"],
            newlyObservedTouchedCoordinateIds: ["repo:alpha", "semantic:beta"],
          },
        },
      });
      expect(first.isError).not.toBe(true);
      expect(second.isError).not.toBe(true);
      expect(second.content).toEqual(first.content);
      expect(second.structuredContent).toEqual(first.structuredContent);
    });
  });
});
