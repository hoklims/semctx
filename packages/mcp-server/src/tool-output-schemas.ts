import { z } from "zod-v4";
import {
  AgentLifecycleReportV1Schema,
  AltitudeAuthorityReportV1Schema,
  ArchitectureComparisonReportSchema,
  ChangeAuthorizationReasonCodeV1Schema,
  ChangeAuthorizationVerdictV1Schema,
  ControlFreshnessReasonSchema,
  ControlFreshnessSealV2Schema,
  ControlFreshnessStatusReportSchema,
  ControlReasonCodeV1Schema,
  ControlTerminalStatusV1Schema,
  CoordinateGraphReportV2Schema,
  DeletionAuthorizationReportV2Schema,
  ExplanationReportSchema,
  ImpactReportSchema,
  MigrationPlanReportSchema,
  PlanningBundleV1Schema,
  ReconcileDiffReportV1Schema,
  RefinementCoverageReportV1Schema,
  Sha256HashSchema,
  StepAuthorizationReportV2Schema,
  TaskEnvelopeV1Schema,
  TransitionAuthorizationReportV2Schema,
  TraversalReportV2Schema,
  WorkspaceBaselineSnapshotV1Schema,
  CanonicalLinkResolutionSchema,
} from "@semantic-context/control-model";
import {
  CHANGE_AUTHORIZATION_VERIFICATION_AUTHORITY_REASONS,
  CHANGE_AUTHORIZATION_VERIFICATION_AUTHORITY_RESULTS,
  CHANGE_AUTHORIZATION_VERIFICATION_INTEGRITY_REASONS,
  CHANGE_AUTHORIZATION_VERIFICATION_INTEGRITY_RESULTS,
  CHANGE_AUTHORIZATION_VERIFICATION_REASON_CODES,
  CHANGE_AUTHORIZATION_VERIFICATION_RESULTS,
  CHANGE_AUTHORIZATION_VERIFICATION_SEMANTIC_REASONS,
  ChangeAuthorizationVerificationReportV1Schema,
} from "@semantic-context/change-authorization-verifier";
import {
  ControlHandoffCaptureResultV2Schema,
  ControlHandoffResumeResultV2Schema,
} from "@semantic-context/control-model/control-handoff";
import {
  ChangeContractSchema as SemanticChangeContractSchema,
  RepositoryLinkSchema,
  SemanticNodeSchema,
} from "@semantic-context/semantic-model";
import { TargetArchitectureArtifactV1Schema } from "@semantic-context/semantic-engine";
import { SETUP_POLYGLOT_V1_REFUSE_REASON_CODE } from "@semantic-context/app-services";
import { ControlExplorerOutputSchema } from "./control-explorer";
import { mcpSchema } from "./schema-boundary";
import type { SemctxToolName } from "./tool-contract";

const described = <T extends z.ZodType>(schema: T, description: string): T =>
  schema.describe(description) as T;

const stringArray = (description: string): z.ZodArray<z.ZodString> =>
  z.array(z.string()).describe(description);

const EvidenceRefSchema = z.object({
  filePath: described(z.string(), "Repository-relative evidence file path."),
  startLine: described(z.number().int().positive().optional(), "Optional first evidence line."),
  endLine: described(z.number().int().positive().optional(), "Optional last evidence line."),
  sourceKind: described(
    z.enum(["code", "test", "document", "git", "runtime", "manual"]),
    "Kind of source that carries the evidence.",
  ),
  excerpt: described(z.string().optional(), "Optional source excerpt."),
}).strict();

const RepositoryNodeSchema = z.object({
  id: described(z.string(), "Stable repository-node identifier."),
  kind: described(z.enum([
    "repository", "package", "module", "symbol", "type", "function", "class",
    "interface", "enum", "test", "migration", "document", "contract",
    "invariant", "capability", "bounded_context", "decision", "risk",
    "external_integration",
  ]), "Repository node kind."),
  name: described(z.string(), "Human-readable node name."),
  filePath: described(z.string().optional(), "Optional repository-relative file path."),
  boundedContext: described(z.string().optional(), "Optional bounded-context identifier."),
  exported: described(z.boolean().optional(), "Whether the node is exported."),
  evidence: described(z.array(EvidenceRefSchema), "Evidence supporting the node."),
  tags: stringArray("Node tags."),
  metadata: described(
    z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    "Open scalar metadata emitted by repository analyzers.",
  ),
}).strict();

const ClaimSchema = z.object({
  id: described(z.string(), "Stable claim identifier."),
  kind: described(z.enum([
    "contract", "invariant", "decision", "capability", "behavior", "risk",
    "ownership", "deprecation", "assumption",
  ]), "Claim kind."),
  statement: described(z.string(), "Claim statement."),
  subjectNodeIds: stringArray("Repository nodes governed by the claim."),
  evidenceIds: stringArray("Evidence identifiers supporting the claim."),
  authority: described(z.number().min(0).max(1), "Authority score."),
  freshness: described(z.number().min(0).max(1), "Freshness score."),
  confidence: described(z.number().min(0).max(1), "Confidence score."),
  verificationStatus: described(z.enum([
    "unverified", "inferred", "documented", "tested", "statically_verified",
    "runtime_verified", "contradicted", "deprecated",
  ]), "Claim verification status."),
  validFrom: described(z.string().optional(), "Optional validity start."),
  validUntil: described(z.string().optional(), "Optional validity end."),
  tags: stringArray("Claim tags."),
}).strict();

const VerifyReportSymbolSchema = z.object({
  id: described(z.string(), "Stable symbol identifier."),
  name: described(z.string(), "Symbol name."),
  kind: described(z.string(), "Symbol kind."),
  file: described(z.string().optional(), "Optional repository-relative file."),
}).strict();

const VerifyReportClaimSchema = z.object({
  statement: described(z.string(), "Claim statement."),
  kind: described(z.string(), "Claim kind."),
  verificationStatus: described(z.string(), "Claim verification status."),
}).strict();

