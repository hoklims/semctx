import { taskFrameId, hypothesisId } from "@semantic-context/core";
import type { TaskFrame, TaskMode, TaskHypothesis, TaskFrameInput } from "@semantic-context/core";

/** Known vocabulary from the indexed graph, so the extractor can match task text to it. */
export interface TaskExtractionContext {
  knownCapabilities: string[];
  knownInvariants: string[];
  knownBoundedContexts: string[];
  /** capability slug -> invariant slugs it is constrained by (from the graph). */
  capabilityInvariants?: Record<string, string[]>;
  /** capability slug -> bounded context slugs its implementers belong to. */
  capabilityBoundedContexts?: Record<string, string[]>;
  /** Injected clock (the only non-deterministic input). */
  now: string;
}

/** Pluggable extractor. The MVP ships a heuristic one; an LLM one can be added later. */
export interface TaskFrameExtractor {
  extract(input: TaskFrameInput, ctx: TaskExtractionContext): TaskFrame;
}

const MODE_KEYWORDS: Array<[TaskMode, string[]]> = [
  ["security", ["security", "vulnerab", "auth", "exploit", "injection", "xss", "csrf"]],
  ["performance", ["performance", "slow", "latency", "throughput", "optimize", "optimise"]],
  ["migration", ["migrate", "migration", "upgrade", "port to", "move to"]],
  ["refactor", ["refactor", "clean up", "restructure", "rename", "extract"]],
  ["audit", ["audit", "review", "assess", "inventory"]],
  ["bugfix", ["fix", "bug", "incorrect", "wrong", "broken", "regression", "race"]],
  ["feature", ["add", "implement", "support", "introduce", "new feature", "enable"]],
];

const LABELS: Record<string, keyof TaskFrameInput> = {
  mode: "mode",
  capability: "capabilities",
  capabilities: "capabilities",
  invariant: "hardInvariants",
  invariants: "hardInvariants",
  "hard invariant": "hardInvariants",
  observed: "observedBehavior",
  "observed behavior": "observedBehavior",
  expected: "expectedBehavior",
  "expected behavior": "expectedBehavior",
  "bounded context": "boundedContexts",
  boundedcontext: "boundedContexts",
  context: "boundedContexts",
  "non-goal": "nonGoals",
  "non goal": "nonGoals",
  nongoal: "nonGoals",
  risk: "riskSurfaces",
  risks: "riskSurfaces",
  "soft constraint": "softConstraints",
  acceptance: "acceptanceEvidence",
};

const VALID_MODES: readonly TaskMode[] = [
  "bugfix",
  "feature",
  "refactor",
  "audit",
  "performance",
  "security",
  "migration",
];

const LABEL_RE = /^[\s>*-]*([A-Za-z][A-Za-z -]*?)\s*:\s*(.+)$/;

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0));
}

function detectMode(text: string): TaskMode {
  const lower = text.toLowerCase();
  for (const [mode, keywords] of MODE_KEYWORDS) {
    if (keywords.some((k) => lower.includes(k))) return mode;
  }
  return "feature";
}

/** Match known slugs whose significant word (>=4 chars) appears in the task text. */
function matchKnown(text: string, known: readonly string[]): string[] {
  const tokens = [...tokenize(text)];
  const matched: string[] = [];
  for (const slug of known) {
    const words = slug.split(/[^a-z0-9]+/i).filter((w) => w.length >= 4);
    // A slug word matches only at a token boundary — exact, or as a token prefix so that
    // singular/plural forms still match (e.g. "order" ↔ "orders"). This rejects free
    // substring matches, which would let a short slug word hit inside an unrelated word
    // ("book" in "notebook").
    const hit = words.some((w) => tokens.some((t) => t.startsWith(w)));
    if (hit) matched.push(slug);
  }
  return matched;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))];
}

