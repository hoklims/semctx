/**
 * Optional semantic candidate provider (ADR 0004).
 *
 * The deterministic core never depends on this. A provider may only ADD candidates for
 * consideration; candidates are subject to the same gates and never become authoritative
 * on their own. The system works with zero providers.
 */

export interface SemanticCandidate {
  filePath: string;
  symbolName?: string;
  /** Provider relevance in [0,1]. Informational; never overrides gates. */
  score: number;
  snippet?: string;
  startLine?: number;
  endLine?: number;
  provider: string;
}

export interface SemanticSearchInput {
  query: string;
  repositoryRoot: string;
  limit: number;
}

export interface SemanticCandidateProvider {
  readonly name: string;
  /** Cheap availability probe; the core skips the provider when this is false. */
  isAvailable(): Promise<boolean>;
  search(input: SemanticSearchInput): Promise<SemanticCandidate[]>;
}