const VerifyReportSchema = z.object({
  schemaVersion: described(z.literal(1), "Verify-report schema version."),
  verdict: described(z.enum(["PASS", "WARN", "BLOCK"]), "Overall deterministic verdict."),
  base: described(z.string().nullable(), "Requested base ref, if any."),
  head: described(z.string(), "Analyzed head commit."),
  mergeBase: described(z.string().nullable(), "Resolved merge-base commit."),
  range: described(z.string().nullable(), "Human-readable analyzed Git range."),
  changedFiles: stringArray("Changed repository files."),
  changedSymbols: described(z.array(VerifyReportSymbolSchema), "Changed symbols."),
  impactedContracts: described(z.array(VerifyReportClaimSchema), "Impacted contract claims."),
  impactedInvariants: described(z.array(VerifyReportClaimSchema), "Impacted invariant claims."),
  recommendedTests: described(z.array(z.object({
    name: described(z.string(), "Test name."),
    file: described(z.string().optional(), "Optional test file."),
  }).strict()), "Recommended tests."),
  contradictions: described(z.array(VerifyReportClaimSchema), "Contradicted or deprecated claims."),
  unknowns: stringArray("Remaining analysis unknowns."),
  findings: described(z.array(z.object({
    rule: described(z.string(), "Triggered blocking-rule identifier."),
    tier: described(z.enum(["strict", "advisory"]), "Rule enforcement tier."),
    severity: described(z.enum(["warn", "block"]), "Finding severity."),
    message: described(z.string(), "Finding explanation."),
    nodeIds: stringArray("Repository nodes supporting the finding."),
    locations: described(z.array(z.object({
      file: described(z.string(), "Repository-relative file."),
      line: described(z.number().int().positive().optional(), "Optional source line."),
    }).strict()), "Concrete source locations."),
  }).strict()), "Verification findings."),
  impactedConsumers: described(z.array(z.object({
    symbol: described(VerifyReportSymbolSchema, "Impacted exported symbol."),
    consumers: described(z.array(VerifyReportSymbolSchema), "In-repository consumers."),
  }).strict()).optional(), "Optional consumer impact details."),
  coChangedFiles: described(z.array(z.object({
    file: described(z.string(), "Changed file."),
    coChanged: described(z.array(z.object({
      file: described(z.string(), "Historically co-changing file."),
      commits: described(z.number().int().nonnegative(), "Supporting commit count."),
    }).strict()), "Historical co-change evidence."),
  }).strict()).optional(), "Optional historical co-change signal."),
  summary: described(z.object({
    blockCount: described(z.number().int().nonnegative(), "Blocking finding count."),
    warnCount: described(z.number().int().nonnegative(), "Warning finding count."),
  }).strict(), "Finding counts."),
}).strict();

const InspectionResultSchema = z.object({
  query: described(z.string(), "Original inspection query."),
  kind: described(
    z.enum(["symbol", "capability", "invariant", "contract", "test", "document", "any"]),
    "Applied inspection kind.",
  ),
  matchedNodes: described(z.array(RepositoryNodeSchema), "Matching repository nodes."),
  relatedClaims: described(z.array(ClaimSchema), "Claims related to matched nodes."),
  relations: described(z.array(z.object({
    from: described(z.string(), "Source node identifier."),
    fromName: described(z.string(), "Source node name."),
    kind: described(z.string(), "Repository edge kind."),
    to: described(z.string(), "Target node identifier."),
    toName: described(z.string(), "Target node name."),
  }).strict()), "Relations touching matched nodes."),
  contradictions: described(z.array(ClaimSchema), "Contradicted or deprecated related claims."),
  evidence: described(z.array(EvidenceRefSchema.extend({
    id: described(z.string(), "Stable evidence identifier."),
  }).strict()), "Resolved evidence records."),
  filesToRead: stringArray("Repository files justified for reading."),
}).strict();

const TaskFrameSchema = z.object({
  id: described(z.string(), "Stable task-frame identifier."),
  rawTask: described(z.string(), "Original task text."),
  mode: described(z.enum(["bugfix", "feature", "refactor", "audit", "performance", "security", "migration"]), "Task mode."),
  capabilities: stringArray("Relevant capabilities."),
  observedBehavior: stringArray("Observed behaviours."),
  expectedBehavior: stringArray("Expected behaviours."),
  boundedContexts: stringArray("Relevant bounded contexts."),
  hardInvariants: stringArray("Hard invariants."),
  softConstraints: stringArray("Soft constraints."),
  acceptanceEvidence: stringArray("Required acceptance evidence."),
  nonGoals: stringArray("Explicit non-goals."),
  riskSurfaces: stringArray("Risk surfaces."),
  hypotheses: described(z.array(z.object({
    id: described(z.string(), "Hypothesis identifier."),
    statement: described(z.string(), "Hypothesis statement."),
    confidence: described(z.number().min(0).max(1), "Hypothesis confidence."),
    evidenceIds: stringArray("Supporting evidence identifiers."),
    status: described(z.enum(["unverified", "supported", "rejected"]), "Hypothesis status."),
  }).strict()), "Task hypotheses."),
  createdAt: described(z.string(), "ISO creation timestamp."),
}).strict();

const ContextPackSchema = z.object({
  taskFrame: described(TaskFrameSchema, "Compiled task frame."),
  hardConstraints: described(z.array(ClaimSchema), "Hard constraint claims."),
  authoritativeClaims: described(z.array(ClaimSchema), "Authoritative task-relative claims."),
  primaryNodes: described(z.array(RepositoryNodeSchema), "Primary repository nodes."),
  secondaryNodes: described(z.array(RepositoryNodeSchema), "Secondary repository nodes."),
  impactPaths: described(z.array(z.object({
    nodeIds: stringArray("Nodes in the path."),
    edgeKinds: stringArray("Repository edge kinds in the path."),
    description: described(z.string(), "Path explanation."),
  }).strict()), "Structural impact paths."),
  relevantTests: described(z.array(RepositoryNodeSchema), "Relevant test nodes."),
  contradictions: described(z.array(ClaimSchema), "Contradictory claims."),
  unknowns: stringArray("Unresolved context unknowns."),
  recommendedReads: described(z.array(z.object({
    path: described(z.string(), "Repository-relative path."),
    reason: described(z.string(), "Why the file should be read."),
    priority: described(z.enum(["critical", "high", "medium"]), "Read priority."),
    evidenceIds: stringArray("Evidence supporting the recommendation."),
  }).strict()), "Justified reads."),
  verificationPlan: described(z.object({
    steps: described(z.array(z.object({
      description: described(z.string(), "Verification step."),
      kind: described(z.enum(["run_test", "static_check", "manual_review", "reproduce"]), "Verification step kind."),
      command: described(z.string().optional(), "Optional command."),
      targetNodeIds: stringArray("Target repository nodes."),
      evidenceIds: stringArray("Evidence identifiers."),
    }).strict()), "Ordered verification steps."),
    requiredTests: stringArray("Required tests."),
    notes: stringArray("Verification notes."),
  }).strict(), "Verification plan."),
  generatedAt: described(z.string(), "ISO generation timestamp."),
  evidence: described(z.array(EvidenceRefSchema.extend({
    id: described(z.string(), "Stable evidence identifier."),
  }).strict()), "Evidence referenced by the pack."),
  priorityExplanations: described(z.array(z.object({
    targetId: described(z.string(), "Ranked target identifier."),
    targetKind: described(z.enum(["node", "claim"]), "Ranked target kind."),
    score: described(z.number(), "Composite priority score."),
    eligible: described(z.boolean(), "Whether the target passed gates."),
    roleMatch: described(z.number(), "Task-role match score."),
    authority: described(z.number(), "Authority score."),
    graphReachability: described(z.number(), "Graph reachability score."),
    verificationStrength: described(z.number(), "Verification strength score."),
    freshness: described(z.number(), "Freshness score."),
    contradictionPenalty: described(z.number(), "Contradiction penalty."),
    gates: described(z.array(z.object({
      name: described(z.string(), "Gate name."),
      passed: described(z.boolean(), "Gate result."),
      reason: described(z.string(), "Gate rationale."),
    }).strict()), "Eligibility gates."),
    explanation: stringArray("Ranking rationale."),
  }).strict()), "Inspectable ranking rationale."),
  meta: described(z.object({
    taskId: described(z.string(), "Task-frame identifier."),
    questionKind: described(z.enum(["public_api", "persistence", "business_rule", "runtime_behavior", "historical_reason", "style", "security"]), "Question kind."),
    deterministic: described(z.boolean(), "Whether generation is deterministic."),
    generator: described(z.string(), "Generator identity."),
    candidateProviders: stringArray("Candidate provider identities."),
    warnings: stringArray("Context-pack warnings."),
  }).strict(), "Context-pack metadata."),
}).strict();

