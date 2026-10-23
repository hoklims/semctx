import { dirname, relative, resolve } from "node:path";

export function retainedMetadataFromTs7(root: string, available: string[], observations: unknown): string[] {
  if (!Array.isArray(observations)) throw Error("missing TS7 configuration AST observations");
  const files = new Set(available.map(path => resolve(path)));
  const references = new Map<string, string[]>();
  for (const observation of observations as unknown[]) {
    if (observation === null || typeof observation !== "object") throw Error("malformed TS7 configuration AST observation");
    const row = observation as Record<string, unknown>;
    if (typeof row.path !== "string" || !Array.isArray(row.extends) || row.extends.some((value: unknown) => typeof value !== "string")) throw Error("malformed TS7 configuration AST observation");
    const path = resolve(row.path);
    if (!files.has(path) || references.has(path)) throw Error("foreign or duplicate TS7 configuration AST observation");
    references.set(path, row.extends as string[]);
  }
  const named = /(?:^|\/)(?:tsconfig[^/]*\.json|package\.json|pyproject\.toml|bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
  const metadata = new Set([...files].filter(path => named.test(relative(root, path))));
  const pending = [...metadata].filter(path => /(?:^|\/)tsconfig[^/]*\.json$/.test(path));
  for (const path of pending) {
    const parents = references.get(path);
    if (!parents) throw Error("missing TS7 configuration AST: " + path);
    for (const reference of parents.filter(value => value.startsWith("."))) {
      const target = resolve(dirname(path), reference.endsWith(".json") ? reference : reference + ".json");
      if (!files.has(target) || metadata.has(target)) continue;
      metadata.add(target);
      pending.push(target);
    }
  }
  return [...metadata].map(path => relative(root, path)).toSorted();
}
