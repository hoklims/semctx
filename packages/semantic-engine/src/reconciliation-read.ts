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
  if (!existsSync(directory)) return [];
  if (lstatSync(directory).isSymbolicLink()) refuse("semantic model symlinks are unsupported");
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

function assertRegularFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) refuse("target artifact must be a regular file");
}

function refuse(message: string): never {
  throw new SemctxError("CONTROL_INPUTS_UNSAFE", message);
}
