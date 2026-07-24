/** Trusted application boundary for accepting an immutable target architecture proposal. */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { SemctxError } from "@semantic-context/core";
import {
  CanonicalProofAttestationV1Schema,
  type CanonicalProofAttestationV1,
} from "@semantic-context/control-model";
import {
  TargetArchitectureArtifactV1Schema,
  computeTargetArchitecturePayloadHash,
  computeTargetArtifactHash,
  loadTargetArtifact,
  loadTargetArtifacts,
  targetArtifactPath,
  targetsDir,
  type TargetArchitectureArtifactV1,
} from "@semantic-context/semantic-engine";
import { canonicalRepositoryRoot } from "./freshness";
import { loadControlState } from "./control";

export interface ReviewTargetArchitectureCommandV1 {
  targetId: string;
  proposalRevision: number;
  proposalContainingCommit: string;
  attestationRef: string;
  evaluatedAt: string;
}

const REVIEW_COMMAND_KEYS = [
  "attestationRef",
  "evaluatedAt",
  "proposalContainingCommit",
  "proposalRevision",
  "targetId",
] as const;

export function reviewTargetProposal(
  root: string,
  input: ReviewTargetArchitectureCommandV1,
): TargetArchitectureArtifactV1 {
  const command = parseReviewCommand(input);
  const proposal = loadTargetArtifact(root, command.targetId, command.proposalRevision);
  if (proposal.normativeStatus !== "proposed") refuse("only a proposed target can be reviewed");
  assertProposalContainedInCommit(root, proposal, command.proposalContainingCommit);

  const state = loadControlState(root);
  const seal = state.queryFreshnessSeal;
  const index = state.sealedAttestationIndex;
  const canonicalRoot = canonicalRepositoryRoot(root);
  if (
    state.freshnessStatus.verdict !== "FRESH"
    || !state.freshnessStatus.canRunHighRiskControl
    || seal.repositoryRoot !== canonicalRoot
    || seal.indexedRepositoryRoot !== canonicalRoot
    || seal.headAtCapture !== command.proposalContainingCommit
    || seal.indexedHeadCommit !== command.proposalContainingCommit
    || seal.repositoryGraphHash !== proposal.sourceGraphSeal
    || seal.indexedRepositoryGraphHash !== proposal.sourceGraphSeal
    || seal.semanticModelHash !== seal.indexedSemanticModelHash
    || seal.analysisInputHash !== seal.indexedAnalysisInputHash
    || seal.workingDiffHash !== seal.indexedWorkingDiffHash
    || seal.storeSchemaVersion === null
    || seal.storeSchemaVersion !== seal.indexedStoreSchemaVersion
    || seal.toolVersion !== seal.indexedToolVersion
    || index === null
    || seal.attestationSetHash === null
    || seal.attestationSetHash !== index.attestationSetHash
  ) refuseAttestation();

  const matches = index.entries.filter((entry) => entry.id === command.attestationRef);
  if (matches.length !== 1) refuseAttestation();
  const attestation = matches[0]!;
  assertReviewAttestation(attestation, proposal, command);

  const acceptedWithoutHash: Omit<TargetArchitectureArtifactV1, "artifactHash"> = {
    schemaVersion: 1,
    kind: "target_architecture",
    targetId: proposal.targetId,
    revision: proposal.revision + 1,
    statement: proposal.statement,
    baseCommit: proposal.baseCommit,
    sourceGraphSeal: proposal.sourceGraphSeal,
    elements: proposal.elements.map((element) => ({ ...element })),
    relations: proposal.relations.map((relation) => ({ ...relation })),
    preservedInvariantIds: [...proposal.preservedInvariantIds],
    authorshipOrigin: proposal.authorshipOrigin,
    normativeStatus: "accepted",
    reviewAttestationRef: attestation.id,
    supersedesRef: {
      targetId: proposal.targetId,
      revision: proposal.revision,
      artifactHash: proposal.artifactHash,
    },
  };
  const accepted = parseArtifact({
    ...acceptedWithoutHash,
    artifactHash: computeTargetArtifactHash(acceptedWithoutHash),
  });
  if (computeTargetArchitecturePayloadHash(proposal) !== computeTargetArchitecturePayloadHash(accepted)) {
    refuse("accepted target architecture payload differs from proposal");
  }
  createAcceptedArtifact(root, accepted);
  return accepted;
}

