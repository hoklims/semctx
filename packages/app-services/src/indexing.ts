import type { Claim, SemctxConfig } from "@semantic-context/core";
import { buildClaims, GraphIndex } from "@semantic-context/context-engine";
import { loadConfig, openStore } from "@semantic-context/repository-store";
import { analyzeRepository, type AnalysisResult } from "@semantic-context/ts-analyzer";

export interface RepositoryIndex {
  analysis: AnalysisResult;
  claims: Claim[];
}

/** Application boundary for filesystem analysis followed by graph-derived claim construction. */
export function analyzeAndBuildClaims(config: SemctxConfig): RepositoryIndex {
  const analysis = analyzeRepository(config);
  return { analysis, claims: buildClaims(new GraphIndex(analysis.graph)) };
}

/** Rebuild and persist Plane A. Store lifetime is owned by the application service. */
export function indexRepository(root: string, indexedAt: string): RepositoryIndex {
  const indexed = analyzeAndBuildClaims(loadConfig(root));
  const store = openStore(root);
  try {
    store.saveGraph(indexed.analysis.graph, indexed.analysis.evidence);
    store.replaceClaims(indexed.claims);
    store.setMeta("indexed_at", indexedAt);
  } finally {
    store.close();
  }
  return indexed;
}
