/** Immutable Plane-B target architecture artifacts. This module exposes no generic writer. */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { compareIds, SemctxError } from "@semantic-context/core";
import {
  type ArchitectureElement,
  type ArchitectureRelation,
  type Sha256Hash,
} from "@semantic-context/control-model";
import { isSafeTargetId, targetArtifactPath, targetsDir } from "./paths";
import {
  TargetArchitectureArtifactV1Schema,
  computeTargetArchitecturePayloadHash,
  computeTargetArtifactHash,
  targetArchitectureRelationSortKey,
  type TargetArchitectureArtifactV1,
  type TargetAuthorshipOriginV1,
} from "./target-architecture-artifact";
export {
  TargetArchitectureArtifactV1Schema,
  computeTargetArchitecturePayloadHash,
  computeTargetArtifactHash,
} from "./target-architecture-artifact";
export type {
  TargetArchitectureArtifactV1,
  TargetArchitectureRevisionRefV1,
  TargetAuthorshipOriginV1,
  TargetNormativeStatusV1,
} from "./target-architecture-artifact";

export interface TargetArchitectureProposalInputV1 {
  targetId: string;
  revision: number;
  statement: string;
  baseCommit: string;
  sourceGraphSeal: Sha256Hash;
  elements: readonly ArchitectureElement[];
  relations: readonly ArchitectureRelation[];
  preservedInvariantIds: readonly string[];
  authorshipOrigin: TargetAuthorshipOriginV1;
}

export interface TargetArtifactLocationV1 {
  targetId: string;
  revision: number;
  path: string;
  relativePath: string;
}

export function discoverTargetArtifacts(root: string): TargetArtifactLocationV1[] {
  const base = targetsDir(root);
  if (!existsSync(base)) return [];
  assertSafeTargetTreeRoot(root);
  const locations: TargetArtifactLocationV1[] = [];
  const identities = new Set<string>();

  for (const targetEntry of readdirSync(base, { withFileTypes: true }).sort((left, right) => compareIds(left.name, right.name))) {
    const targetPath = resolve(base, targetEntry.name);
    if (targetEntry.isSymbolicLink()) refuse("target artifact symlinks are unsupported", { path: targetPath });
    if (!targetEntry.isDirectory()) continue;
    if (!isSafeTargetId(targetEntry.name)) refuse("unsafe target directory name", { path: targetPath });
    assertNotSymlink(targetPath);
    for (const revisionEntry of readdirSync(targetPath, { withFileTypes: true }).sort((left, right) => compareIds(left.name, right.name))) {
      const artifactPath = resolve(targetPath, revisionEntry.name);
      if (revisionEntry.isSymbolicLink()) refuse("target artifact symlinks are unsupported", { path: artifactPath });
      if (revisionEntry.isDirectory()) refuse("nested target artifact directories are unsupported", { path: artifactPath });
      if (!revisionEntry.isFile()) continue;
      const match = /^r([1-9][0-9]*)\.target\.json$/.exec(revisionEntry.name);
      if (match === null) {
        if (revisionEntry.name.endsWith(".target.json")) refuse("invalid target artifact filename", { path: artifactPath });
        continue;
      }
      const revision = Number(match[1]);
      if (!Number.isSafeInteger(revision)) refuse("target revision exceeds the safe integer range", { path: artifactPath });
      const identity = identityKey(targetEntry.name, revision);
      if (identities.has(identity)) refuse("duplicate target artifact identity", { targetId: targetEntry.name, revision });
      identities.add(identity);
      locations.push({
        targetId: targetEntry.name,
        revision,
        path: artifactPath,
        relativePath: relative(resolve(root), artifactPath).replaceAll("\\", "/"),
      });
    }
  }
  return locations.sort((left, right) => compareIds(left.targetId, right.targetId) || left.revision - right.revision);
}

export function loadTargetArtifacts(root: string): TargetArchitectureArtifactV1[] {
  const artifacts = discoverTargetArtifacts(root).map(readTargetArtifact);
  const byIdentity = new Map(artifacts.map((artifact) => [identityKey(artifact.targetId, artifact.revision), artifact]));
  if (byIdentity.size !== artifacts.length) refuse("duplicate target artifact identity");
  for (const artifact of artifacts) {
    if (artifact.normativeStatus !== "accepted") continue;
    const supersedes = artifact.supersedesRef!;
    const proposal = byIdentity.get(identityKey(supersedes.targetId, supersedes.revision));
    if (
      proposal === undefined
      || proposal.normativeStatus !== "proposed"
      || proposal.artifactHash !== supersedes.artifactHash
      || computeTargetArchitecturePayloadHash(proposal) !== computeTargetArchitecturePayloadHash(artifact)
    ) {
      refuse("accepted target does not preserve its immutable proposal payload", {
        targetId: artifact.targetId,
        revision: artifact.revision,
      });
    }
  }
  return artifacts;
}

