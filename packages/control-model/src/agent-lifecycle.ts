import { z } from "zod";
import { serializeControlReport } from "./canonical";
import {
  AGENT_WORKFLOW_STAGE_ORDER,
  type AgentWorkflowStageIdV1,
} from "./agent-workflow";
import { sha256HashBytes } from "./hashing";
import { compareCodeUnits } from "./ordering";
import type { SemanticLevel, Sha256Hash } from "./types";

export const AGENT_LIFECYCLE_CHECKPOINT_ORDER = [
  "before_implementation_write",
  "after_repository_edits",
  "before_completion",
  "before_compaction",
] as const;

export const AGENT_LIFECYCLE_REASON_ORDER = [
  "NON_SEMCTX_REPOSITORY",
  "BELOW_L2_CHECKPOINT_THRESHOLD",
  "SEMCTX_REPOSITORY_UNREADY",
  "REQUIRED_STAGE_NOT_RECORDED",
] as const;

export const AgentLifecycleCheckpointV1Schema = z.enum(AGENT_LIFECYCLE_CHECKPOINT_ORDER);
export const AgentLifecycleProfileV1Schema = z.enum(["implementation", "migration"]);
export const AgentLifecycleApplicabilityV1Schema = z.enum(["eligible", "not_applicable"]);
export const AgentLifecycleRepositoryStateV1Schema = z.enum([
  "non_semctx",
  "semctx_unready",
  "semctx_ready",
]);
export const AgentLifecycleStagePresenceVerdictV1Schema = z.enum([
  "NO_OP",
  "RECORDED",
  "INCOMPLETE",
]);
export const AgentLifecycleReasonCodeV1Schema = z.enum(AGENT_LIFECYCLE_REASON_ORDER);
export const AgentLifecycleRequiredAltitudeV1Schema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);
export const AgentLifecycleTouchEvidenceV1Schema = z.literal("caller_observed_advisory");
export const AgentLifecycleAccumulationSemanticsV1Schema = z.literal(
  "stateless_caller_reinjected_unbound",
);

export type AgentLifecycleCheckpointV1 = z.infer<typeof AgentLifecycleCheckpointV1Schema>;
export type AgentLifecycleProfileV1 = z.infer<typeof AgentLifecycleProfileV1Schema>;
export type AgentLifecycleApplicabilityV1 = z.infer<typeof AgentLifecycleApplicabilityV1Schema>;
export type AgentLifecycleRepositoryStateV1 = z.infer<typeof AgentLifecycleRepositoryStateV1Schema>;
export type AgentLifecycleStagePresenceVerdictV1 =
  z.infer<typeof AgentLifecycleStagePresenceVerdictV1Schema>;
export type AgentLifecycleReasonCodeV1 = z.infer<typeof AgentLifecycleReasonCodeV1Schema>;

const PRE_WRITE_IMPLEMENTATION_STAGES = [
  "inspect_repository",
  "semantic_check",
  "status",
  "frame_task",
  "bind_scope",
  "trace_impact",
  "authority",
  "refine",
  "change_contract",
] as const;

const PRE_WRITE_MIGRATION_STAGES = [
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
] as const;

const COMPLETION_STAGES = ["reconcile_diff", "verify_change", "change_verify"] as const;
const HANDOFF_STAGES = ["handoff"] as const;
const NO_STAGES = [] as const;