const PrepareTaskResultSchema = z.object({
  taskFrame: described(TaskFrameSchema, "Extracted task frame."),
  contextPack: described(ContextPackSchema, "Compiled context pack."),
}).strict();

const DiagnosticSchema = z.object({
  severity: described(z.enum(["error", "warning"]), "Diagnostic severity."),
  message: described(z.string(), "Diagnostic message."),
  file: described(z.string(), "Source file."),
  line: described(z.number().int().positive(), "One-based source line."),
  column: described(z.number().int().positive(), "One-based source column."),
  code: described(z.string().optional(), "Optional diagnostic code."),
}).passthrough();

const LinkResolutionSchema = mcpSchema(CanonicalLinkResolutionSchema);

const SemanticCheckSchema = z.object({
  schemaVersion: described(z.literal(1), "Semantic-check schema version."),
  kind: described(z.literal("semantic_check"), "Report kind."),
  ok: described(z.boolean(), "Whether semantic state is valid."),
  reasonCodes: stringArray("Canonical semantic-check reason codes."),
  diagnostics: described(z.array(DiagnosticSchema), "DSL diagnostics."),
  duplicateIds: stringArray("Duplicate semantic identifiers."),
  invalidIds: described(z.array(z.object({
    id: described(z.string(), "Invalid semantic identifier."),
    kind: described(z.string(), "Semantic entity kind."),
  }).strict()), "Invalid identifiers."),
  danglingReferences: described(z.array(z.object({
    ownerId: described(z.string(), "Owner identifier."),
    field: described(z.string(), "Referencing field."),
    ref: described(z.string(), "Missing target identifier."),
  }).passthrough()), "Dangling semantic references."),
  staleLinks: described(z.array(LinkResolutionSchema), "Stale repository links."),
  lifecycleFindings: described(z.array(z.object({
    code: described(z.string(), "Lifecycle reason code."),
    severity: described(z.enum(["error", "warning"]), "Lifecycle severity."),
    message: described(z.string(), "Lifecycle finding message."),
    subjectIds: stringArray("Affected semantic identifiers."),
  }).strict()), "Lifecycle findings."),
  anchorFindings: described(z.array(z.object({
    code: described(z.enum(["DURABLE_ANCHOR_IS_TRANSIENT", "DEPRECATED_SYMBOL_ANCHOR"]), "Anchor doctrine finding code."),
    severity: described(z.literal("warning"), "Anchor doctrine findings are always advisory."),
    ownerId: described(z.string(), "Semantic owner identifier."),
    ownerKind: described(z.string(), "Owner semantic kind, or 'link' for a deprecated-anchor finding."),
    ref: described(z.string(), "Repository link reference the finding is about."),
    message: described(z.string(), "Human-readable finding message."),
  }).strict()), "Anchor doctrine findings: durable intent anchored transiently, or a deprecated line-bearing anchor."),
  graphIndexed: described(z.boolean(), "Whether a repository graph was available."),
  counts: described(z.object({
    nodes: described(z.number().int().nonnegative(), "Semantic node count."),
    changes: described(z.number().int().nonnegative(), "Change-contract count."),
    errors: described(z.number().int().nonnegative(), "Error count."),
    warnings: described(z.number().int().nonnegative(), "Warning count."),
  }).strict(), "Report counts."),
}).strict();

const SemanticNode = mcpSchema(SemanticNodeSchema);
const SemanticChange = mcpSchema(SemanticChangeContractSchema);
const SemanticSliceSchema = z.object({
  slice: described(z.object({
    scope: described(z.object({
      changeId: described(z.string().optional(), "Optional change seed."),
      symbolRef: described(z.string().optional(), "Optional symbol seed."),
      claimRef: described(z.string().optional(), "Optional claim seed."),
      maxNodes: described(z.number().int().positive(), "Applied node cap."),
    }).strict(), "Explicit slice scope."),
    truncated: described(z.boolean(), "Whether the node cap truncated traversal."),
    intentions: described(z.array(SemanticNode), "Selected goal nodes."),
    invariants: described(z.array(SemanticNode), "Selected invariant nodes."),
    decisions: described(z.array(SemanticNode), "Selected decision nodes."),
    assumptions: described(z.array(SemanticNode), "Selected assumption nodes."),
    changes: described(z.array(SemanticChange), "Selected change contracts."),
    linkedRepository: described(z.array(mcpSchema(RepositoryLinkSchema)), "Selected repository links."),
    evidence: described(z.array(SemanticNode), "Selected evidence nodes."),
    openUnknowns: described(z.array(SemanticNode), "Selected unknown nodes."),
    safetyConstraints: described(z.array(SemanticNode), "Critical selected invariants."),
    nextProofs: stringArray("Outstanding required evidence identifiers."),
  }).strict(), "Bounded semantic slice."),
  capsule: described(z.string(), "Rendered deterministic slice capsule."),
}).strict();

