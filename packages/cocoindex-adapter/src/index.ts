/** Public surface of @semantic-context/cocoindex-adapter. */
export type {
  SemanticCandidate,
  SemanticSearchInput,
  SemanticCandidateProvider,
} from "./provider";
export { NullSemanticCandidateProvider } from "./null-provider";
export { CocoIndexCandidateProvider } from "./cocoindex-provider";
export type { CocoIndexOptions } from "./cocoindex-provider";
export { resolveProvider } from "./resolve";