export function loadTargetArtifact(root: string, targetId: string, revision: number): TargetArchitectureArtifactV1 {
  targetArtifactPath(root, targetId, revision);
  const artifact = loadTargetArtifacts(root).find((candidate) =>
    candidate.targetId === targetId && candidate.revision === revision
  );
  if (artifact === undefined) {
    throw new SemctxError("INVALID_TASK_INPUT", `target artifact not found: ${targetId} r${revision}`);
  }
  return artifact;
}

export function createTargetProposal(
  root: string,
  input: TargetArchitectureProposalInputV1,
): TargetArchitectureArtifactV1 {
  const artifactWithoutHash: Omit<TargetArchitectureArtifactV1, "artifactHash"> = {
    schemaVersion: 1,
    kind: "target_architecture",
    targetId: input.targetId,
    revision: input.revision,
    statement: input.statement.trim(),
    baseCommit: input.baseCommit,
    sourceGraphSeal: input.sourceGraphSeal,
    elements: input.elements.map((element) => ({ ...element })).sort((left, right) => compareIds(left.id, right.id)),
    relations: input.relations.map((relation) => ({ ...relation })).sort(
      (left, right) => compareIds(
        targetArchitectureRelationSortKey(left),
        targetArchitectureRelationSortKey(right),
      ),
    ),
    preservedInvariantIds: [...input.preservedInvariantIds].sort(compareIds),
    authorshipOrigin: input.authorshipOrigin,
    normativeStatus: "proposed",
  };
  const artifact = parseTargetArtifact({
    ...artifactWithoutHash,
    artifactHash: computeTargetArtifactHash(artifactWithoutHash),
  });
  createImmutableArtifact(root, artifact);
  return artifact;
}