const ChangeVerifySchema = z.object({
  schemaVersion: described(z.literal(1), "Change-verification schema version."),
  changeId: described(z.string(), "Verified change identifier."),
  lifecycle: described(z.string(), "Current change lifecycle."),
  verdict: described(z.enum(["VERIFIED", "PARTIAL", "BLOCKED", "STALE"]), "Composed semantic verdict."),
  underlying: described(VerifyReportSchema, "Underlying Plane-A verify report."),
  preserved: described(z.array(z.object({
    id: described(z.string(), "Invariant identifier."),
    statement: described(z.string(), "Invariant statement."),
    critical: described(z.boolean(), "Whether the invariant is critical."),
    state: described(z.enum(["proved", "unproven", "untouched", "contradicted", "missing"]), "Preservation state."),
    footprint: stringArray("Repository-coordinate footprint."),
  }).strict()), "Preserved invariant evaluations."),
  provedEvidence: described(z.array(z.object({
    id: described(z.string(), "Evidence identifier."),
    statement: described(z.string(), "Evidence statement."),
    proved: described(z.boolean(), "Whether evidence is proven."),
    status: described(z.string(), "Evidence status."),
  }).strict()), "Proven evidence."),
  pendingEvidence: described(z.array(z.object({
    id: described(z.string(), "Evidence identifier."),
    statement: described(z.string(), "Evidence statement."),
    proved: described(z.boolean(), "Whether evidence is proven."),
    status: described(z.string(), "Evidence status or missing."),
  }).strict()), "Pending evidence."),
  openUnknowns: described(z.array(z.object({
    id: described(z.string(), "Unknown identifier."),
    statement: described(z.string(), "Unknown statement."),
    critical: described(z.boolean(), "Whether the unknown is critical."),
    present: described(z.boolean(), "Whether it exists in the model."),
  }).strict()), "Open unknowns."),
  stale: described(z.array(z.object({
    kind: described(z.string(), "Finding kind."),
    severity: described(z.enum(["warn", "block", "stale"]), "Finding severity."),
    message: described(z.string(), "Finding message."),
    refs: stringArray("Related identifiers."),
  }).strict()), "Staleness findings."),
  findings: described(z.array(z.object({
    kind: described(z.string(), "Finding kind."),
    severity: described(z.enum(["warn", "block", "stale"]), "Finding severity."),
    message: described(z.string(), "Finding message."),
    refs: stringArray("Related identifiers."),
  }).strict()), "All semantic findings."),
}).strict();

const SemanticInspectionSchema = z.object({
  id: described(z.string(), "Inspected semantic identifier."),
  found: described(z.boolean(), "Whether the entity exists."),
  node: described(SemanticNode.optional(), "Semantic node, when found."),
  change: described(SemanticChange.optional(), "Change contract, when found."),
  incoming: described(z.array(z.object({
    from: described(z.string(), "Referencing semantic identifier."),
    field: described(z.string(), "Referencing relation or field."),
  }).strict()), "Incoming semantic references."),
  linkResolutions: described(z.array(LinkResolutionSchema), "Repository-link resolutions."),
}).strict();

const HandoffSchema = z.object({
  version: described(z.literal(1), "Handoff-capsule schema version."),
  createdAt: described(z.string(), "ISO capture timestamp."),
  activeChangeId: described(z.string().optional(), "Optional active change identifier."),
  changeLifecycle: described(z.string().optional(), "Optional active change lifecycle."),
  statement: described(z.string().optional(), "Optional active change statement."),
  touchedInvariants: stringArray("Invariants to preserve."),
  proofsObtained: stringArray("Evidence already proven."),
  pendingProofs: stringArray("Evidence still pending."),
  activeAssumptions: stringArray("Active assumption identifiers."),
  exploredLinks: stringArray("Repository links already explored."),
  openUnknowns: stringArray("Open unknown identifiers."),
  nextValidations: stringArray("Next required validations."),
  note: described(z.string().optional(), "Optional handoff note."),
}).strict();

const ResumeSchema = z.union([
  HandoffSchema,
  z.object({
    message: described(z.string(), "Why no resumable semantic state exists."),
  }).strict(),
]);

const envelope = <K extends string>(kind: K, payload: z.ZodType): z.ZodType =>
  z.object({
    schemaVersion: described(z.literal(1), "Control-query envelope schema version."),
    kind: described(z.literal(kind), "Control-query kind."),
    freshness: described(z.object({
      verdict: described(
        z.enum(["FRESH", "DIRTY_KNOWN", "STALE", "UNSEALED"]),
        "Control freshness verdict.",
      ),
      reasons: described(z.array(mcpSchema(ControlFreshnessReasonSchema)), "Freshness reason codes."),
      seal: described(mcpSchema(ControlFreshnessSealV2Schema).nullable(), "Bound control freshness seal."),
    }).strict(), "Freshness preflight."),
    terminalStatus: described(mcpSchema(ControlTerminalStatusV1Schema), "Query terminal status."),
    reasonCodes: described(z.array(mcpSchema(ControlReasonCodeV1Schema)), "Canonical reason codes."),
    payload: described(payload.nullable(), "Typed query payload, or null on refusal/empty result."),
  }).strict();

const ControlGraphEnvelope = envelope("coordinate_graph", mcpSchema(CoordinateGraphReportV2Schema));
const ControlTraversalEnvelope = envelope("traversal", mcpSchema(TraversalReportV2Schema));
const ControlCoverageEnvelope = envelope("refinement_coverage", mcpSchema(RefinementCoverageReportV1Schema));
const ControlImpactEnvelope = envelope("impact", mcpSchema(ImpactReportSchema));
const ControlExplanationEnvelope = envelope("explanation", mcpSchema(ExplanationReportSchema));
const ControlArchitectureEnvelope = envelope("architecture_comparison", mcpSchema(ArchitectureComparisonReportSchema));
const TransitionEnvelope = envelope("authorize_transition", mcpSchema(TransitionAuthorizationReportV2Schema));
const StepEnvelope = envelope("authorize_step", mcpSchema(StepAuthorizationReportV2Schema));
const DeletionEnvelope = envelope("authorize_deletion", mcpSchema(DeletionAuthorizationReportV2Schema));

