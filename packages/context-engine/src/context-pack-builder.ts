import { evidenceId, capabilityId, invariantId, compareIds } from "@semantic-context/core";
import type {
  Claim,
  TaskFrame,
  ContextPack,
  RepositoryNode,
  GraphPath,
  EvidenceRef,
  EvidenceRecord,
  RecommendedRead,
  ReadPriority,
  PriorityExplanation,
  VerificationPlan,
  VerificationStep,
  NodeKind,
  EdgeKind,
} from "@semantic-context/core";
import type { SemanticCandidate } from "@semantic-context/cocoindex-adapter";
import { GraphIndex } from "./graph-index";
import { classifyQuestion, policyFor } from "./authority-policies";
import { detectContradictions } from "./contradiction";
import { evaluateClaim, type PriorityContext } from "./priority-engine";

const GENERATOR = "semctx@0.1.0";

const CODE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(["function", "class", "interface", "type", "enum"]);
const REACHABILITY_EDGES: readonly EdgeKind[] = [
  "calls",
  "implements_capability",
  "constrained_by",
  "tested_by",
  "covers",
  "declares",
  "related_to",
  "documents",
  "decides",
  "references",
];

export interface BuildPackOptions {
  index: GraphIndex;
  claims: Claim[];
  taskFrame: TaskFrame;
  evidenceRecords: EvidenceRecord[];
  now: string;
  candidateProviders?: string[];
  /** Optional semantic-provider candidates. Folded into secondary consideration only —
   * they never become authoritative (ADR 0004) and never resurrect a deprecated source. */
  providerCandidates?: SemanticCandidate[];
}

function evIdOf(ref: EvidenceRef): string {
  return evidenceId(ref.sourceKind, ref.filePath, ref.startLine, ref.endLine);
}

function nodeEvidenceIds(node: RepositoryNode): string[] {
  return [...new Set(node.evidence.map(evIdOf))];
}