export interface AgentLifecyclePolicyV1 {
  readonly schemaVersion: 1;
  readonly kind: "agent_lifecycle_policy";
  readonly enforcementMode: "shadow";
  readonly blockingEnabled: false;
  readonly executionAuthority: "none";
  readonly nonSemctxRepository: "no_op";
  readonly stageOutcomeEvaluation: "none";
  readonly sourceCollection: "none";
  readonly mcpTool: "semctx_control_agent_lifecycle";
  readonly coordinateAccumulation: "stateless_caller_reinjected_unbound";
  readonly limits: {
    readonly maxRecordedStageIds: 15;
    readonly maxPriorTouchedCoordinateIds: 512;
    readonly maxNewlyObservedTouchedCoordinateIds: 256;
    readonly maxAccumulatedTouchedCoordinateIds: 512;
    readonly maxCoordinateIdCharacters: 512;
  };
  readonly checkpoints: readonly [
    {
      readonly id: "before_implementation_write";
      readonly minimumAltitude: 2;
      readonly requiredStageIds: {
        readonly implementation: typeof PRE_WRITE_IMPLEMENTATION_STAGES;
        readonly migration: typeof PRE_WRITE_MIGRATION_STAGES;
      };
    },
    {
      readonly id: "after_repository_edits";
      readonly minimumAltitude: 0;
      readonly requiredStageIds: {
        readonly implementation: typeof NO_STAGES;
        readonly migration: typeof NO_STAGES;
      };
    },
    {
      readonly id: "before_completion";
      readonly minimumAltitude: 0;
      readonly requiredStageIds: {
        readonly implementation: typeof COMPLETION_STAGES;
        readonly migration: typeof COMPLETION_STAGES;
      };
    },
    {
      readonly id: "before_compaction";
      readonly minimumAltitude: 0;
      readonly requiredStageIds: {
        readonly implementation: typeof HANDOFF_STAGES;
        readonly migration: typeof HANDOFF_STAGES;
      };
    },
  ];
}

const preWriteImplementationStagesSchema = z.tuple([
  z.literal("inspect_repository"),
  z.literal("semantic_check"),
  z.literal("status"),
  z.literal("frame_task"),
  z.literal("bind_scope"),
  z.literal("trace_impact"),
  z.literal("authority"),
  z.literal("refine"),
  z.literal("change_contract"),
]);
const preWriteMigrationStagesSchema = z.tuple([
  z.literal("inspect_repository"),
  z.literal("semantic_check"),
  z.literal("status"),
  z.literal("frame_task"),
  z.literal("bind_scope"),
  z.literal("trace_impact"),
  z.literal("authority"),
  z.literal("target_propose"),
  z.literal("refine"),
  z.literal("change_contract"),
]);
const completionStagesSchema = z.tuple([
  z.literal("reconcile_diff"),
  z.literal("verify_change"),
  z.literal("change_verify"),
]);
const handoffStagesSchema = z.tuple([z.literal("handoff")]);
const noStagesSchema = z.tuple([]);

const requiredStageIdsSchema = <
  I extends z.ZodTypeAny,
  M extends z.ZodTypeAny,
>(implementation: I, migration: M) => z.object({
  implementation,
  migration,
}).strict();

export const AgentLifecyclePolicyV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("agent_lifecycle_policy"),
  enforcementMode: z.literal("shadow"),
  blockingEnabled: z.literal(false),
  executionAuthority: z.literal("none"),
  nonSemctxRepository: z.literal("no_op"),
  stageOutcomeEvaluation: z.literal("none"),
  sourceCollection: z.literal("none"),
  mcpTool: z.literal("semctx_control_agent_lifecycle"),
  coordinateAccumulation: AgentLifecycleAccumulationSemanticsV1Schema,
  limits: z.object({
    maxRecordedStageIds: z.literal(15),
    maxPriorTouchedCoordinateIds: z.literal(512),
    maxNewlyObservedTouchedCoordinateIds: z.literal(256),
    maxAccumulatedTouchedCoordinateIds: z.literal(512),
    maxCoordinateIdCharacters: z.literal(512),
  }).strict(),
  checkpoints: z.tuple([
    z.object({
      id: z.literal("before_implementation_write"),
      minimumAltitude: z.literal(2),
      requiredStageIds: requiredStageIdsSchema(
        preWriteImplementationStagesSchema,
        preWriteMigrationStagesSchema,
      ),
    }).strict(),
    z.object({
      id: z.literal("after_repository_edits"),
      minimumAltitude: z.literal(0),
      requiredStageIds: requiredStageIdsSchema(noStagesSchema, noStagesSchema),
    }).strict(),
    z.object({
      id: z.literal("before_completion"),
      minimumAltitude: z.literal(0),
      requiredStageIds: requiredStageIdsSchema(completionStagesSchema, completionStagesSchema),
    }).strict(),
    z.object({
      id: z.literal("before_compaction"),
      minimumAltitude: z.literal(0),
      requiredStageIds: requiredStageIdsSchema(handoffStagesSchema, handoffStagesSchema),
    }).strict(),
  ]),
}).strict().superRefine((policy, context) => {
  for (const [checkpointIndex, checkpoint] of policy.checkpoints.entries()) {
    for (const profile of ["implementation", "migration"] as const) {
      const stages = checkpoint.requiredStageIds[profile];
      if (new Set(stages).size !== stages.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["checkpoints", checkpointIndex, "requiredStageIds", profile],
          message: "required lifecycle stages must be unique",
        });
      }
      if (!isCanonicalStageOrder(stages)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["checkpoints", checkpointIndex, "requiredStageIds", profile],
          message: "required lifecycle stages must follow canonical workflow order",
        });
      }
    }
  }

  const preWrite = policy.checkpoints[0].requiredStageIds;
  const expectedMigration = insertAtWorkflowPosition(
    preWrite.implementation,
    "target_propose",
  );
  if (!arraysEqual(preWrite.migration, expectedMigration)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["checkpoints", 0, "requiredStageIds", "migration"],
      message: "migration pre-write stages must add target_propose at its workflow position",
    });
  }
});

