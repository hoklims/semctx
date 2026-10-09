/**
 * Narrow read-only Plane-B surface for task planning and diff reconciliation.
 */
export {
  ChangeContractSchema as ReconciliationChangeContractSchema,
  RepositoryLinkSchema as ReconciliationRepositoryLinkSchema,
  SemanticModelSchema,
} from "./schemas";

export {
  buildRepositoryLinkIndex,
  resolveRepositoryLink,
  resolveRepositoryLinks,
} from "./repository-links";
export {
  emptyModel,
  mergeModels,
} from "./model";
export {
  DEFAULT_STATUS_BY_KIND,
  isChangeLifecycle,
  isSemanticNodeKind,
  isSemanticProvenance,
  isSemanticStatus,
} from "./constants";
export {
  kindOfSemanticId,
  repositoryLinkFromRef,
} from "./ids";
export { normalizeLegacySemanticModelV1 } from "./compatibility";
export type { RepositoryFacts } from "./repository-links";
export type {
  ChangeContract,
  ChangeTargetBindingV1,
  RepositoryLink,
  SemanticCompatibilityNoteV1,
  SemanticModel,
  SemanticNode,
  SemanticNodeKind,
  SemanticProvenance,
  SemanticRelation,
  SemanticRelationKind,
  SemanticStatus,
} from "./types";