export function buildContextPack(opts: BuildPackOptions): ContextPack {
  const { index, claims, taskFrame, now } = opts;
  const question = classifyQuestion(taskFrame);
  const policy = policyFor(question);
  const warnings: string[] = [];

  // Optional semantic-provider candidates: folded into secondary consideration only.
  const candidateProviderNames = new Set<string>(opts.candidateProviders ?? []);
  const candidateNodeIds = new Set<string>();
  for (const candidate of opts.providerCandidates ?? []) {
    candidateProviderNames.add(candidate.provider);
    const matched = index.nodesByFilePath(candidate.filePath);
    if (matched.length === 0) {
      warnings.push(`Provider candidate ${candidate.filePath} is not in the analysed graph; ignored.`);
      continue;
    }
    for (const node of matched) {
      if (node.metadata["deprecated"] === true || node.tags.includes("deprecated")) continue;
      candidateNodeIds.add(node.id);
    }
  }

  // --- Entrypoints: symbols implementing matched capabilities / constrained by matched invariants.
  const matchedCapNodeIds = taskFrame.capabilities.map(capabilityId).filter((id) => index.has(id));
  const matchedInvNodeIds = taskFrame.hardInvariants.map(invariantId).filter((id) => index.has(id));
  const entrypoints = new Set<string>();
  for (const capId of matchedCapNodeIds) {
    for (const e of index.inEdges(capId, ["implements_capability"])) entrypoints.add(e.from);
  }
  for (const invId of matchedInvNodeIds) {
    for (const e of index.inEdges(invId, ["constrained_by"])) entrypoints.add(e.from);
  }
  if (entrypoints.size === 0) {
    // Fallback for un-annotated repos: seed entrypoints lexically by matching task
    // keywords to symbol/file names (weaker than markers, but keeps selection useful).
    for (const id of lexicalEntrypoints(index, taskFrame)) entrypoints.add(id);
    warnings.push(
      entrypoints.size > 0
        ? "No semantic markers matched; entrypoints seeded lexically from task keywords (weaker, name-based signal)."
        : "No task entrypoint could be resolved; reachability gate is inactive.",
    );
  }

  const reachable = index.distancesFrom([...entrypoints], REACHABILITY_EDGES, "both", 4);

  // --- Contradictions + per-claim priority evaluation.
  const { contradictions, contradictedClaimIds } = detectContradictions(claims);
  const ctx: PriorityContext = { index, taskFrame, policy, entrypoints, reachable, contradictedClaimIds };

  const claimById = new Map(claims.map((c) => [c.id, c]));
  const explanations: PriorityExplanation[] = claims.map((c) => evaluateClaim(c, ctx));
  const eligible = explanations
    .filter((e) => e.eligible)
    .sort((a, b) => b.score - a.score || compareIds(a.targetId, b.targetId));

  const eligibleClaims = eligible.map((e) => claimById.get(e.targetId)).filter((c): c is Claim => c !== undefined);
  const hardConstraints = eligibleClaims.filter((c) => c.kind === "invariant");
  const authoritativeClaims = eligibleClaims.filter((c) => c.kind !== "invariant").slice(0, 10);

  // --- Impact paths (call paths from entrypoints).
  const impactPaths = buildImpactPaths(index, entrypoints);
  const pathNodeIds = new Set<string>(impactPaths.flatMap((p) => p.nodeIds));

  // --- Node selection.
  const primaryIds = new Set<string>();
  for (const id of entrypoints) primaryIds.add(id);
  for (const id of pathNodeIds) if (isCode(index, id)) primaryIds.add(id);
  for (const claim of [...hardConstraints, ...authoritativeClaims]) {
    for (const id of claim.subjectNodeIds) if (isCode(index, id)) primaryIds.add(id);
  }
  for (const id of matchedInvNodeIds) primaryIds.add(id);
  const migrationIds = migrationsForInvariants(index, matchedInvNodeIds);
  for (const id of migrationIds) primaryIds.add(id);

  const primaryNodes = [...primaryIds]
    .map((id) => index.node(id))
    .filter((n): n is RepositoryNode => n !== undefined)
    .sort((a, b) => (reachable.get(a.id) ?? 99) - (reachable.get(b.id) ?? 99) || compareIds(a.id, b.id));

  const relevantTests = collectRelevantTests(index, primaryIds);
  const relevantTestIds = new Set(relevantTests.map((t) => t.id));

  const secondaryNodes = [...new Set([...reachable.keys(), ...candidateNodeIds])]
    .filter((id) => !primaryIds.has(id) && !relevantTestIds.has(id))
    .map((id) => index.node(id))
    .filter((n): n is RepositoryNode => n !== undefined)
    .filter((n) => !(n.kind === "document" && (n.metadata["deprecated"] === true || n.tags.includes("deprecated"))))
    .sort((a, b) => hopFor(a.id, reachable, candidateNodeIds) - hopFor(b.id, reachable, candidateNodeIds) || compareIds(a.id, b.id))
    .slice(0, 15);

  // --- Recommended reads (justified, provenance-backed).
  const recommendedReads = buildRecommendedReads(index, {
    entrypoints,
    hardConstraints,
    migrationIds,
    relevantTests,
    pathNodeIds,
    primaryIds,
    secondaryNodes,
    reachable,
  });

  // --- Unknowns.
  const unknowns = buildUnknowns(index, taskFrame, eligibleClaims);

  // --- Verification plan.
  const verificationPlan = buildVerificationPlan({
    relevantTests,
    hardConstraints,
    entrypoints,
    taskFrame,
  });

  // --- Evidence resolution: every id referenced anywhere in the pack.
  const referenced = new Set<string>();
  for (const c of [...hardConstraints, ...authoritativeClaims, ...contradictions]) for (const id of c.evidenceIds) referenced.add(id);
  for (const n of [...primaryNodes, ...secondaryNodes, ...relevantTests]) for (const id of nodeEvidenceIds(n)) referenced.add(id);
  for (const r of recommendedReads) for (const id of r.evidenceIds) referenced.add(id);
  const evidence = opts.evidenceRecords.filter((e) => referenced.has(e.id)).sort((a, b) => compareIds(a.id, b.id));

  const orderedExplanations = [
    ...eligible,
    ...explanations.filter((e) => !e.eligible).sort((a, b) => compareIds(a.targetId, b.targetId)),
  ];

  return {
    taskFrame,
    hardConstraints,
    authoritativeClaims,
    primaryNodes,
    secondaryNodes,
    impactPaths,
    relevantTests,
    contradictions,
    unknowns,
    recommendedReads,
    verificationPlan,
    generatedAt: now,
    evidence,
    priorityExplanations: orderedExplanations,
    meta: {
      taskId: taskFrame.id,
      questionKind: question,
      deterministic: true,
      generator: GENERATOR,
      candidateProviders: [...candidateProviderNames].sort(),
      warnings,
    },
  };
}

function isCode(index: GraphIndex, id: string): boolean {
  const node = index.node(id);
  return node !== undefined && CODE_KINDS.has(node.kind);
}

