/** Zod schemas. Used ONLY at system boundaries: user task input, config on disk, IPC. */
import { z } from "zod";

export const TaskModeSchema = z.enum([
  "bugfix",
  "feature",
  "refactor",
  "audit",
  "performance",
  "security",
  "migration",
]);

/** Lenient user-facing task input (task.json / --text). Everything but rawTask optional. */
export const TaskFrameInputSchema = z
  .object({
    rawTask: z.string().min(1, "rawTask must not be empty"),
    mode: TaskModeSchema.optional(),
    capabilities: z.array(z.string()).optional(),
    observedBehavior: z.array(z.string()).optional(),
    expectedBehavior: z.array(z.string()).optional(),
    boundedContexts: z.array(z.string()).optional(),
    hardInvariants: z.array(z.string()).optional(),
    softConstraints: z.array(z.string()).optional(),
    acceptanceEvidence: z.array(z.string()).optional(),
    nonGoals: z.array(z.string()).optional(),
    riskSurfaces: z.array(z.string()).optional(),
  })
  .strict();

export type TaskFrameInput = z.infer<typeof TaskFrameInputSchema>;

export const BlockingConditionSchema = z.enum([
  "invariant_touched_without_test",
  "critical_contract_changed_without_test",
  "contract_changed_without_test",
  "contradiction_unresolved",
  "security_surface_without_verification",
  "analysis_scope_incomplete",
  "index_binding_stale",
]);

export const BlockingRuleSchema = z.object({
  id: z.string(),
  description: z.string(),
  when: BlockingConditionSchema,
  severity: z.enum(["warn", "block"]),
  // Optional for backward compatibility with pre-tier configs; derived from severity when absent.
  tier: z.enum(["strict", "advisory"]).optional(),
});

export const SemanticPolicyConfigSchema = z.object({
  enabled: z.boolean(),
  criticalInvariantTags: z.array(z.string()),
  openUnknownSeverity: z.enum(["warn", "block"]),
  supersededDecisionSeverity: z.enum(["warn", "block"]),
  requireProofForActiveChange: z.boolean(),
});

const SemctxConfigBaseSchema = z.object({
  /**
   * Optional on disk and ignored at load: `loadConfig(root)` always injects the call/CLI root.
   * Accepted for backward compatibility with older absolute or `"."` values.
   */
  repositoryRoot: z.string().optional(),
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  docsDirs: z.array(z.string()),
  migrationsDirs: z.array(z.string()),
  testGlobs: z.array(z.string()),
  semanticProvider: z.enum(["none", "cocoindex"]),
  blockingRules: z.array(BlockingRuleSchema),
  // Additive & optional: pre-semantic configs still validate; unknown-key stripping no longer
  // silently drops a `semantic` block now that it is part of the schema.
  semantic: SemanticPolicyConfigSchema.optional(),
});

export const SemctxConfigV1Schema = SemctxConfigBaseSchema.extend({
  version: z.literal(1),
});

export const SemctxConfigV2Schema = SemctxConfigBaseSchema.extend({
  version: z.literal(2),
  selectionMode: z.literal("globs-v1"),
  languages: z.record(z.enum(["on", "off"])),
});

export const SemctxConfigSchema = z.discriminatedUnion("version", [
  SemctxConfigV1Schema,
  SemctxConfigV2Schema,
]);

export type SemctxConfigParsed = z.infer<typeof SemctxConfigSchema>;