function createImmutableArtifact(root: string, artifact: TargetArchitectureArtifactV1): void {
  const path = targetArtifactPath(root, artifact.targetId, artifact.revision);
  prepareSafeTargetDirectory(root, artifact.targetId);
  if (existsSync(path)) refuse("target artifact revision already exists", {
    targetId: artifact.targetId,
    revision: artifact.revision,
  });
  const content = `${JSON.stringify(artifact, null, 2)}\n`;
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let created = false;
  let destinationIdentityVerified = false;
  let writeSucceeded = false;
  try {
    runTargetArtifactWriteTestHook("before_temp_open", path);
    assertSafeArtifactDestination(root, artifact.targetId, path);
    const fd = openSync(tmp, "wx", 0o644);
    try {
      writeFileSync(fd, content, "utf8");
    } finally {
      closeSync(fd);
    }
    assertSafeArtifactDestination(root, artifact.targetId, path);
    linkSync(tmp, path);
    created = true;
    runTargetArtifactWriteTestHook("after_link_before_identity", path);
    assertSafeArtifactDestination(root, artifact.targetId, path);
    assertSameFile(tmp, path);
    destinationIdentityVerified = true;
    runTargetArtifactWriteTestHook("before_post_write_validation", path);
    const reloaded = readTargetArtifact({
      targetId: artifact.targetId,
      revision: artifact.revision,
      path,
      relativePath: relative(resolve(root), path).replaceAll("\\", "/"),
    });
    if (reloaded.artifactHash !== artifact.artifactHash) {
      throw new SemctxError("IO_ERROR", "post-write target validation failed", { path });
    }
    writeSucceeded = true;
  } catch (error) {
    if (
      created
      && destinationIdentityVerified
      && existsSync(tmp)
      && existsSync(path)
      && stillSameFile(tmp, path)
    ) unlinkSync(path);
    if (!created && existsSync(path)) refuse("target artifact revision already exists", {
      targetId: artifact.targetId,
      revision: artifact.revision,
    });
    throw new SemctxError("IO_ERROR", "failed to create immutable target artifact", {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
  if (!writeSucceeded) throw new SemctxError("IO_ERROR", "failed to create immutable target artifact", { path });
}

function readTargetArtifact(location: TargetArtifactLocationV1): TargetArchitectureArtifactV1 {
  assertNotSymlink(location.path);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(location.path)));
  } catch (error) {
    throw new SemctxError("CONFIG_INVALID", "target artifact is not valid UTF-8 JSON", {
      path: location.path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const artifact = parseTargetArtifact(value, location.path);
  if (artifact.targetId !== location.targetId || artifact.revision !== location.revision) {
    refuse("target artifact identity does not match its tracked path", { path: location.path });
  }
  return artifact;
}

function parseTargetArtifact(value: unknown, path?: string): TargetArchitectureArtifactV1 {
  const parsed = TargetArchitectureArtifactV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new SemctxError("CONFIG_INVALID", "target artifact failed schema or hash validation", {
      ...(path === undefined ? {} : { path }),
      issues: parsed.error.issues,
    });
  }
  return parsed.data as TargetArchitectureArtifactV1;
}

function prepareSafeTargetDirectory(root: string, targetId: string): void {
  targetArtifactPath(root, targetId, 1);
  assertSafeTargetTreeRoot(root, true);
  mkdirSync(resolve(targetsDir(root), targetId), { recursive: true });
  assertSafeTargetTreeRoot(root);
  assertNotSymlink(resolve(targetsDir(root), targetId));
  assertContainedByRoot(root, resolve(targetsDir(root), targetId));
}

function assertSafeArtifactDestination(root: string, targetId: string, path: string): void {
  assertSafeTargetTreeRoot(root);
  const targetDirectory = resolve(targetsDir(root), targetId);
  assertNotSymlink(targetDirectory);
  assertContainedByRoot(root, targetDirectory);
  if (existsSync(path)) {
    assertNotSymlink(path);
    assertContainedByRoot(root, path);
  }
}

function assertSafeTargetTreeRoot(root: string, allowMissing = false): void {
  const canonicalRoot = realpathSync.native(resolve(root));
  let current = canonicalRoot;
  for (const segment of [".semctx", "semantic", "targets"]) {
    current = resolve(current, segment);
    if (!existsSync(current)) {
      if (allowMissing) return;
      throw new SemctxError("CONFIG_INVALID", "target artifact directory is missing", { path: current });
    }
    assertNotSymlink(current);
  }
  assertContainedByRoot(canonicalRoot, current);
}

function assertContainedByRoot(root: string, path: string): void {
  const canonicalRoot = realpathSync.native(resolve(root));
  const canonicalPath = realpathSync.native(resolve(path));
  const prefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
  if (canonicalPath !== canonicalRoot && !canonicalPath.startsWith(prefix)) {
    refuse("target artifact path escapes repository root", { path });
  }
}

function assertNotSymlink(path: string): void {
  if (lstatSync(path).isSymbolicLink()) refuse("target artifact symlinks are unsupported", { path });
}

function assertSameFile(leftPath: string, rightPath: string): void {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const leftFd = openSync(leftPath, constants.O_RDONLY | noFollow);
  const rightFd = openSync(rightPath, constants.O_RDONLY | noFollow);
  try {
    const left = fstatSync(leftFd, { bigint: true });
    const right = fstatSync(rightFd, { bigint: true });
    if (left.dev !== right.dev || left.ino !== right.ino) {
      refuse("target artifact destination changed during creation", { path: rightPath });
    }
  } finally {
    closeSync(rightFd);
    closeSync(leftFd);
  }
}

function stillSameFile(leftPath: string, rightPath: string): boolean {
  try {
    assertSameFile(leftPath, rightPath);
    return true;
  } catch {
    return false;
  }
}

function identityKey(targetId: string, revision: number): string {
  return `${targetId}\0${revision}`;
}

function refuse(message: string, details: Record<string, unknown> = {}): never {
  throw new SemctxError("CONTROL_INPUTS_UNSAFE", message, details);
}

type TargetArtifactWriteTestStage =
  | "before_temp_open"
  | "after_link_before_identity"
  | "before_post_write_validation";

let targetArtifactWriteTestHook:
  | ((stage: TargetArtifactWriteTestStage, path: string) => void)
  | undefined;

/** Internal test seam; intentionally absent from the package public index. */
export function setTargetArtifactWriteTestHookForTesting(
  hook: typeof targetArtifactWriteTestHook,
): void {
  targetArtifactWriteTestHook = hook;
}

function runTargetArtifactWriteTestHook(stage: TargetArtifactWriteTestStage, path: string): void {
  targetArtifactWriteTestHook?.(stage, path);
}
