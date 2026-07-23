import { resolveProvider } from "@semantic-context/cocoindex-adapter";
import type {
  SemanticCandidate,
  SemanticCandidateProvider,
  SemanticSearchInput,
} from "@semantic-context/cocoindex-adapter";
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
import { sealProviderCandidates, type ProviderCaptureContext } from "./provider-seal";

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
  providerInput?: SemanticSearchInput;
  expectedProviderSourceSealHash?: string;
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
    ...(args.providerInput !== undefined ? { providerInput: args.providerInput } : {}),
    ...(args.expectedProviderSourceSealHash !== undefined
      ? { expectedProviderSourceSealHash: args.expectedProviderSourceSealHash }
      : {}),
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
  capture?: ProviderCaptureContext,
): Promise<SemanticCandidate[]> {
  if (config.semanticProvider === "none") return [];
  const provider = resolveProvider(config.semanticProvider);
  try {
    const input = { query, repositoryRoot: config.repositoryRoot, limit };
    return await fetchCandidatesFromProvider(provider, input, capture);
  } catch {
    return [];
  }
}

/** Execute one provider while preserving the atomic attested-result trust boundary. */
export async function fetchCandidatesFromProvider(
  provider: SemanticCandidateProvider,
  input: SemanticSearchInput,
  capture?: ProviderCaptureContext,
): Promise<SemanticCandidate[]> {
  const version = provider.version === undefined ? null : await provider.version();
  if (provider.version === undefined ? !(await provider.isAvailable()) : version === null) return [];
  if (capture !== undefined && provider.attestedSearch !== undefined) {
    const result = await provider.attestedSearch(input);
    if (
      result.providerVersion.length > 0
      && result.sourceRepositorySealHash === capture.sourceRepositorySealHash
    ) {
      return sealProviderCandidates(
        result.candidates,
        { ...input, providerIdentity: provider.name, providerVersion: result.providerVersion },
        capture,
      );
    }
    return result.candidates;
  }
  return await provider.search(input);
}

export const defaultTaskExtractor = new HeuristicTaskFrameExtractor();
