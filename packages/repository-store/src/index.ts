/** Public surface of @semantic-context/repository-store. */
export { SqliteRepositoryReader, SqliteRepositoryStore, assertUnlinkedDatabase } from "./store";
export type { ReadonlyRepositoryStore, RepositoryIndexSnapshot, RepositoryStore } from "./store";
export { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";
export {
  SEMCTX_DIR,
  semctxDir,
  configPath,
  dbPath,
  contextPacksDir,
  isInitialized,
  initWorkspace,
  saveConfig,
  toDiskConfig,
  loadConfig,
  openStore,
  openReader,
  verificationStatePath,
  assertUnlinkedWorkspace,
  assertUnlinkedBelow,
  isLinkedEntry,
  writeFileNoFollow,
} from "./workspace";
export {
  FEEDBACK_DIR_NAME,
  FEEDBACK_FILE_NAME,
  feedbackDir,
  feedbackFilePath,
  readFeedbackStore,
  writeFeedbackStore,
} from "./feedback-store";
export type { FeedbackStoreReadResult, FeedbackStoreReadStatus } from "./feedback-store";