const TargetProposalSchema = z.object({
  schemaVersion: described(z.literal(1), "Target-proposal result schema version."),
  kind: described(z.literal("target_architecture_proposal"), "Result kind."),
  certifying: described(z.literal(false), "Proposal is non-certifying."),
  executionAuthority: described(z.literal("none"), "Proposal grants no execution authority."),
  relativePath: described(z.string(), "Repository-relative immutable artifact path."),
  artifact: described(mcpSchema(TargetArchitectureArtifactV1Schema), "Persisted target architecture artifact."),
}).strict();

const PreparedTaskEnvelopeSchema = z.object({
  schemaVersion: described(z.literal(1), "Prepared-task envelope schema version."),
  kind: described(z.literal("prepared_task_envelope"), "Prepared-task result kind."),
  certifying: described(z.literal(false), "The prepared task is diagnostic, not certifying."),
  envelope: described(
    mcpSchema(TaskEnvelopeV1Schema),
    "Canonical task envelope bound to the requested repository scope.",
  ),
  baseline: described(
    mcpSchema(WorkspaceBaselineSnapshotV1Schema),
    "Workspace baseline captured while preparing the task.",
  ),
}).strict();

const PlaneAReasonCodeSchema = z.enum([
  "AMBIGUOUS_LAYOUT",
  "AMBIGUOUS_SCOPE",
  "DISCOVERY_NOT_ESTABLISHED",
  "ANALYSIS_DISABLED",
  "LANGUAGE_UNSUPPORTED",
  "PRODUCER_FAILED",
  "BINDING_UNSEALED",
  "BINDING_INVALID",
  "CURRENT_STATE_UNSEALED",
  "CURRENT_STATE_STALE",
  "SCOPE_MISMATCH",
  "CAPABILITY_MISSING",
  "PRODUCER_VERSION_MISMATCH",
  "CONFIG_DIGEST_MISMATCH",
  "SCHEMA_DIGEST_MISMATCH",
  "EVIDENCE_CONTRACT_MISMATCH",
  "NEGATIVE_COMPLETENESS_MISSING",
  "POLICY_DENIED",
]).describe("Canonical Plane A health reason code.");

const IndexHealthProducerSchema = z.object({
  identity: described(z.string(), "Analyzer producer identity."),
  version: described(z.string(), "Analyzer producer version."),
}).strict();

const WorkspaceManifestEvidenceSchema = z.object({
  manifestPath: described(z.string(), "Repository-relative manifest path."),
  field: described(z.string(), "Manifest field that establishes the workspace relation."),
  value: described(
    z.union([z.string(), z.array(z.string())]),
    "Manifest value supporting the workspace relation.",
  ),
}).strict();

const WorkspaceProjectionSchema = z.object({
  schemaVersion: described(z.literal(1), "Workspace projection schema version."),
  repositoryId: described(z.string(), "Repository identity used by the workspace projection."),
  nodes: described(z.array(z.object({
    id: described(z.string(), "Workspace node identifier."),
    kind: described(z.literal("package"), "Workspace node kind."),
    root: described(z.string(), "Repository-relative package root."),
    identity: described(z.string(), "Package identity."),
    evidence: described(z.array(WorkspaceManifestEvidenceSchema), "Evidence for this workspace node."),
  }).strict()), "Discovered workspace package nodes."),
  edges: described(z.array(z.object({
    id: described(z.string(), "Workspace edge identifier."),
    kind: described(
      z.enum(["contained_in_workspace", "workspace_member_of"]),
      "Workspace containment relation.",
    ),
    from: described(z.string(), "Source workspace node identifier."),
    to: described(z.string(), "Target workspace node identifier."),
    evidence: described(z.array(WorkspaceManifestEvidenceSchema), "Evidence for this workspace edge."),
  }).strict()), "Discovered workspace relations."),
  candidates: described(z.array(z.object({
    root: described(z.string(), "Repository-relative candidate root."),
    reason: described(z.literal("conventional-directory"), "Why the root is a workspace candidate."),
  }).strict()), "Conventional workspace roots that were considered."),
  diagnostics: described(z.array(z.object({
    code: described(z.literal("AMBIGUOUS_LAYOUT"), "Workspace diagnostic code."),
    message: described(z.string(), "Human-readable workspace diagnostic."),
    roots: described(z.array(z.string()), "Repository-relative roots implicated by the diagnostic."),
    evidence: described(z.array(WorkspaceManifestEvidenceSchema), "Evidence for the diagnostic."),
  }).strict()), "Workspace layout diagnostics."),
}).strict();

