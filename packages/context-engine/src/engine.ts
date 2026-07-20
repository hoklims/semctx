import { resolveProvider } from "@semantic-context/cocoindex-adapter";
import type { SemanticCandidate } from "@semantic-context/cocoindex-adapter";
import type {
  SemctxConfig,
  RepositoryGraph,
  EvidenceRecord,
  Claim,
  TaskFrame,
  ContextPack,
  NodeKind,
} from "@semantic-context/core";
import { GraphIndex } from "./graph-index";
import { buildContextPack } from "./context-pack-builder";
import { HeuristicTaskFrameExtractor, type TaskExtractionContext } from "./task-frame-extractor";

/** Build the extractor context (known vocabulary + capability wiring) from a graph. */
export function extractionContext(graph: RepositoryGraph, now: string): TaskExtractionContext {
  const index = new GraphIndex(graph);
  const namesOf = (kind: NodeKind): string[] => graph.nodes.filter((n) => n.kind === kind).map((n) => n.name);

  const capabilityInvariants: Record<string, string[]> = {};
  const capabilityBoundedContexts: Record<string, string[]> = {};
  for (const cap of index.nodesOfKind("capability")) {
    const invariants = new Set<string>();
    const boundedContexts = new Set<string>();
    for (const edge of index.inEdges(cap.id, ["implements_capability"])) {
      const impl = index.node(edge.from);
      if (impl?.boundedContext !== undefined) boundedContexts.add(impl.boundedContext);
      for (const e of index.outEdges(edge.from, ["constrained_by"])) {
        const inv = index.node(e.to);
        if (inv !== undefined) invariants.add(inv.name);
      }
      for (const e of index.outEdges(edge.from, ["belongs_to"])) {
        const bc = index.node(e.to);
        if (bc?.kind === "bounded_context") boundedContexts.add(bc.name);
      }
    }
    capabilityInvariants[cap.name] = [...invariants];
    capabilityBoundedContexts[cap.name] = [...boundedContexts];
  }

  return {
    knownCapabilities: namesOf("capability"),
    knownInvariants: namesOf("invariant"),
    knownBoundedContexts: namesOf("bounded_context"),
    capabilityInvariants,
    capabilityBoundedContexts,
    now,
  };
}

export interface PrepareArgs {
  graph: RepositoryGraph;
  evidence: EvidenceRecord[];
  claims: Claim[];
  taskFrame: TaskFrame;
  now: string;
  candidateProviders?: string[];
  providerCandidates?: SemanticCandidate[];
}

/** Compile a task frame into a context pack from a loaded graph (used by `context prepare`). */
export function prepareContextPack(args: PrepareArgs): ContextPack {
  return buildContextPack({
    index: new GraphIndex(args.graph),
    claims: args.claims,
    taskFrame: args.taskFrame,
    evidenceRecords: args.evidence,
    now: args.now,
    ...(args.candidateProviders !== undefined ? { candidateProviders: args.candidateProviders } : {}),
    ...(args.providerCandidates !== undefined ? { providerCandidates: args.providerCandidates } : {}),
  });
}

/**
 * Fetch optional semantic-provider candidates for a query. Returns [] when the provider
 * is "none", unavailable, or errors — the deterministic core is never blocked on it.
 */
export async function fetchProviderCandidates(
  config: SemctxConfig,
  query: string,
  limit = 20,
): Promise<SemanticCandidate[]> {
  if (config.semanticProvider === "none") return [];
  const provider = resolveProvider(config.semanticProvider);
  try {
    if (!(await provider.isAvailable())) return [];
    return await provider.search({ query, repositoryRoot: config.repositoryRoot, limit });
  } catch {
    return [];
  }
}

export const defaultTaskExtractor = new HeuristicTaskFrameExtractor();
