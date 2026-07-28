import { describe, expect, test } from "bun:test";
import {
  AGENT_WORKFLOW_CONTRACT_V1,
  AgentWorkflowContractV1Schema,
  type AgentWorkflowConditionV1,
  type AgentWorkflowContractV1,
  type AgentWorkflowEffectV1,
  type AgentWorkflowStageIdV1,
  type AgentWorkflowStageV1,
} from "../src/agent-workflow";

type StageRow = readonly [
  AgentWorkflowStageIdV1,
  readonly string[],
  AgentWorkflowEffectV1,
  boolean,
  AgentWorkflowConditionV1,
];

function stageRow(stage: AgentWorkflowStageV1): StageRow {
  return [
    stage.id,
    stage.mcpTools,
    stage.effect,
    stage.requiresUserWriteScope,
    stage.condition,
  ];
}

function parseContract(contract: AgentWorkflowContractV1): AgentWorkflowContractV1 {
  return AgentWorkflowContractV1Schema.parse(contract) as AgentWorkflowContractV1;
}

describe("shared agent workflow contract", () => {
  test("publishes the complete ordered shadow lifecycle without execution authority", () => {
    const contract = parseContract(AGENT_WORKFLOW_CONTRACT_V1);

    expect(contract).toMatchObject({
      schemaVersion: 1,
      kind: "agent_workflow_contract",
      enforcementMode: "shadow",
      blockingEnabled: false,
      nonSemctxRepository: "no_op",
      executionAuthority: "none",
      completion: {
        requiredStageIds: ["reconcile_diff", "verify_change", "change_verify"],
        handoffStageId: "handoff",
      },
    });
    expect(contract.stages.map(stageRow)).toEqual([
      ["inspect_repository", [], "read_only", false, "always"],
      [
        "semantic_check",
        [
          "semctx_semantic_check",
          "semctx_resume",
          "semctx_semantic_inspect",
          "semctx_semantic_slice",
        ],
        "read_only",
        false,
        "semantic_context_present",
      ],
      [
        "status",
        ["semctx_index_health", "semctx_control_status"],
        "read_only",
        false,
        "semantic_context_present",
      ],
      ["frame_task", ["semctx_control_frame_task"], "read_only", false, "write_task"],
      ["bind_scope", ["semctx_control_bind_scope"], "read_only", false, "write_task"],
      ["trace_impact", ["semctx_control_trace"], "read_only", false, "write_task"],
      ["authority", ["semctx_control_authority"], "read_only", false, "write_task"],
      [
        "target_propose",
        ["semctx_control_target_propose"],
        "tracked_create_only",
        true,
        "migration_task",
      ],
      [
        "refine",
        ["semctx_control_plan_change", "semctx_control_plan"],
        "read_only",
        false,
        "write_task",
      ],
      [
        "change_contract",
        ["semctx_change_open", "semctx_change_update"],
        "tracked_create_or_update",
        true,
        "write_task",
      ],
      ["implement", [], "user_authorized_repository_write", true, "write_task"],
      [
        "reconcile_diff",
        ["semctx_control_reconcile_diff"],
        "read_only",
        false,
        "after_edits",
      ],
      ["verify_change", ["semctx_verify_change"], "read_only", false, "after_edits"],
      ["change_verify", ["semctx_change_verify"], "read_only", false, "after_edits"],
      ["handoff", ["semctx_handoff"], "working_state_write", true, "before_handoff"],
    ]);
  });

  test("rejects stage drift, duplicate tool ownership and dishonest write effects", () => {
    expect(AgentWorkflowContractV1Schema.safeParse({
      ...AGENT_WORKFLOW_CONTRACT_V1,
      stages: AGENT_WORKFLOW_CONTRACT_V1.stages.slice(1),
    }).success).toBe(false);
    expect(AgentWorkflowContractV1Schema.safeParse({
      ...AGENT_WORKFLOW_CONTRACT_V1,
      stages: [
        AGENT_WORKFLOW_CONTRACT_V1.stages[1],
        AGENT_WORKFLOW_CONTRACT_V1.stages[0],
        ...AGENT_WORKFLOW_CONTRACT_V1.stages.slice(2),
      ],
    }).success).toBe(false);
    expect(AgentWorkflowContractV1Schema.safeParse({
      ...AGENT_WORKFLOW_CONTRACT_V1,
      stages: AGENT_WORKFLOW_CONTRACT_V1.stages.map((stage) => (
        stage.id === "status"
          ? { ...stage, mcpTools: ["semctx_semantic_check"] }
          : stage
      )),
    }).success).toBe(false);
    expect(AgentWorkflowContractV1Schema.safeParse({
      ...AGENT_WORKFLOW_CONTRACT_V1,
      stages: AGENT_WORKFLOW_CONTRACT_V1.stages.map((stage) => (
        stage.id === "implement"
          ? { ...stage, requiresUserWriteScope: false }
          : stage
      )),
    }).success).toBe(false);
  });
});