export const AGENT_LIFECYCLE_POLICY_V1 = AgentLifecyclePolicyV1Schema.parse({
  schemaVersion: 1,
  kind: "agent_lifecycle_policy",
  enforcementMode: "shadow",
  blockingEnabled: false,
  executionAuthority: "none",
  nonSemctxRepository: "no_op",
  stageOutcomeEvaluation: "none",
  sourceCollection: "none",
  mcpTool: "semctx_control_agent_lifecycle",
  coordinateAccumulation: "stateless_caller_reinjected_unbound",
  limits: {
    maxRecordedStageIds: 15,
    maxPriorTouchedCoordinateIds: 512,
    maxNewlyObservedTouchedCoordinateIds: 256,
    maxAccumulatedTouchedCoordinateIds: 512,
    maxCoordinateIdCharacters: 512,
  },
  checkpoints: [
    {
      id: "before_implementation_write",
      minimumAltitude: 2,
      requiredStageIds: {
        implementation: PRE_WRITE_IMPLEMENTATION_STAGES,
        migration: PRE_WRITE_MIGRATION_STAGES,
      },
    },
    {
      id: "after_repository_edits",
      minimumAltitude: 0,
      requiredStageIds: { implementation: NO_STAGES, migration: NO_STAGES },
    },
    {
      id: "before_completion",
      minimumAltitude: 0,
      requiredStageIds: {
        implementation: COMPLETION_STAGES,
        migration: COMPLETION_STAGES,
      },
    },
    {
      id: "before_compaction",
      minimumAltitude: 0,
      requiredStageIds: {
        implementation: HANDOFF_STAGES,
        migration: HANDOFF_STAGES,
      },
    },
  ],
}) as AgentLifecyclePolicyV1;

const policyLimits = AGENT_LIFECYCLE_POLICY_V1.limits;
const AgentWorkflowStageIdV1Schema = z.enum(AGENT_WORKFLOW_STAGE_ORDER);

export const AgentLifecycleCoordinateIdV1Schema = z.string()
  .min(1)
  .max(policyLimits.maxCoordinateIdCharacters)
  .refine((value) => value === value.trim(), {
    message: "lifecycle coordinate id must not have surrounding whitespace",
  })
  .refine((value) => /^(?:repo|semantic):[^\p{C}\p{Zl}\p{Zp}]+$/u.test(value), {
    message: "lifecycle coordinate id must use repo: or semantic: and visible characters",
  });

const rawRequestSchema = z.object({
  schemaVersion: z.literal(1),
  checkpoint: AgentLifecycleCheckpointV1Schema,
  profile: AgentLifecycleProfileV1Schema,
  requiredAltitude: AgentLifecycleRequiredAltitudeV1Schema,
  recordedStageIds: z.array(AgentWorkflowStageIdV1Schema)
    .max(policyLimits.maxRecordedStageIds),
  priorTouchedCoordinateIds: z.array(AgentLifecycleCoordinateIdV1Schema)
    .max(policyLimits.maxPriorTouchedCoordinateIds),
  newlyObservedTouchedCoordinateIds: z.array(AgentLifecycleCoordinateIdV1Schema)
    .max(policyLimits.maxNewlyObservedTouchedCoordinateIds),
}).strict().superRefine((request, context) => {
  const accumulated = new Set([
    ...request.priorTouchedCoordinateIds,
    ...request.newlyObservedTouchedCoordinateIds,
  ]);
  if (accumulated.size > policyLimits.maxAccumulatedTouchedCoordinateIds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["newlyObservedTouchedCoordinateIds"],
      message:
        `accumulated touched coordinate limit exceeds ${
          policyLimits.maxAccumulatedTouchedCoordinateIds
        }`,
    });
  }
});

