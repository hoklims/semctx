import type { SemanticCandidateProvider } from "./provider";
import { NullSemanticCandidateProvider } from "./null-provider";
import { CocoIndexCandidateProvider, type CocoIndexOptions } from "./cocoindex-provider";

/** Resolve a provider by config name. Unknown names fall back to the null provider. */
export function resolveProvider(name: string, options?: CocoIndexOptions): SemanticCandidateProvider {
  if (name === "cocoindex") return new CocoIndexCandidateProvider(options);
  return new NullSemanticCandidateProvider();
}
