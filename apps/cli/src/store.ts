import { attachSuppressedError } from "@semantic-context/core";
import { openStore, type RepositoryStore } from "@semantic-context/repository-store";

function closeStore(store: RepositoryStore, failure: { error: unknown } | undefined): void {
  try {
    store.close();
  } catch (error) {
    throw failure === undefined ? error : attachSuppressedError(failure.error, error);
  }
}

export function withStore<T>(root: string, operation: (store: RepositoryStore) => T): T {
  const store = openStore(root);
  let failure: { error: unknown } | undefined;
  try {
    return operation(store);
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    closeStore(store, failure);
  }
}

export async function withStoreAsync<T>(root: string, operation: (store: RepositoryStore) => Promise<T>): Promise<T> {
  const store = openStore(root);
  let failure: { error: unknown } | undefined;
  try {
    return await operation(store);
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    closeStore(store, failure);
  }
}