/** Sort key for secondary nodes: provider candidates first, then by reachability hop. */
function hopFor(id: string, reachable: Map<string, number>, candidateIds: ReadonlySet<string>): number {
  if (candidateIds.has(id)) return -1;
  return reachable.get(id) ?? 99;
}

const TASK_STOPWORDS = new Set<string>([
  "that", "this", "with", "from", "when", "which", "into", "your", "will", "have", "been",
  "they", "then", "than", "else", "does", "need", "should", "make", "change", "update",
  "were", "some", "there", "their", "would", "could", "about", "where", "while",
]);

function taskTokens(taskFrame: TaskFrame): string[] {
  const text = [taskFrame.rawTask, ...taskFrame.expectedBehavior, ...taskFrame.observedBehavior, ...taskFrame.capabilities]
    .join(" ")
    .toLowerCase();
  return [...new Set(text.split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !TASK_STOPWORDS.has(t)))];
}

/** Deterministic, name-based entrypoint seeding for repos without semantic markers. */
function lexicalEntrypoints(index: GraphIndex, taskFrame: TaskFrame): string[] {
  const tokens = taskTokens(taskFrame);
  if (tokens.length === 0) return [];
  const matches: string[] = [];
  const kinds: NodeKind[] = ["function", "class", "interface", "type", "enum"];
  for (const kind of kinds) {
    for (const node of index.nodesOfKind(kind)) {
      const haystack = `${node.name} ${node.filePath ?? ""}`.toLowerCase();
      if (tokens.some((t) => haystack.includes(t))) matches.push(node.id);
    }
  }
  return matches.sort((a, b) => compareIds(a, b)).slice(0, 25);
}

function buildImpactPaths(index: GraphIndex, entrypoints: ReadonlySet<string>): GraphPath[] {
  const paths: GraphPath[] = [];
  const seen = new Set<string>();
  for (const entry of entrypoints) {
    for (const path of index.callPathsFrom(entry)) {
      const key = path.nodeIds.join(">");
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(path);
    }
  }
  return paths.sort((a, b) => b.nodeIds.length - a.nodeIds.length || compareIds(a.nodeIds.join(), b.nodeIds.join())).slice(0, 6);
}

function migrationsForInvariants(index: GraphIndex, invNodeIds: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const invId of invNodeIds) {
    for (const e of index.inEdges(invId, ["related_to"])) {
      const node = index.node(e.from);
      if (node?.kind === "migration") result.add(node.id);
    }
  }
  return result;
}

function collectRelevantTests(index: GraphIndex, primaryIds: ReadonlySet<string>): RepositoryNode[] {
  const testIds = new Set<string>();
  for (const id of primaryIds) {
    for (const e of index.outEdges(id, ["tested_by"])) testIds.add(e.to);
  }
  return [...testIds]
    .map((id) => index.node(id))
    .filter((n): n is RepositoryNode => n !== undefined && n.kind === "test")
    .sort((a, b) => compareIds(a.id, b.id));
}

function reasonForNode(index: GraphIndex, node: RepositoryNode, pathNodeIds: ReadonlySet<string>): string {
  const parts: string[] = [];
  const caps = index.outEdges(node.id, ["implements_capability"]).map((e) => index.node(e.to)?.name).filter(Boolean);
  if (caps.length > 0) parts.push(`implements capability "${caps.join(", ")}"`);
  const invs = index.outEdges(node.id, ["constrained_by"]).map((e) => index.node(e.to)?.name).filter(Boolean);
  if (invs.length > 0) parts.push(`constrained by invariant "${invs.join(", ")}"`);
  const tests = index.outEdges(node.id, ["tested_by"]);
  if (tests.length > 0) parts.push(`covered by ${tests.length} test(s)`);
  if (pathNodeIds.has(node.id)) parts.push("on the task's primary call path");
  if (node.kind === "migration") parts.push("defines the persistence schema for the invariant");
  if (node.kind === "invariant") parts.push("is a hard, non-negotiable domain invariant");
  if (parts.length === 0) parts.push(`${node.kind} relevant to the task`);
  return parts.join("; ");
}

interface ReadInputs {
  entrypoints: ReadonlySet<string>;
  hardConstraints: Claim[];
  migrationIds: ReadonlySet<string>;
  relevantTests: RepositoryNode[];
  pathNodeIds: ReadonlySet<string>;
  primaryIds: ReadonlySet<string>;
  secondaryNodes: RepositoryNode[];
  /** Reachability closure from task entrypoints; used to gate task-relevant decisions. */
  reachable: ReadonlyMap<string, number>;
}

