/**
 * Canonical agent workflow policy shared by Codex and Claude Code.
 *
 * This contract is advisory shadow governance. It describes the ordered Semctx
 * lifecycle and its write effects, but never grants execution authority.
 */

import { z } from "zod";

export const AGENT_WORKFLOW_STAGE_ORDER = [
  "inspect_repository",
  "semantic_check",
  "status",
  "frame_task",
  "bind_scope",
  "trace_impact",
  "authority",
  "target_propose",
  "refine",
  "change_contract",
  "implement",
  "reconcile_diff",
  "verify_change",
  "change_verify",
  "handoff",
] as const;

export type AgentWorkflowStageIdV1 = (typeof AGENT_WORKFLOW_STAGE_ORDER)[number];

export const AGENT_WORKFLOW_EFFECT_ORDER = [
  "read_only",
  "tracked_create_only",
  "tracked_create_or_update",
  "user_authorized_repository_write",
  "working_state_write",
] as const;

export type AgentWorkflowEffectV1 = (typeof AGENT_WORKFLOW_EFFECT_ORDER)[number];

export const AGENT_WORKFLOW_CONDITION_ORDER = [
  "always",
  "semantic_context_present",
  "write_task",
  "migration_task",
  "after_edits",
  "before_handoff",
] as const;

export type AgentWorkflowConditionV1 = (typeof AGENT_WORKFLOW_CONDITION_ORDER)[number];

export interface AgentWorkflowStageV1 {
  readonly id: AgentWorkflowStageIdV1;
  readonly mcpTools: readonly string[];
  readonly effect: AgentWorkflowEffectV1;
  readonly requiresUserWriteScope: boolean;
  readonly condition: AgentWorkflowConditionV1;
  readonly instruction: string;
}

export interface AgentWorkflowContractV1 {
  readonly schemaVersion: 1;
  readonly kind: "agent_workflow_contract";
  readonly enforcementMode: "shadow";
  readonly blockingEnabled: false;
  readonly nonSemctxRepository: "no_op";
  readonly executionAuthority: "none";
  readonly stages: readonly AgentWorkflowStageV1[];
  readonly completion: {
    readonly requiredStageIds: readonly [
      "reconcile_diff",
      "verify_change",
      "change_verify",
    ];
    readonly handoffStageId: "handoff";
  };
}

const AgentWorkflowStageIdV1Schema = z.enum(AGENT_WORKFLOW_STAGE_ORDER);
const AgentWorkflowEffectV1Schema = z.enum(AGENT_WORKFLOW_EFFECT_ORDER);
const AgentWorkflowConditionV1Schema = z.enum(AGENT_WORKFLOW_CONDITION_ORDER);

const AgentWorkflowStageV1Schema = z.object({
  id: AgentWorkflowStageIdV1Schema,
  mcpTools: z.array(z.string().regex(/^semctx_[a-z0-9_]+$/)),
  effect: AgentWorkflowEffectV1Schema,
  requiresUserWriteScope: z.boolean(),
  condition: AgentWorkflowConditionV1Schema,
  instruction: z.string().trim().min(1),
}).strict();

export const AgentWorkflowContractV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("agent_workflow_contract"),
  enforcementMode: z.literal("shadow"),
  blockingEnabled: z.literal(false),
  nonSemctxRepository: z.literal("no_op"),
  executionAuthority: z.literal("none"),
  stages: z.array(AgentWorkflowStageV1Schema),
  completion: z.object({
    requiredStageIds: z.tuple([
      z.literal("reconcile_diff"),
      z.literal("verify_change"),
      z.literal("change_verify"),
    ]),
    handoffStageId: z.literal("handoff"),
  }).strict(),
}).strict().superRefine((value, context) => {
  const ids = value.stages.map((stage) => stage.id);
  if (
    ids.length !== AGENT_WORKFLOW_STAGE_ORDER.length
    || ids.some((id, index) => id !== AGENT_WORKFLOW_STAGE_ORDER[index])
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stages"],
      message: "workflow stages must match the canonical order exactly",
    });
  }

  const tools = value.stages.flatMap((stage) => stage.mcpTools);
  if (new Set(tools).size !== tools.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stages"],
      message: "workflow MCP tools must be unique",
    });
  }

  for (const [index, stage] of value.stages.entries()) {
    const writes = stage.effect !== "read_only";
    if (stage.requiresUserWriteScope !== writes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages", index, "requiresUserWriteScope"],
        message: "every write effect requires user write scope and read-only stages do not",
      });
    }
    const hostLocal = stage.id === "inspect_repository" || stage.id === "implement";
    if (hostLocal !== (stage.mcpTools.length === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages", index, "mcpTools"],
        message: "only host-local repository inspection and implementation omit MCP tools",
      });
    }
  }
});

