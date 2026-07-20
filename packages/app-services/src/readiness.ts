import { existsSync } from "node:fs";
import { SemctxError } from "@semantic-context/core";
import {
  SqliteRepositoryReader,
  dbPath,
  isInitialized,
} from "@semantic-context/repository-store";

/** Open an indexed repository through an immutable reader, without creating readiness state. */
export function openReadyRepository(root: string): SqliteRepositoryReader {
  if (!isInitialized(root)) {
    throw new SemctxError("CONFIG_NOT_FOUND", `repository is not initialized/prepared at ${root}; run 'semctx setup' first`, {
      root,
    });
  }
  const database = dbPath(root);
  if (!existsSync(database)) {
    throw new SemctxError("REPO_NOT_INDEXED", `repository index is absent at ${root}; run 'semctx setup' first`, {
      root,
    });
  }
  const reader = SqliteRepositoryReader.openExisting(database);
  if (!reader.isIndexed()) {
    reader.close();
    throw new SemctxError("REPO_NOT_INDEXED", `repository index is absent at ${root}; run 'semctx setup' first`, {
      root,
    });
  }
  return reader;
}