const IndexHealthReportSchema = z.object({
  schemaVersion: described(z.literal(1), "Index-health report schema version."),
  kind: described(z.literal("index_health"), "Index-health report kind."),
  capturedAt: described(
    z.string().nullable(),
    "Timestamp of the persisted Plane A snapshot, or null when no snapshot is available.",
  ),
  binding: described(z.object({
    status: described(
      z.enum(["valid", "invalid", "absent"]),
      "Integrity status of the persisted Plane A binding.",
    ),
    sidecarDigest: described(z.string().nullable(), "Bound sidecar digest, when available."),
    workspaceDigest: described(z.string().nullable(), "Bound workspace digest, when available."),
  }).strict(), "Exact integrity binding between the shared index, sidecar, and workspace projection."),
  freshness: described(z.object({
    verdict: described(
      z.enum(["FRESH", "DIRTY_KNOWN", "STALE", "UNSEALED"]),
      "Current control-index freshness verdict; independent from coverage.",
    ),
    canRunHighRiskControl: described(
      z.boolean(),
      "Whether the current freshness state admits high-risk control operations.",
    ),
    reasons: described(
      z.array(mcpSchema(ControlFreshnessReasonSchema)),
      "Canonical reasons supporting the freshness verdict.",
    ),
  }).strict(), "Current repository freshness, reported separately from analysis coverage."),
  coverage: described(z.object({
    status: described(
      z.enum(["complete", "partial", "insufficient"]),
      "Aggregate Plane A analysis coverage.",
    ),
    candidates: described(z.number().int().nonnegative(), "Number of discovered candidates."),
    selected: described(z.number().int().nonnegative(), "Number of selected candidates."),
    excluded: described(z.number().int().nonnegative(), "Number of excluded candidates."),
    analyzed: described(z.number().int().nonnegative(), "Number of successfully analyzed candidates."),
    disabled: described(z.number().int().nonnegative(), "Number of candidates disabled by configuration."),
    unsupported: described(z.number().int().nonnegative(), "Number of unsupported candidates."),
    failed: described(z.number().int().nonnegative(), "Number of failed candidate analyses."),
  }).strict(), "Candidate coverage counts; this does not imply freshness or authority."),
  candidates: described(z.array(z.object({
    candidateIdentity: described(z.string(), "Stable candidate identity."),
    path: described(z.string(), "Repository-relative candidate path."),
    language: described(z.string(), "Candidate language."),
    workspaceUnitId: described(z.string().nullable(), "Owning workspace unit, when resolved."),
    selectionDecision: described(z.enum(["selected", "excluded"]), "Discovery selection decision."),
    analysisOutcome: described(
      z.enum(["not_applicable", "disabled", "unsupported", "failed", "analyzed"]),
      "Terminal analysis outcome.",
    ),
    selectionReasons: described(z.array(z.string()), "Reasons for selection or exclusion."),
    analysisReasons: described(z.array(z.string()), "Analyzer outcome details."),
    producer: described(IndexHealthProducerSchema.nullable(), "Selected analyzer producer, when any."),
    negativeEvidenceEligible: described(
      z.boolean(),
      "Whether this candidate can support task-relative negative evidence.",
    ),
  }).strict()), "Deterministically ordered candidate health records."),
  capabilities: described(z.array(z.object({
    profileId: described(z.string(), "Capability profile identifier."),
    factKind: described(z.string(), "Fact kind emitted by the capability."),
    language: described(z.string(), "Language covered by the capability."),
    producer: described(IndexHealthProducerSchema, "Analyzer producer for the capability."),
    completenessClaim: described(z.string(), "Declared completeness claim."),
    negativeEvidenceEligible: described(
      z.boolean(),
      "Whether the capability may support negative evidence.",
    ),
    label: described(z.string().nullable(), "Optional human-readable capability label."),
  }).strict()), "Capability profiles bound to the persisted Plane A snapshot."),
  workspace: described(
    WorkspaceProjectionSchema.nullable(),
    "Persisted workspace projection, or null when no valid binding is available.",
  ),
  evaluations: described(z.object({
    schemaVersion: described(z.literal(1), "Plane A evaluation report schema version."),
    decisions: described(
      z.array(z.looseObject({
        decisionKind: described(
          z.enum(["pre_subject", "exact_subject"]),
          "Whether evaluation stopped before an exact subject or evaluated one.",
        ),
        outcome: described(
          z.enum(["PASS", "UNKNOWN", "INSUFFICIENT_ANALYSIS", "POLICY_DENIED"]),
          "Task-relative Plane A decision.",
        ),
        admissible: described(z.boolean(), "Whether the evaluated evidence is admissible."),
        reasons: described(z.array(z.looseObject({
          code: PlaneAReasonCodeSchema,
          details: described(z.array(z.looseObject({
            coordinate: described(z.string(), "Coordinate associated with the reason."),
            expected: described(z.unknown(), "Canonical expected value."),
            actual: described(z.unknown(), "Canonical observed value."),
          })), "Canonical reason details."),
        })), "Canonical decision reasons."),
        primaryReason: described(PlaneAReasonCodeSchema.optional(), "Primary decision reason, when any."),
      })),
      "Task-relative Plane A evaluation decisions.",
    ),
    reasonSummary: described(z.array(PlaneAReasonCodeSchema), "Canonical evaluation reason summary."),
    primaryReason: described(PlaneAReasonCodeSchema.optional(), "Primary report reason, when any."),
  }).strict(), "Task-relative admissibility evaluations; health alone grants no authority."),
  reasonSummary: described(
    z.array(PlaneAReasonCodeSchema),
    "Canonical aggregate health reasons in deterministic order.",
  ),
}).strict();

/**
 * Precise machine-readable result contracts for every public semctx MCP tool.
 * Business-layer Zod 3 contracts cross the MCP v2 boundary only through mcpSchema.
 */
const ChangeAuthorizationVerificationIntegrityReportSchema = z.object({
  schemaVersion: described(z.literal(1), "Integrity section schema version."),
  result: described(z.enum(CHANGE_AUTHORIZATION_VERIFICATION_INTEGRITY_RESULTS), "Structural and historical-rederivation verdict."),
  reasons: described(z.array(z.enum(CHANGE_AUTHORIZATION_VERIFICATION_INTEGRITY_REASONS)), "Closed integrity reason codes."),
}).strict();

const ChangeAuthorizationVerificationAuthorityReportSchema = z.object({
  schemaVersion: described(z.literal(1), "Authority section schema version."),
  expectedAuthorityDescriptorDigest: described(
    mcpSchema(Sha256HashSchema).nullable(),
    "Authority digest sourced outside the capsule, or null when the caller holds no pin.",
  ),
  recordedAuthorityDescriptorDigest: described(
    mcpSchema(Sha256HashSchema).nullable(),
    "The capsule's own authority digest, or null when the capsule is structurally invalid.",
  ),
  result: described(z.enum(CHANGE_AUTHORIZATION_VERIFICATION_AUTHORITY_RESULTS), "External authority pin comparison verdict."),
  reasons: described(z.array(z.enum(CHANGE_AUTHORIZATION_VERIFICATION_AUTHORITY_REASONS)), "Closed authority reason codes."),
}).strict();

const ChangeAuthorizationVerificationSemanticReportSchema = z.object({
  schemaVersion: described(z.literal(1), "Semantic section schema version."),
  recordedVerdict: described(mcpSchema(ChangeAuthorizationVerdictV1Schema).nullable(), "Verdict the capsule itself recorded."),
  recordedEvaluatedAt: described(z.string().nullable(), "Timestamp the capsule itself recorded."),
  recordedReasonCodes: described(z.array(mcpSchema(ChangeAuthorizationReasonCodeV1Schema)), "Reason codes the capsule itself recorded."),
  currentVerdict: described(
    mcpSchema(ChangeAuthorizationVerdictV1Schema).nullable(),
    "Verdict re-derived from the capsule's own evidence at the caller's verifiedAt.",
  ),
  currentEvaluatedAt: described(z.string(), "The caller's verifiedAt."),
  currentReasonCodes: described(z.array(mcpSchema(ChangeAuthorizationReasonCodeV1Schema)), "Reason codes re-derived at verifiedAt."),
  reasons: described(z.array(z.enum(CHANGE_AUTHORIZATION_VERIFICATION_SEMANTIC_REASONS)), "Closed semantic reason codes."),
}).strict();

