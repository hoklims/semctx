import { z } from "zod";
import { TaskModeSchema } from "./schemas";
import type { RepositoryNode, RepositoryEdge, EvidenceRecord, EvidenceRef } from "./types/graph";
import type { Claim } from "./types/claim";
import type { TaskFrame } from "./types/task-frame";
import type { ContextPack } from "./types/context-pack";

const NodeKindValues = ["repository", "package", "module", "symbol", "type", "function", "class", "interface", "enum", "test", "migration", "document", "contract", "invariant", "capability", "bounded_context", "decision", "risk", "external_integration"] as const;
export const NodeKindSchema = z.enum(NodeKindValues);
const EdgeKindValues = ["imports", "exports", "calls", "references", "extends", "implements", "declares", "tested_by", "covers", "depends_on", "belongs_to", "implements_capability", "constrained_by", "verifies", "documents", "decides", "changes", "contradicts", "related_to"] as const;
export const EdgeKindSchema = z.enum(EdgeKindValues);
const EvidenceSourceKindValues = ["code", "test", "document", "git", "runtime", "manual"] as const;
export const EvidenceSourceKindSchema = z.enum(EvidenceSourceKindValues);
export const ClaimKindSchema = z.enum(["contract", "invariant", "decision", "capability", "behavior", "risk", "ownership", "deprecation", "assumption"]);
export const VerificationStatusSchema = z.enum(["unverified", "inferred", "documented", "tested", "statically_verified", "runtime_verified", "contradicted", "deprecated"]);
export const QuestionKindSchema = z.enum(["public_api", "persistence", "business_rule", "runtime_behavior", "historical_reason", "style", "security"]);

const StringArraySchema = indexedArray(z.string());
const UnitIntervalSchema = z.number().finite().min(0).max(1);
// Array schemas validate original indexed values rather than a replaceable iterator.
function indexedArray<T>(item: z.ZodType<T>): z.ZodType<T[]> {
  return z.custom<T[]>((value) => arrayOf(value, (member): member is T => item.safeParse(member).success));
}

function nonTransforming<T>(shape: z.ZodType<T>): z.ZodType<T> {
  // safeParse checks the complete known shape once; custom parsing returns the original data.
  return z.custom<T>((value) => shape.safeParse(value).success);
}

// Canonical runtime checks for the persisted graph's non-transforming data format.
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && !(value instanceof Date) && !(value instanceof Map) && !(value instanceof Set)
    && !(value instanceof Promise);
}
function member(options: readonly string[], value: unknown): boolean {
  return typeof value === "string" && options.includes(value);
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function optionalString(value: unknown): value is string | undefined { return value === undefined || typeof value === "string"; }
function optionalLine(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function arrayOf<T>(value: unknown, check: (item: unknown) => item is T): value is T[] {
  if (!Array.isArray(value) || value[Symbol.iterator] !== Array.prototype[Symbol.iterator]) return false;
  // Validate the returned indexed values, rejecting sparse slots and overridden iteration.
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index) || !check(value[index])) return false;
  }
  return true;
}
function string(value: unknown): value is string { return typeof value === "string"; }
function metadata(value: unknown): value is RepositoryNode["metadata"] {
  if (!record(value)) return false;
  for (const key in value) {
    const item = value[key];
    if (typeof item !== "string" && typeof item !== "boolean"
      && !(typeof item === "number" && Number.isFinite(item))) return false;
  }
  return true;
}
function evidenceRef(value: unknown): value is EvidenceRef {
  return record(value) && string(value["filePath"])
    && member(EvidenceSourceKindValues, value["sourceKind"])
    && optionalLine(value["startLine"]) && optionalLine(value["endLine"])
    && optionalString(value["excerpt"]);
}
function evidenceRecord(value: unknown): value is EvidenceRecord {
  return evidenceRef(value) && "id" in value && nonempty(value.id);
}
function repositoryNode(value: unknown): value is RepositoryNode {
  return record(value) && nonempty(value["id"])
    && member(NodeKindValues, value["kind"]) && string(value["name"])
    && optionalString(value["filePath"]) && optionalString(value["boundedContext"])
    && (value["exported"] === undefined || typeof value["exported"] === "boolean")
    && arrayOf(value["evidence"], evidenceRef) && arrayOf(value["tags"], string) && metadata(value["metadata"]);
}
function repositoryEdge(value: unknown): value is RepositoryEdge {
  return record(value) && nonempty(value["id"])
    && member(EdgeKindValues, value["kind"])
    && nonempty(value["from"]) && nonempty(value["to"])
    && arrayOf(value["evidence"], evidenceRef) && metadata(value["metadata"]);
}