/** Parse a labelled markdown / plain-text task into a structured TaskFrameInput. */
export function parseTaskDocument(text: string): TaskFrameInput {
  const input: TaskFrameInput = { rawTask: text.trim() };
  const buckets: Record<string, string[]> = {};
  let mode: TaskMode | undefined;

  for (const line of text.split(/\r?\n/)) {
    const match = LABEL_RE.exec(line);
    if (match === null) continue;
    const rawLabel = match[1]?.trim().toLowerCase();
    const value = match[2]?.trim();
    if (rawLabel === undefined || value === undefined) continue;
    const field = LABELS[rawLabel];
    if (field === undefined) continue;
    if (field === "mode") {
      const candidate = value.toLowerCase() as TaskMode;
      if (VALID_MODES.includes(candidate)) mode = candidate;
      continue;
    }
    const parts = value.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    const key = field as string;
    buckets[key] = [...(buckets[key] ?? []), ...parts];
  }

  if (mode !== undefined) input.mode = mode;
  const assign = (field: keyof TaskFrameInput): void => {
    const values = buckets[field as string];
    if (values !== undefined && values.length > 0) {
      (input as Record<string, unknown>)[field] = uniq(values);
    }
  };
  assign("capabilities");
  assign("hardInvariants");
  assign("boundedContexts");
  assign("observedBehavior");
  assign("expectedBehavior");
  assign("nonGoals");
  assign("riskSurfaces");
  assign("softConstraints");
  assign("acceptanceEvidence");
  return input;
}

export class HeuristicTaskFrameExtractor implements TaskFrameExtractor {
  extract(input: TaskFrameInput, ctx: TaskExtractionContext): TaskFrame {
    const rawTask = input.rawTask;
    const mode: TaskMode = input.mode ?? detectMode(rawTask);

    const capabilities = uniq([...(input.capabilities ?? []), ...matchKnown(rawTask, ctx.knownCapabilities)]);
    // A matched capability pulls in the invariants and bounded contexts it is wired to
    // in the graph, so a terse task ("fix the confirmation") still resolves the invariant.
    const capInvariants = capabilities.flatMap((cap) => ctx.capabilityInvariants?.[cap] ?? []);
    const capBoundedContexts = capabilities.flatMap((cap) => ctx.capabilityBoundedContexts?.[cap] ?? []);
    const hardInvariants = uniq([...(input.hardInvariants ?? []), ...matchKnown(rawTask, ctx.knownInvariants), ...capInvariants]);
    const boundedContexts = uniq([
      ...(input.boundedContexts ?? []),
      ...matchKnown(rawTask, ctx.knownBoundedContexts),
      ...capBoundedContexts,
    ]);

    const observedBehavior = input.observedBehavior ?? [];
    const expectedBehavior = input.expectedBehavior ?? [];
    const softConstraints = input.softConstraints ?? [];
    const acceptanceEvidence = input.acceptanceEvidence ?? [];
    const nonGoals = input.nonGoals ?? [];
    const riskSurfaces = input.riskSurfaces ?? [];

    const id = taskFrameId(rawTask);
    const hypotheses = this.buildHypotheses(id, { mode, capabilities, hardInvariants, riskSurfaces });

    return {
      id,
      rawTask,
      mode,
      capabilities,
      observedBehavior,
      expectedBehavior,
      boundedContexts,
      hardInvariants,
      softConstraints,
      acceptanceEvidence,
      nonGoals,
      riskSurfaces,
      hypotheses,
      createdAt: ctx.now,
    };
  }

  private buildHypotheses(
    taskId: string,
    parts: { mode: TaskMode; capabilities: string[]; hardInvariants: string[]; riskSurfaces: string[] },
  ): TaskHypothesis[] {
    const hypotheses: TaskHypothesis[] = [];
    const cap = parts.capabilities[0];
    const inv = parts.hardInvariants[0];
    if (parts.mode === "bugfix" && cap !== undefined && inv !== undefined) {
      const statement = `The "${cap}" path can violate invariant "${inv}" under the reported conditions.`;
      hypotheses.push({ id: hypothesisId(taskId, statement), statement, confidence: 0.5, evidenceIds: [], status: "unverified" });
    }
    const risk = parts.riskSurfaces[0];
    if (risk !== undefined) {
      const statement = `Risk surface: ${risk}.`;
      hypotheses.push({ id: hypothesisId(taskId, statement), statement, confidence: 0.4, evidenceIds: [], status: "unverified" });
    }
    if (hypotheses.length === 0 && cap !== undefined) {
      const statement = `The change primarily affects the "${cap}" capability.`;
      hypotheses.push({ id: hypothesisId(taskId, statement), statement, confidence: 0.5, evidenceIds: [], status: "unverified" });
    }
    return hypotheses;
  }
}