const ChangeAuthorizationVerificationReportSchema = z.object({
  schemaVersion: described(z.literal(1), "Verification report schema version."),
  kind: described(z.literal("change_authorization_verification_report"), "Report kind."),
  verifierId: described(z.literal("semctx-change-authorization-verifier"), "Verifier identity."),
  verifierVersion: described(z.literal("1.0.0"), "Verifier version."),
  executionAuthority: described(z.literal("none"), "This report grants no execution authority."),
  enforcementMode: described(z.literal("shadow"), "Always shadow."),
  blockingEnabled: described(z.literal(false), "Never blocking."),
  authorizationEffect: described(z.literal("advisory_verification"), "Advisory only."),
  result: described(z.enum(CHANGE_AUTHORIZATION_VERIFICATION_RESULTS), "Overall verification verdict."),
  reasonCodes: described(z.array(z.enum(CHANGE_AUTHORIZATION_VERIFICATION_REASON_CODES)).min(1), "Union of contributing reason codes."),
  integrity: described(ChangeAuthorizationVerificationIntegrityReportSchema, "Content integrity and historical rederivation."),
  authority: described(ChangeAuthorizationVerificationAuthorityReportSchema, "External authority pin comparison."),
  semantic: described(ChangeAuthorizationVerificationSemanticReportSchema, "Current semantic decision, re-derived at verifiedAt."),
  subjectChangeId: described(z.string().nullable(), "Change id under authorization, or null if structurally invalid."),
  subjectHash: described(mcpSchema(Sha256HashSchema).nullable(), "Subject hash, or null if structurally invalid."),
  capsuleHash: described(mcpSchema(Sha256HashSchema).nullable(), "Capsule hash, or null if structurally invalid."),
  verifiedAt: described(z.string(), "The caller's verifiedAt."),
  reportHash: described(mcpSchema(Sha256HashSchema), "Canonical JCS hash of this report."),
}).strict().superRefine((report, context) => {
  const parsed = ChangeAuthorizationVerificationReportV1Schema.safeParse(report);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    context.addIssue({
      code: "custom",
      path: [],
      message: issue.message,
      input: report,
    });
  }
});