export const EvidenceRefSchema = z.custom<EvidenceRef>(evidenceRef);
export const EvidenceRecordSchema = z.custom<EvidenceRecord>(evidenceRecord);
export const RepositoryNodeSchema = z.custom<RepositoryNode>(repositoryNode);
export const RepositoryEdgeSchema = z.custom<RepositoryEdge>(repositoryEdge);
// Only for rows freshly assembled by repository-store from owned SQLite/JSON values.
// These invoke the same canonical predicate; invalid input retains schema diagnostics.
export const OwnedRepositoryNodeRowParser = {
  parse(value: unknown): RepositoryNode {
    return repositoryNode(value) ? value : RepositoryNodeSchema.parse(value);
  },
};
export const OwnedRepositoryEdgeRowParser = {
  parse(value: unknown): RepositoryEdge {
    return repositoryEdge(value) ? value : RepositoryEdgeSchema.parse(value);
  },
};
export const RepositoryGraphSchema = z.object({ nodes: indexedArray(RepositoryNodeSchema), edges: indexedArray(RepositoryEdgeSchema) }).passthrough();

// Persisted JSON payloads historically retained consumer extension fields at every level.
// Validate known members without stripping those fields from returned task/context values.
const ClaimShape = z.object({
  id: z.string().min(1), kind: ClaimKindSchema, statement: z.string(), subjectNodeIds: StringArraySchema, evidenceIds: StringArraySchema,
  authority: UnitIntervalSchema, freshness: UnitIntervalSchema, confidence: UnitIntervalSchema, verificationStatus: VerificationStatusSchema,
  validFrom: z.string().optional(), validUntil: z.string().optional(), tags: StringArraySchema,
}).passthrough() satisfies z.ZodType<Claim>;
export const ClaimSchema = nonTransforming<Claim>(ClaimShape);

const TaskFrameShape = z.object({
  id: z.string(), rawTask: z.string(), mode: TaskModeSchema, capabilities: StringArraySchema,
  observedBehavior: StringArraySchema, expectedBehavior: StringArraySchema, boundedContexts: StringArraySchema,
  hardInvariants: StringArraySchema, softConstraints: StringArraySchema, acceptanceEvidence: StringArraySchema, nonGoals: StringArraySchema, riskSurfaces: StringArraySchema,
  hypotheses: indexedArray(z.object({
    id: z.string(), statement: z.string(), confidence: UnitIntervalSchema, evidenceIds: StringArraySchema,
    status: z.enum(["unverified", "supported", "rejected"]),
  }).passthrough()),
  createdAt: z.string(),
}).passthrough() satisfies z.ZodType<TaskFrame>;
export const TaskFrameSchema = nonTransforming<TaskFrame>(TaskFrameShape);

const ContextPackShape = z.object({
  taskFrame: TaskFrameSchema,
  hardConstraints: indexedArray(ClaimSchema), authoritativeClaims: indexedArray(ClaimSchema),
  primaryNodes: indexedArray(RepositoryNodeSchema), secondaryNodes: indexedArray(RepositoryNodeSchema),
  impactPaths: indexedArray(z.object({ nodeIds: StringArraySchema, edgeKinds: indexedArray(EdgeKindSchema), description: z.string() }).passthrough()),
  relevantTests: indexedArray(RepositoryNodeSchema), contradictions: indexedArray(ClaimSchema), unknowns: StringArraySchema,
  recommendedReads: indexedArray(z.object({
    path: z.string(), reason: z.string(), priority: z.enum(["critical", "high", "medium"]), evidenceIds: StringArraySchema,
  }).passthrough()),
  verificationPlan: z.object({
    steps: indexedArray(z.object({
      description: z.string(), kind: z.enum(["run_test", "static_check", "manual_review", "reproduce"]),
      command: z.string().optional(), targetNodeIds: StringArraySchema, evidenceIds: StringArraySchema,
    }).passthrough()),
    requiredTests: StringArraySchema, notes: StringArraySchema,
  }).passthrough(),
  generatedAt: z.string(), evidence: indexedArray(EvidenceRecordSchema),
  priorityExplanations: indexedArray(z.object({
    targetId: z.string(), targetKind: z.enum(["node", "claim"]), score: z.number().finite(), eligible: z.boolean(),
    roleMatch: z.number().finite(), authority: z.number().finite(), graphReachability: z.number().finite(),
    verificationStrength: z.number().finite(), freshness: z.number().finite(), contradictionPenalty: z.number().finite(),
    gates: indexedArray(z.object({ name: z.string(), passed: z.boolean(), reason: z.string() }).passthrough()), explanation: StringArraySchema,
  }).passthrough()),
  meta: z.object({
    taskId: z.string(), questionKind: QuestionKindSchema, deterministic: z.boolean(), generator: z.string(),
    candidateProviders: StringArraySchema, warnings: StringArraySchema,
  }).passthrough(),
}).passthrough() satisfies z.ZodType<ContextPack>;
export const ContextPackSchema = nonTransforming<ContextPack>(ContextPackShape);