export const AgentLifecycleCheckpointRequestV1Schema = rawRequestSchema;

export type AgentLifecycleCheckpointRequestV1 =
  z.infer<typeof AgentLifecycleCheckpointRequestV1Schema>;
export type AgentLifecycleCheckpointRequestV1Input =
  z.input<typeof AgentLifecycleCheckpointRequestV1Schema>;

export function normalizeAgentLifecycleCheckpointRequestV1(
  input: unknown,
): AgentLifecycleCheckpointRequestV1 {
  const request = AgentLifecycleCheckpointRequestV1Schema.parse(input);
  return {
    ...request,
    recordedStageIds: canonicalizeStages(request.recordedStageIds),
    priorTouchedCoordinateIds: sortedUnique(request.priorTouchedCoordinateIds),
    newlyObservedTouchedCoordinateIds: sortedUnique(request.newlyObservedTouchedCoordinateIds),
  };
}

export interface AgentLifecycleReportV1 {
  readonly schemaVersion: 1;
  readonly kind: "agent_lifecycle_report";
  readonly checkpoint: AgentLifecycleCheckpointV1;
  readonly profile: AgentLifecycleProfileV1;
  readonly requiredAltitude: SemanticLevel;
  readonly applicability: AgentLifecycleApplicabilityV1;
  readonly repositoryState: AgentLifecycleRepositoryStateV1;
  readonly stagePresenceVerdict: AgentLifecycleStagePresenceVerdictV1;
  readonly stageOutcomesEvaluated: false;
  readonly admissibility: "not_evaluated";
  readonly reasonCodes: readonly AgentLifecycleReasonCodeV1[];
  readonly requiredStageIds: readonly AgentWorkflowStageIdV1[];
  readonly recordedStageIds: readonly AgentWorkflowStageIdV1[];
  readonly missingStageIds: readonly AgentWorkflowStageIdV1[];
  readonly accumulatedTouchedCoordinateIds: readonly string[];
  readonly touchEvidence: "caller_observed_advisory";
  readonly accumulationSemantics: "stateless_caller_reinjected_unbound";
  readonly enforcementMode: "shadow";
  readonly blockingEnabled: false;
  readonly executionAuthority: "none";
  readonly sourceContentCollected: false;
  readonly reportHash: Sha256Hash;
}

export type AgentLifecycleReportPreimageV1 = Omit<AgentLifecycleReportV1, "reportHash">;

const reportBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("agent_lifecycle_report"),
  checkpoint: AgentLifecycleCheckpointV1Schema,
  profile: AgentLifecycleProfileV1Schema,
  requiredAltitude: AgentLifecycleRequiredAltitudeV1Schema,
  applicability: AgentLifecycleApplicabilityV1Schema,
  repositoryState: AgentLifecycleRepositoryStateV1Schema,
  stagePresenceVerdict: AgentLifecycleStagePresenceVerdictV1Schema,
  stageOutcomesEvaluated: z.literal(false),
  admissibility: z.literal("not_evaluated"),
  reasonCodes: z.array(AgentLifecycleReasonCodeV1Schema)
    .max(AGENT_LIFECYCLE_REASON_ORDER.length),
  requiredStageIds: z.array(AgentWorkflowStageIdV1Schema)
    .max(policyLimits.maxRecordedStageIds),
  recordedStageIds: z.array(AgentWorkflowStageIdV1Schema)
    .max(policyLimits.maxRecordedStageIds),
  missingStageIds: z.array(AgentWorkflowStageIdV1Schema)
    .max(policyLimits.maxRecordedStageIds),
  accumulatedTouchedCoordinateIds: z.array(AgentLifecycleCoordinateIdV1Schema)
    .max(policyLimits.maxAccumulatedTouchedCoordinateIds),
  touchEvidence: AgentLifecycleTouchEvidenceV1Schema,
  accumulationSemantics: AgentLifecycleAccumulationSemanticsV1Schema,
  enforcementMode: z.literal("shadow"),
  blockingEnabled: z.literal(false),
  executionAuthority: z.literal("none"),
  sourceContentCollected: z.literal(false),
  reportHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

