/** Compatibility surface: canonical repository-link resolution lives in semantic-model. */

export {
  buildRepositoryLinkIndex,
  findDanglingReferences,
  resolveRepositoryLink,
  resolveRepositoryLinks,
} from "@semantic-context/semantic-model";
export type {
  DanglingReference,
  LinkReport,
  LinkResolution,
  RepositoryFacts,
  RepositoryLinkIndex,
  RepositoryLinkResolution,
  RepositoryLinkTarget,
  StaleLinkResolution,
} from "@semantic-context/semantic-model";