function parseReviewCommand(value: ReviewTargetArchitectureCommandV1): ReviewTargetArchitectureCommandV1 {
  if (
    value === null
    || typeof value !== "object"
    || Object.keys(value).sort().join("\0") !== [...REVIEW_COMMAND_KEYS].sort().join("\0")
    || typeof value.targetId !== "string"
    || !Number.isSafeInteger(value.proposalRevision)
    || value.proposalRevision < 1
    || typeof value.proposalContainingCommit !== "string"
    || !/^[0-9a-f]{40}$/.test(value.proposalContainingCommit)
    || typeof value.attestationRef !== "string"
    || value.attestationRef.length === 0
    || typeof value.evaluatedAt !== "string"
    || !Number.isFinite(Date.parse(value.evaluatedAt))
    || new Date(value.evaluatedAt).toISOString() !== value.evaluatedAt
  ) {
    throw new SemctxError("INVALID_TASK_INPUT", "invalid target review command");
  }
  targetArtifactPath(".", value.targetId, value.proposalRevision);
  return { ...value };
}

function assertReviewAttestation(
  attestation: CanonicalProofAttestationV1,
  proposal: TargetArchitectureArtifactV1,
  command: ReviewTargetArchitectureCommandV1,
): void {
  if (
    !CanonicalProofAttestationV1Schema.safeParse(attestation).success
    || attestation.obligation !== "target_reviewed"
    || attestation.subject !== proposal.artifactHash
    || attestation.commit !== command.proposalContainingCommit
    || attestation.epistemicStatus !== "human_declared"
    || !isFresh(attestation, command.evaluatedAt)
    || !attestation.references.some((reference) => reference.kind === "architecture" && reference.nonLlm)
  ) refuseAttestation();
}

function assertProposalContainedInCommit(
  root: string,
  proposal: TargetArchitectureArtifactV1,
  commit: string,
): void {
  const path = targetArtifactPath(root, proposal.targetId, proposal.revision);
  const relativePath = relative(resolve(root), path).replaceAll("\\", "/");
  const result = spawnSync("git", ["--no-optional-locks", "-C", root, "show", `${commit}:${relativePath}`], {
    encoding: null,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) refuseAttestation();
  let committed: TargetArchitectureArtifactV1;
  try {
    committed = parseArtifact(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)));
  } catch {
    refuseAttestation();
  }
  if (
    committed.targetId !== proposal.targetId
    || committed.revision !== proposal.revision
    || committed.artifactHash !== proposal.artifactHash
  ) refuseAttestation();
}

