/**
 * Optional semantic candidate provider (ADR 0004).
 *
 * The deterministic core never depends on this. A provider may only ADD candidates for
 * consideration; candidates are subject to the same gates and never become authoritative
 * on their own. The system works with zero providers.
 */

export interface DerivedProviderFactSeal {
  schemaVersion: 1;
  kind: "derived_provider_fact_seal";
  providerIdentity: string;
  providerVersion: string;
  inputDigest: string;
  sourceRepositorySealHash: string;
  capturedAt: string;
  provenance: "derived";
  sealHash: string;
}

export interface SemanticCandidate {
  filePath: string;
  symbolName?: string;
  /** Provider relevance in [0,1]. Informational; never overrides gates. */
  score: number;
  snippet?: string;
  startLine?: number;
  endLine?: number;
  provider: string;
  /** Required before the candidate may influence a compiled context/control projection. */
  seal?: DerivedProviderFactSeal;
}

export interface SemanticSearchInput {
  query: string;
  repositoryRoot: string;
  limit: number;
}

export interface AttestedSemanticSearchResult {
  candidates: SemanticCandidate[];
  providerVersion: string;
  sourceRepositorySealHash: string;
}

export interface SemanticCandidateProvider {
  readonly name: string;
  /** Exact external provider version used to produce candidates; null means facts stay unsealed. */
  version?(): Promise<string | null>;
  /** Atomic result envelope. Only this surface can produce seal-eligible candidates. */
  attestedSearch?(input: SemanticSearchInput): Promise<AttestedSemanticSearchResult>;
  /** Cheap availability probe; the core skips the provider when this is false. */
  isAvailable(): Promise<boolean>;
  search(input: SemanticSearchInput): Promise<SemanticCandidate[]>;
}