function buildRecommendedReads(index: GraphIndex, inputs: ReadInputs): RecommendedRead[] {
  const byPath = new Map<string, RecommendedRead>();
  const add = (node: RepositoryNode | undefined, priority: ReadPriority): void => {
    if (node?.filePath === undefined) return;
    const read: RecommendedRead = {
      path: node.filePath,
      reason: reasonForNode(index, node, inputs.pathNodeIds),
      priority,
      evidenceIds: nodeEvidenceIds(node),
    };
    const existing = byPath.get(read.path);
    if (existing === undefined || rank(priority) > rank(existing.priority)) byPath.set(read.path, read);
  };

  for (const id of inputs.entrypoints) add(index.node(id), "critical");
  for (const claim of inputs.hardConstraints) {
    for (const id of claim.subjectNodeIds) if (isCode(index, id)) add(index.node(id), "critical");
  }
  for (const id of inputs.migrationIds) add(index.node(id), "high");
  for (const test of inputs.relevantTests) add(test, "high");
  // Decisions (ADRs) are recommended only when task-relevant: selected as a primary node
  // or reachable from a task entrypoint. Guards against dumping every ADR into every pack.
  for (const node of index.nodesOfKind("decision")) {
    if (inputs.primaryIds.has(node.id) || inputs.reachable.has(node.id)) add(node, "medium");
  }

  return [...byPath.values()].sort((a, b) => rank(b.priority) - rank(a.priority) || compareIds(a.path, b.path));
}

function rank(priority: ReadPriority): number {
  return priority === "critical" ? 3 : priority === "high" ? 2 : 1;
}

function buildUnknowns(
  index: GraphIndex,
  taskFrame: TaskFrame,
  eligibleClaims: readonly Claim[],
): string[] {
  const unknowns: string[] = [];
  for (const cap of taskFrame.capabilities) {
    if (!index.has(capabilityId(cap))) unknowns.push(`Capability "${cap}" referenced by the task was not found in the graph.`);
  }
  for (const inv of taskFrame.hardInvariants) {
    if (!index.has(invariantId(inv))) unknowns.push(`Invariant "${inv}" referenced by the task was not found in the graph.`);
  }
  for (const claim of eligibleClaims) {
    if (claim.kind === "invariant" && claim.verificationStatus === "inferred") {
      unknowns.push(`Invariant "${claim.statement}" is only inferred (no test proves it).`);
    }
  }
  for (const hyp of taskFrame.hypotheses) {
    if (hyp.status === "unverified") unknowns.push(`Hypothesis not yet verified: ${hyp.statement}`);
  }
  const concurrencyRisk = taskFrame.riskSurfaces.some((r) => /concurr|race|lock|atomic/i.test(r));
  if (concurrencyRisk) {
    unknowns.push(
      "Static analysis cannot prove a concurrency race; confirm the behaviour by running or reading the affected path under concurrent execution.",
    );
  }
  return [...new Set(unknowns)];
}

interface PlanInputs {
  relevantTests: RepositoryNode[];
  hardConstraints: Claim[];
  entrypoints: ReadonlySet<string>;
  taskFrame: TaskFrame;
}

function buildVerificationPlan(inputs: PlanInputs): VerificationPlan {
  const steps: VerificationStep[] = [];
  const testPaths = inputs.relevantTests.map((t) => t.filePath).filter((p): p is string => p !== undefined);

  if (inputs.relevantTests.length > 0) {
    steps.push({
      description: "Run the tests that cover the touched code paths; they must stay green.",
      kind: "run_test",
      command: "bun run test",
      targetNodeIds: inputs.relevantTests.map((t) => t.id),
      evidenceIds: inputs.relevantTests.flatMap(nodeEvidenceIds),
    });
  }

  for (const claim of inputs.hardConstraints) {
    steps.push({
      description: `Statically re-check the invariant: ${claim.statement}`,
      kind: "static_check",
      targetNodeIds: claim.subjectNodeIds,
      evidenceIds: claim.evidenceIds,
    });
  }

  const concurrency = inputs.taskFrame.riskSurfaces.some((r) => /concurr|race|lock|atomic/i.test(r)) || inputs.taskFrame.mode === "bugfix";
  if (concurrency && inputs.entrypoints.size > 0) {
    steps.push({
      description: "Add and run a reproduction test exercising concurrent execution on the entrypoints, proving the invariant holds after the fix.",
      kind: "reproduce",
      targetNodeIds: [...inputs.entrypoints],
      evidenceIds: [],
    });
  }

  return {
    steps,
    requiredTests: testPaths,
    notes: [
      "The verification plan is derived from tested_by edges and hard invariants; it is not a substitute for judgement.",
    ],
  };
}