export const AgentLifecycleReportV1Schema = reportBaseSchema.superRefine((report, context) => {
  const { reportHash, ...preimage } = report;
  if (reportHash !== computeAgentLifecycleReportV1Hash(preimage)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reportHash"],
      message: "lifecycle report hash does not match its canonical preimage",
    });
  }

  validateCanonicalArray(report.reasonCodes, AGENT_LIFECYCLE_REASON_ORDER, context, "reasonCodes");
  validateCanonicalArray(
    report.requiredStageIds,
    AGENT_WORKFLOW_STAGE_ORDER,
    context,
    "requiredStageIds",
  );
  validateCanonicalArray(
    report.recordedStageIds,
    AGENT_WORKFLOW_STAGE_ORDER,
    context,
    "recordedStageIds",
  );
  validateCanonicalArray(
    report.missingStageIds,
    AGENT_WORKFLOW_STAGE_ORDER,
    context,
    "missingStageIds",
  );
  if (!arraysEqual(
    report.accumulatedTouchedCoordinateIds,
    sortedUnique(report.accumulatedTouchedCoordinateIds),
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["accumulatedTouchedCoordinateIds"],
      message: "accumulated touched coordinate ids must be sorted and unique",
    });
  }

  const expected = expectedDecision(
    report.repositoryState,
    report.checkpoint,
    report.profile,
    report.requiredAltitude,
    report.recordedStageIds,
  );
  for (const [field, actual, wanted] of [
    ["applicability", report.applicability, expected.applicability],
    ["stagePresenceVerdict", report.stagePresenceVerdict, expected.stagePresenceVerdict],
  ] as const) {
    if (actual !== wanted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is inconsistent with the lifecycle decision table`,
      });
    }
  }
  for (const [field, actual, wanted] of [
    ["reasonCodes", report.reasonCodes, expected.reasonCodes],
    ["requiredStageIds", report.requiredStageIds, expected.requiredStageIds],
    ["missingStageIds", report.missingStageIds, expected.missingStageIds],
  ] as const) {
    if (!arraysEqual(actual, wanted)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is inconsistent with the lifecycle decision table`,
      });
    }
  }

  if (expected.applicability === "not_applicable") {
    for (const field of [
      "recordedStageIds",
      "accumulatedTouchedCoordinateIds",
    ] as const) {
      if (report[field].length !== 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must be empty for a no-op lifecycle report`,
        });
      }
    }
  }
});

/**
 * Domain separator for the lifecycle report hash. Exported so an out-of-process evaluator — the
 * shadow completion hook shipped by both plugins — derives the same `reportHash` from the generated
 * contract instead of re-declaring the constant and drifting from it.
 */
export const AGENT_LIFECYCLE_REPORT_DOMAIN_V1 = "semctx.agent-lifecycle-report.v1\0";

const lifecycleReportDomain = new TextEncoder().encode(AGENT_LIFECYCLE_REPORT_DOMAIN_V1);

export function computeAgentLifecycleReportV1Hash(
  report: AgentLifecycleReportPreimageV1,
): Sha256Hash {
  return sha256HashBytes(concatBytes([
    lifecycleReportDomain,
    new TextEncoder().encode(serializeControlReport(report)),
  ]));
}

export function evaluateAgentLifecycleCheckpointV1(
  repositoryState: AgentLifecycleRepositoryStateV1,
  input: unknown,
): AgentLifecycleReportV1 {
  const request = normalizeAgentLifecycleCheckpointRequestV1(input);
  const decision = expectedDecision(
    repositoryState,
    request.checkpoint,
    request.profile,
    request.requiredAltitude,
    request.recordedStageIds,
  );
  const eligible = decision.applicability === "eligible";
  const preimage: AgentLifecycleReportPreimageV1 = {
    schemaVersion: 1,
    kind: "agent_lifecycle_report",
    checkpoint: request.checkpoint,
    profile: request.profile,
    requiredAltitude: request.requiredAltitude,
    applicability: decision.applicability,
    repositoryState,
    stagePresenceVerdict: decision.stagePresenceVerdict,
    stageOutcomesEvaluated: false,
    admissibility: "not_evaluated",
    reasonCodes: decision.reasonCodes,
    requiredStageIds: decision.requiredStageIds,
    recordedStageIds: eligible ? request.recordedStageIds : [],
    missingStageIds: decision.missingStageIds,
    accumulatedTouchedCoordinateIds: eligible
      ? sortedUnique([
        ...request.priorTouchedCoordinateIds,
        ...request.newlyObservedTouchedCoordinateIds,
      ])
      : [],
    touchEvidence: "caller_observed_advisory",
    accumulationSemantics: AGENT_LIFECYCLE_POLICY_V1.coordinateAccumulation,
    enforcementMode: AGENT_LIFECYCLE_POLICY_V1.enforcementMode,
    blockingEnabled: AGENT_LIFECYCLE_POLICY_V1.blockingEnabled,
    executionAuthority: AGENT_LIFECYCLE_POLICY_V1.executionAuthority,
    sourceContentCollected: false,
  };
  return AgentLifecycleReportV1Schema.parse({
    ...preimage,
    reportHash: computeAgentLifecycleReportV1Hash(preimage),
  }) as AgentLifecycleReportV1;
}

function expectedDecision(
  repositoryState: AgentLifecycleRepositoryStateV1,
  checkpoint: AgentLifecycleCheckpointV1,
  profile: AgentLifecycleProfileV1,
  requiredAltitude: SemanticLevel,
  recordedStageIds: readonly AgentWorkflowStageIdV1[],
) {
  const nonSemctx = repositoryState === "non_semctx";
  const belowThreshold = checkpoint === "before_implementation_write"
    && requiredAltitude < AGENT_LIFECYCLE_POLICY_V1.checkpoints[0].minimumAltitude;
  const applicable = !nonSemctx && !belowThreshold;
  const requiredStageIds = applicable
    ? requiredStages(checkpoint, profile)
    : [];
  const recorded = new Set(recordedStageIds);
  const missingStageIds = requiredStageIds.filter((stage) => !recorded.has(stage));
  const reasonCodes: AgentLifecycleReasonCodeV1[] = [];
  if (nonSemctx) reasonCodes.push("NON_SEMCTX_REPOSITORY");
  if (belowThreshold && !nonSemctx) reasonCodes.push("BELOW_L2_CHECKPOINT_THRESHOLD");
  if (!nonSemctx && repositoryState === "semctx_unready") {
    reasonCodes.push("SEMCTX_REPOSITORY_UNREADY");
  }
  if (applicable && missingStageIds.length > 0) {
    reasonCodes.push("REQUIRED_STAGE_NOT_RECORDED");
  }
  return {
    applicability: applicable ? "eligible" : "not_applicable",
    stagePresenceVerdict: !applicable
      ? "NO_OP"
      : missingStageIds.length > 0
        ? "INCOMPLETE"
        : "RECORDED",
    reasonCodes,
    requiredStageIds,
    missingStageIds,
  } as const;
}

function requiredStages(
  checkpoint: AgentLifecycleCheckpointV1,
  profile: AgentLifecycleProfileV1,
): readonly AgentWorkflowStageIdV1[] {
  const policyCheckpoint = AGENT_LIFECYCLE_POLICY_V1.checkpoints.find(
    (candidate) => candidate.id === checkpoint,
  );
  if (!policyCheckpoint) throw new Error(`unknown lifecycle checkpoint: ${checkpoint}`);
  return policyCheckpoint.requiredStageIds[profile];
}

function canonicalizeStages(
  stages: readonly AgentWorkflowStageIdV1[],
): AgentWorkflowStageIdV1[] {
  const present = new Set(stages);
  return AGENT_WORKFLOW_STAGE_ORDER.filter((stage) => present.has(stage));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function isCanonicalStageOrder(stages: readonly AgentWorkflowStageIdV1[]): boolean {
  return arraysEqual(stages, canonicalizeStages(stages));
}

function insertAtWorkflowPosition(
  stages: readonly AgentWorkflowStageIdV1[],
  inserted: AgentWorkflowStageIdV1,
): AgentWorkflowStageIdV1[] {
  return canonicalizeStages([...stages, inserted]);
}

function arraysEqual(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateCanonicalArray<T extends string>(
  actual: readonly T[],
  order: readonly T[],
  context: z.RefinementCtx,
  path: string,
): void {
  const present = new Set(actual);
  const expected = order.filter((value) => present.has(value));
  if (!arraysEqual(actual, expected)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [path],
      message: `${path} must be unique and canonically ordered`,
    });
  }
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