export const AGENT_WORKFLOW_CONTRACT_V1 = AgentWorkflowContractV1Schema.parse({
  schemaVersion: 1,
  kind: "agent_workflow_contract",
  enforcementMode: "shadow",
  blockingEnabled: false,
  nonSemctxRepository: "no_op",
  executionAuthority: "none",
  stages: [
    {
      id: "inspect_repository",
      mcpTools: [],
      effect: "read_only",
      requiresUserWriteScope: false,
      condition: "always",
      instruction:
        "Establish the repository state with normal code search and Git inspection. Do not use Semctx as a substitute for reading the code.",
    },
    {
      id: "semantic_check",
      mcpTools: [
        "semctx_semantic_check",
        "semctx_resume",
        "semctx_semantic_inspect",
        "semctx_semantic_slice",
      ],
      effect: "read_only",
      requiresUserWriteScope: false,
      condition: "semantic_context_present",
      instruction:
        "Check the semantic model and preserve its canonical reason codes. Rehydrate existing intent with semctx_resume, semctx_semantic_inspect or semctx_semantic_slice when an identity exists; absent context stays unknown.",
    },
    {
      id: "status",
      mcpTools: ["semctx_index_health", "semctx_control_status"],
      effect: "read_only",
      requiresUserWriteScope: false,
      condition: "semantic_context_present",
      instruction:
        "Run index health and the control preflight before governed work. Keep coverage separate from freshness, continue only for FRESH or DIRTY_KNOWN, preserve every incomplete-coverage, STALE or UNSEALED reason verbatim, and record seals and bindings as attestations rather than authority.",
    },
    {
      id: "frame_task",
      mcpTools: ["semctx_control_frame_task"],
      effect: "read_only",
      requiresUserWriteScope: false,
      condition: "write_task",
      instruction:
        "Frame the task without promoting task prose, candidates or hypotheses into normative repository scope.",
    },
    {
      id: "bind_scope",
      mcpTools: ["semctx_control_bind_scope"],
      effect: "read_only",
      requiresUserWriteScope: false,
      condition: "write_task",
      instruction:
        "Bind only explicit repository files or coordinates. Keep unresolved or advisory candidates outside the declared reconciliation scope.",
    },
    {
      id: "trace_impact",
      mcpTools: ["semctx_control_trace"],
      effect: "read_only",
      requiresUserWriteScope: false,
      condition: "write_task",
      instruction:
        "Trace bounded L0-L6 impact and label observed, authored, inferred and ambiguous statements honestly.",
    },
    {
      id: "authority",
      mcpTools: ["semctx_control_authority"],
      effect: "read_only",
      requiresUserWriteScope: false,
      condition: "write_task",
      instruction:
        "Evaluate the required altitude and its accumulating obligations. The report describes required authority and never grants execution authority.",
    },
    {
      id: "target_propose",
      mcpTools: ["semctx_control_target_propose"],
      effect: "tracked_create_only",
      requiresUserWriteScope: true,
      condition: "migration_task",
      instruction:
        "When explicit user-authorized target content needs a repository artifact, create one immutable proposed revision from a FRESH state. Review and acceptance remain separate.",
    },
    {
      id: "refine",
      mcpTools: ["semctx_control_plan_change", "semctx_control_plan"],
      effect: "read_only",
      requiresUserWriteScope: false,
      condition: "write_task",
      instruction:
        "Compile the bound task into the smallest proof-bearing refinement plan with semctx_control_plan_change. Use semctx_control_plan only for an explicit target architecture, and treat every fail-closed refusal as a real planning result.",
    },
    {
      id: "change_contract",
      mcpTools: ["semctx_change_open", "semctx_change_update"],
      effect: "tracked_create_or_update",
      requiresUserWriteScope: true,
      condition: "write_task",
      instruction:
        "Open or update the authored change contract before substantial edits, recording the goal, invariants, evidence requirements and unresolved unknowns.",
    },
    {
      id: "implement",
      mcpTools: [],
      effect: "user_authorized_repository_write",
      requiresUserWriteScope: true,
      condition: "write_task",
      instruction:
        "Make only the user-authorized coherent change and run the runtime tests selected by repository evidence. Semctx never executes the change or replaces those tests.",
    },
    {
      id: "reconcile_diff",
      mcpTools: ["semctx_control_reconcile_diff"],
      effect: "read_only",
      requiresUserWriteScope: false,
      condition: "after_edits",
      instruction:
        "Reconcile the actual worktree diff against the sealed envelope, planned edits, target, evidence, invariant impact and round-trip requirements.",
    },
    {
      id: "verify_change",
      mcpTools: ["semctx_verify_change"],
      effect: "read_only",
      requiresUserWriteScope: false,
      condition: "after_edits",
      instruction:
        "Verify the observed diff and record only evidence actually obtained; never upgrade a declared check into proof.",
    },
    {
      id: "change_verify",
      mcpTools: ["semctx_change_verify"],
      effect: "read_only",
      requiresUserWriteScope: false,
      condition: "after_edits",
      instruction:
        "Compose Plane A evidence with the change contract. Resolve an unknown only after proved_by links it to proven evidence; completion requires a derived verified lifecycle, not a caller assertion.",
    },
    {
      id: "handoff",
      mcpTools: ["semctx_handoff"],
      effect: "working_state_write",
      requiresUserWriteScope: true,
      condition: "before_handoff",
      instruction:
        "Capture the bounded handoff before compaction or owner transfer. A fresh context must return through semantic_check and resume the capsule before continuing.",
    },
  ],
  completion: {
    requiredStageIds: ["reconcile_diff", "verify_change", "change_verify"],
    handoffStageId: "handoff",
  },
}) as AgentWorkflowContractV1;