function createAcceptedArtifact(root: string, artifact: TargetArchitectureArtifactV1): void {
  const path = targetArtifactPath(root, artifact.targetId, artifact.revision);
  const targetDirectory = resolve(targetsDir(root), artifact.targetId);
  assertSafeDestination(root, targetDirectory, path);
  if (existsSync(path)) refuse("target artifact revision already exists", {
    targetId: artifact.targetId,
    revision: artifact.revision,
  });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let created = false;
  let destinationIdentityVerified = false;
  try {
    assertSafeDestination(root, targetDirectory, path);
    const fd = openSync(tmp, "wx", 0o644);
    try {
      writeFileSync(fd, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    } finally {
      closeSync(fd);
    }
    assertSafeDestination(root, targetDirectory, path);
    linkSync(tmp, path);
    created = true;
    runAcceptedTargetWriteTestHook("after_link_before_identity", path);
    assertSafeDestination(root, targetDirectory, path);
    assertSameFile(tmp, path);
    destinationIdentityVerified = true;
    runAcceptedTargetWriteTestHook("before_post_write_validation", path);
    const reloaded = parseArtifact(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path))));
    if (reloaded.artifactHash !== artifact.artifactHash) {
      throw new SemctxError("IO_ERROR", "post-write target validation failed", { path });
    }
    loadTargetArtifacts(root);
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
    throw new SemctxError("IO_ERROR", "failed to create immutable accepted target artifact", {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

function assertSafeDestination(root: string, targetDirectory: string, path: string): void {
  const canonicalRoot = realpathSync.native(resolve(root));
  const canonicalTargets = realpathSync.native(resolve(targetsDir(root)));
  assertContained(canonicalRoot, canonicalTargets);
  if (lstatSync(targetsDir(root)).isSymbolicLink()) refuse("target artifact symlinks are unsupported");
  if (lstatSync(targetDirectory).isSymbolicLink()) refuse("target artifact symlinks are unsupported");
  assertContained(canonicalRoot, realpathSync.native(targetDirectory));
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink()) refuse("target artifact symlinks are unsupported");
    assertContained(canonicalRoot, realpathSync.native(path));
  }
}

function assertContained(root: string, path: string): void {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (path !== root && !path.startsWith(prefix)) refuse("target artifact path escapes repository root", { path });
}

function assertSameFile(leftPath: string, rightPath: string): void {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const leftFd = openSync(leftPath, constants.O_RDONLY | noFollow);
  const rightFd = openSync(rightPath, constants.O_RDONLY | noFollow);
  try {
    const left = fstatSync(leftFd, { bigint: true });
    const right = fstatSync(rightFd, { bigint: true });
    if (!hasSameFileIdentity(left, right)) {
      refuse("target artifact destination changed during creation", { path: rightPath });
    }
  } finally {
    closeSync(rightFd);
    closeSync(leftFd);
  }
}

function hasSameFileIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Internal precision seam; intentionally absent from the package public index. */
export function hasSameFileIdentityForTesting(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return hasSameFileIdentity(left, right);
}

function stillSameFile(leftPath: string, rightPath: string): boolean {
  try {
    assertSameFile(leftPath, rightPath);
    return true;
  } catch {
    return false;
  }
}

function parseArtifact(value: unknown): TargetArchitectureArtifactV1 {
  const parsed = TargetArchitectureArtifactV1Schema.safeParse(value);
  if (!parsed.success) throw new SemctxError("CONFIG_INVALID", "target artifact failed schema or hash validation");
  return parsed.data as TargetArchitectureArtifactV1;
}

function isFresh(attestation: CanonicalProofAttestationV1, evaluatedAt: string): boolean {
  const observed = Date.parse(attestation.observedAt);
  const evaluated = Date.parse(evaluatedAt);
  const expires = Date.parse(attestation.expiresAt);
  return Number.isFinite(observed)
    && Number.isFinite(evaluated)
    && Number.isFinite(expires)
    && observed <= evaluated
    && evaluated <= expires;
}

function refuse(message: string, details: Record<string, unknown> = {}): never {
  throw new SemctxError("CONTROL_INPUTS_UNSAFE", message, details);
}

function refuseAttestation(): never {
  throw new SemctxError("CONTROL_INPUTS_UNSAFE", "ATTESTATION_UNBOUND");
}

type AcceptedTargetWriteTestStage =
  | "after_link_before_identity"
  | "before_post_write_validation";

let acceptedTargetWriteTestHook:
  | ((stage: AcceptedTargetWriteTestStage, path: string) => void)
  | undefined;

/** Internal test seam; intentionally absent from the package public index. */
export function setAcceptedTargetWriteTestHookForTesting(
  hook: typeof acceptedTargetWriteTestHook,
): void {
  acceptedTargetWriteTestHook = hook;
}

function runAcceptedTargetWriteTestHook(stage: AcceptedTargetWriteTestStage, path: string): void {
  acceptedTargetWriteTestHook?.(stage, path);
}
