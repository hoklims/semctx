/**
 * Narrow, recursively read-only Plane-B surface for task reconciliation.
 *
 * This file intentionally does not import the semantic store or target store
 * modules because those modules also contain writers.
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { compareIds, SemctxError } from "@semantic-context/core";
import {
  parseSemanticSource,
  type Diagnostic,
} from "@semantic-context/semantic-dsl/reconciliation-read";
import {
  emptyModel,
  mergeModels,
  type SemanticModel,
} from "@semantic-context/semantic-model/reconciliation-read";
import {
  TargetArchitectureArtifactV1Schema,
  computeTargetArchitecturePayloadHash,
  type TargetArchitectureArtifactV1,
} from "./target-architecture-artifact";
export { computeTargetArchitecturePayloadHash } from "./target-architecture-artifact";
export type {
  TargetArchitectureArtifactV1,
  TargetArchitectureRevisionRefV1,
} from "./target-architecture-artifact";

export interface LoadResult {
  model: SemanticModel;
  diagnostics: Diagnostic[];
  duplicateIds: string[];
}

export function loadSemanticModel(root: string): LoadResult {
  const semanticRoot = resolve(root, ".semctx", "semantic");
  assertUnlinkedEntry(resolve(root, ".semctx"), "semantic model symlinks are unsupported");
  const files = listSemanticFiles(semanticRoot);
  const diagnostics: Diagnostic[] = [];
  const seen = new Map<string, number>();
  const models: SemanticModel[] = [];
  for (const file of files) {
    const parsed = parseSemanticSource(
      readFileSync(file, "utf8"),
      relative(resolve(root), file).replaceAll("\\", "/"),
    );
    diagnostics.push(...parsed.diagnostics);
    for (const id of [
      ...parsed.model.nodes.map((node) => node.id),
      ...parsed.model.changes.map((change) => change.id),
    ]) seen.set(id, (seen.get(id) ?? 0) + 1);
    models.push(parsed.model);
  }
  return {
    model: models.length === 0 ? emptyModel() : mergeModels(...models),
    diagnostics,
    duplicateIds: [...seen]
      .filter(([, count]) => count > 1)
      .map(([id]) => id)
      .sort(compareIds),
  };
}

export function loadTargetArtifact(
  root: string,
  targetId: string,
  revision: number,
): TargetArchitectureArtifactV1 {
  assertTargetIdentity(targetId, revision);
  const targetRoot = resolve(root, ".semctx", "semantic", "targets");
  // Every directory from `.semctx` to the target directory must be real: this loader never
  // follows a link, planted or dangling, towards an artifact authored outside the repository.
  for (const directory of [resolve(root, ".semctx"), resolve(root, ".semctx", "semantic"), targetRoot, resolve(targetRoot, targetId)]) {
    assertUnlinkedEntry(directory, "target artifact directory symlinks are unsupported");
  }
  const path = resolve(targetRoot, targetId, `r${revision}.target.json`);
  const fromRoot = relative(targetRoot, path);
  if (fromRoot.startsWith("..") || fromRoot.startsWith("/") || /^[A-Za-z]:/.test(fromRoot)) {
    refuse("target artifact path escapes the target store");
  }
  if (!existsSync(path)) refuse(`target artifact not found: ${targetId} r${revision}`);
  assertRegularFile(path);
  const artifact = parseTargetArtifact(readFileSync(path, "utf8"));
  if (artifact.targetId !== targetId || artifact.revision !== revision) {
    refuse("target artifact identity does not match its path");
  }
  if (artifact.normativeStatus === "accepted") {
    const supersedes = artifact.supersedesRef!;
    const proposal = loadTargetArtifact(root, supersedes.targetId, supersedes.revision);
    if (
      proposal.normativeStatus !== "proposed"
      || proposal.artifactHash !== supersedes.artifactHash
      || computeTargetArchitecturePayloadHash(proposal)
        !== computeTargetArchitecturePayloadHash(artifact)
    ) refuse("accepted target does not preserve its immutable proposal");
  }
  return artifact;
}

function listSemanticFiles(directory: string): string[] {
  assertUnlinkedEntry(directory, "semantic model symlinks are unsupported");
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    compareIds(left.name, right.name)
  )) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink() && entry.name.endsWith(".sem")) {
      refuse("semantic model symlinks are unsupported");
    } else if (entry.isDirectory()) {
      files.push(...listSemanticFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".sem")) {
      files.push(path);
    }
  }
  return files;
}

function parseTargetArtifact(source: string): TargetArchitectureArtifactV1 {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    refuse("target artifact is not valid JSON");
  }
  const parsed = TargetArchitectureArtifactV1Schema.safeParse(value);
  if (!parsed.success) refuse("target artifact failed its read-only schema checks");
  return parsed.data as TargetArchitectureArtifactV1;
}

function assertTargetIdentity(targetId: unknown, revision: unknown): void {
  if (
    typeof targetId !== "string"
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(targetId)
    || typeof revision !== "number"
    || !Number.isSafeInteger(revision)
    || revision < 1
  ) refuse("invalid target artifact identity");
}

/** `lstat` reports the entry itself, so a dangling link is refused too; only an absent entry passes. */
function assertUnlinkedEntry(path: string, message: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) refuse(message);
}

function assertRegularFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) refuse("target artifact must be a regular file");
}

function refuse(message: string): never {
  throw new SemctxError("CONTROL_INPUTS_UNSAFE", message);
}