export const TOOL_OUTPUT_SCHEMAS = {
  semctx_verify_change: VerifyReportSchema,
  semctx_inspect: InspectionResultSchema,
  semctx_prepare_task: PrepareTaskResultSchema,
  semctx_semantic_check: SemanticCheckSchema,
  semctx_semantic_slice: SemanticSliceSchema,
  semctx_change_open: mcpSchema(SemanticChangeContractSchema),
  semctx_change_update: mcpSchema(SemanticChangeContractSchema),
  semctx_change_verify: ChangeVerifySchema,
  semctx_change_close: mcpSchema(SemanticChangeContractSchema),
  semctx_semantic_inspect: SemanticInspectionSchema,
  semctx_handoff: HandoffSchema,
  semctx_resume: ResumeSchema,
  semctx_index_health: IndexHealthReportSchema,
  semctx_setup: z.union([
    z.object({
      schemaVersion: described(z.literal(1), "Setup preflight schema version."),
      kind: described(z.literal("setup_preflight"), "Dry preflight when confirm is not true."),
      repositoryRoot: described(z.string(), "Absolute repository root."),
      initialized: described(z.boolean(), "Whether .semctx/ already exists."),
      confirmRequired: described(z.literal(true), "Caller must re-invoke with confirm:true to write."),
      requiresUserAuthorization: described(
        z.literal(true),
        "Human authorization is required before writes; next.arguments never embeds confirm:true.",
      ),
      message: described(z.string(), "Human-readable next step (not an auto-follow write payload)."),
      next: described(z.object({
        tool: described(z.literal("semctx_setup"), "Tool to call after user authorisation."),
        arguments: described(z.object({
          repositoryRoot: described(z.string(), "Absolute repository root."),
          polyglot: described(z.boolean().optional(), "Optional polyglot config for a fresh workspace."),
        }).strict(), "Argument template without confirm — host must set confirm:true only after user yes."),
      }).strict(), "Suggested next MCP call template (no auto-confirm)."),
    }).strict(),
    z.object({
      schemaVersion: described(z.literal(1), "Setup refused schema version."),
      kind: described(
        z.literal("setup_refused"),
        "Policy refusal before mutation (e.g. polyglot against existing v1 config). Treat as failure.",
      ),
      repositoryRoot: described(z.string(), "Absolute repository root."),
      reasonCode: described(
        z.literal(SETUP_POLYGLOT_V1_REFUSE_REASON_CODE),
        "Domain policy refuse code (not an MCP catalogue error code).",
      ),
      reason: described(z.string(), "Actionable refusal reason."),
      configVersion: described(z.number().int(), "Existing config version that blocked the request."),
      polyglot: described(z.boolean(), "Whether polyglot was requested."),
      alreadyInitialized: described(z.literal(true), "Workspace was already initialized."),
      setupReady: described(z.literal(false), "Never ready on refusal."),
      analysisReady: described(z.literal(false), "Never analysis-ready on refusal."),
      verdict: described(
        z.literal("SETUP_REFUSED"),
        "Namespaced failure signal (not Plane C READY/BLOCKED).",
      ),
      nextSteps: described(z.array(z.string()), "Safe migration / next-action guidance."),
    }).strict(),
    z.object({
      schemaVersion: described(z.literal(1), "Setup report schema version."),
      kind: described(z.literal("setup"), "Full setup report after confirm:true."),
      repositoryRoot: described(z.string(), "Absolute repository root."),
      configWritten: described(z.boolean(), "Whether a fresh config was written."),
      semctxDir: described(
        z.string(),
        "Absolute path to the .semctx/ workspace directory (not config.json).",
      ),
      alreadyInitialized: described(z.boolean(), "Whether the workspace was already initialized."),
      polyglot: described(z.boolean(), "Whether polyglot selection was requested."),
      sourceFiles: described(z.number().int().nonnegative(), "TypeScript source file count (legacy metric)."),
      selectedFiles: described(z.number().int().nonnegative(), "Files selected for analysis."),
      selection: described(z.object({
        configVersion: described(z.number().int(), "Config schema version."),
        mode: described(z.string(), "Selection mode label."),
        selectedByLanguage: described(z.record(z.string(), z.number()), "Selected file counts by language."),
        excluded: described(z.number().int().nonnegative(), "Excluded candidates."),
        disabled: described(z.number().int().nonnegative(), "Disabled candidates."),
        unsupported: described(z.number().int().nonnegative(), "Unsupported candidates."),
        failed: described(z.number().int().nonnegative(), "Failed candidates."),
      }).strict(), "Discovery selection summary."),
      nodes: described(z.number().int().nonnegative(), "Graph node count."),
      edges: described(z.number().int().nonnegative(), "Graph edge count."),
      claims: described(z.number().int().nonnegative(), "Claim count."),
      freshnessSeal: described(z.unknown(), "Control freshness seal payload."),
      indexHealth: described(z.object({
        binding: described(
          z.object({
            status: described(
              z.enum(["valid", "invalid", "absent"]),
              "Index binding status.",
            ),
          }).passthrough(),
          "Index binding projection.",
        ),
        freshness: described(
          z.object({
            canRunHighRiskControl: described(
              z.boolean(),
              "Whether high-risk control is admitted by freshness.",
            ),
          }).passthrough(),
          "Freshness projection.",
        ),
        coverage: described(
          z.object({
            status: described(
              z.enum(["complete", "partial", "insufficient"]),
              "Analysis coverage status.",
            ),
          }).passthrough(),
          "Coverage projection.",
        ),
        workspaceDiagnostics: described(z.array(z.unknown()), "Workspace diagnostics."),
        reasonSummary: described(z.array(z.unknown()), "Canonical health reasons."),
      }).strict(), "Index health projection (subset required for agent gate consistency)."),
      semanticFilesCreated: described(z.number().int().nonnegative(), "Scaffolded semantic files count."),
      gitignore: described(
        z.enum(["create", "update", "present"]),
        "Gitignore scaffold action.",
      ),
      check: described(z.object({
        ok: described(z.boolean(), "Whether the semantic model check passed."),
        nodes: described(z.number().int().nonnegative(), "Semantic node count."),
        changes: described(z.number().int().nonnegative(), "Change contract count."),
        errors: described(z.number().int().nonnegative(), "Semantic check error count."),
      }).strict(), "Semantic model check summary."),
      setupReady: described(z.boolean(), "Whether setup completed in a ready state."),
      analysisReady: described(z.boolean(), "Whether Plane A analysis is ready for high-risk control."),
      verdict: described(
        z.enum(["SETUP_READY", "SETUP_NOT_READY"]),
        "Namespaced readiness (not Plane C). SETUP_NOT_READY is a domain failure in the body (isError stays false; agents must read verdict).",
      ),
    }).strict().superRefine((report, ctx) => {
      // Agent success gate must match domain analysisReady / setupReady invariants.
      const ready = report.verdict === "SETUP_READY";
      const derivedSetupReady = report.check.ok && report.analysisReady;
      if (report.setupReady !== derivedSetupReady) {
        ctx.addIssue({
          code: "custom",
          message: "setupReady must equal (check.ok && analysisReady)",
          path: ["setupReady"],
        });
      }
      if (report.setupReady !== ready) {
        ctx.addIssue({
          code: "custom",
          message: "setupReady must equal (verdict === SETUP_READY)",
          path: ["setupReady"],
        });
      }
      if (ready) {
        if (report.analysisReady !== true) {
          ctx.addIssue({
            code: "custom",
            message: "SETUP_READY requires analysisReady true",
            path: ["analysisReady"],
          });
        }
        if (report.check.ok !== true) {
          ctx.addIssue({
            code: "custom",
            message: "SETUP_READY requires check.ok true",
            path: ["check", "ok"],
          });
        }
        if (report.indexHealth.binding.status !== "valid") {
          ctx.addIssue({
            code: "custom",
            message: "SETUP_READY requires indexHealth.binding.status valid",
            path: ["indexHealth", "binding", "status"],
          });
        }
        if (report.indexHealth.freshness.canRunHighRiskControl !== true) {
          ctx.addIssue({
            code: "custom",
            message: "SETUP_READY requires freshness.canRunHighRiskControl true",
            path: ["indexHealth", "freshness", "canRunHighRiskControl"],
          });
        }
        if (report.indexHealth.coverage.status === "insufficient") {
          ctx.addIssue({
            code: "custom",
            message: "SETUP_READY forbids indexHealth.coverage.status === insufficient",
            path: ["indexHealth", "coverage", "status"],
          });
        }
      }
    }),
  ]),
  semctx_cli_compatibility: z.object({
    schemaVersion: described(z.literal(1), "CLI compatibility schema version."),
    kind: described(z.literal("cli_compatibility"), "CLI compatibility report kind."),
    found: described(z.boolean(), "Whether a global semctx executable was found."),
    version: described(z.string().nullable(), "Detected global CLI version, when valid."),
    requiredVersion: described(z.string(), "Version required by this plugin/MCP runtime."),
    compatible: described(z.boolean(), "Whether the global CLI exactly matches the required version."),
    reason: described(z.enum([
      "CLI_NOT_FOUND",
      "CLI_VERSION_COMPATIBLE",
      "CLI_VERSION_MISMATCH",
      "CLI_VERSION_MALFORMED",
      "CLI_PROBE_TIMEOUT",
      "CLI_PROBE_FAILED",
    ]), "Canonical compatibility reason."),
    upgradeCommand: described(z.string(), "Explicit manual command for installing the required CLI version."),
  }).strict(),
  semctx_control_status: mcpSchema(ControlFreshnessStatusReportSchema),
  semctx_control_agent_lifecycle: mcpSchema(AgentLifecycleReportV1Schema),
  semctx_control_authority: mcpSchema(AltitudeAuthorityReportV1Schema),
  semctx_control_trace: mcpSchema(TraversalReportV2Schema),
  semctx_control_graph: ControlGraphEnvelope,
  semctx_control_traversal: ControlTraversalEnvelope,
  semctx_control_refinement_coverage: ControlCoverageEnvelope,
  semctx_control_impact: ControlImpactEnvelope,
  semctx_control_explain_why: ControlExplanationEnvelope,
  semctx_control_compare_architecture: ControlArchitectureEnvelope,
  control_authorize_transition: TransitionEnvelope,
  control_authorize_step: StepEnvelope,
  control_authorize_deletion: DeletionEnvelope,
  semctx_control_plan: mcpSchema(MigrationPlanReportSchema),
  semctx_control_bind_scope: PreparedTaskEnvelopeSchema,
  semctx_control_frame_task: PreparedTaskEnvelopeSchema,
  semctx_control_plan_change: mcpSchema(PlanningBundleV1Schema),
  semctx_control_reconcile_diff: mcpSchema(ReconcileDiffReportV1Schema),
  semctx_control_handoff: mcpSchema(ControlHandoffCaptureResultV2Schema),
  semctx_control_resume: mcpSchema(ControlHandoffResumeResultV2Schema),
  semctx_control_target_propose: TargetProposalSchema,
  semctx_control_explorer: ControlExplorerOutputSchema,
  semctx_control_verify_authorization: ChangeAuthorizationVerificationReportSchema,
} satisfies Record<SemctxToolName, z.ZodType>;
