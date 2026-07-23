import type { SemanticCandidate, SemanticCandidateProvider, SemanticSearchInput } from "./provider";

/** Default provider: contributes nothing, always available. Keeps the tool fully local. */
export class NullSemanticCandidateProvider implements SemanticCandidateProvider {
  readonly name = "none";

  async version(): Promise<string> {
    return "builtin@1";
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async search(_input: SemanticSearchInput): Promise<SemanticCandidate[]> {
    return [];
  }
}
