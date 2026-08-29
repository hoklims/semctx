/** Compatibility surface: canonical repository-link resolution lives in semantic-model. */

export {
  buildRepositoryLinkIndex,
  findDanglingReferences,
  LEGACY_SYMBOL_ANCHOR_SHIPPED_IN,
  LEGACY_SYMBOL_ANCHOR_SUPPORT,
  resolveRepositoryLink,
  resolveRepositoryLinks,
} from "@semantic-context/semantic-model";
export type {
  DanglingReference,
  LegacySymbolAnchorSupport,
  LinkReport,
  LinkResolution,
  LinkResolutionOptions,
  LinkResolutionReasonCode,
  RepositoryFacts,
  RepositoryLinkIndex,
  RepositoryLinkResolution,
  RepositoryLinkTarget,
  StaleLinkResolution,
} from "@semantic-context/semantic-model";
