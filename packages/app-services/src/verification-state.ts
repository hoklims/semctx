import { createHash, type Hash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { resolve } from "node:path";
import { SemctxError } from "@semantic-context/core";

export interface VerificationGitState {
  headCommit: string;
  analyzedSourceHash: string;
  workingStateHash: string;
  contentStateHash: string;
  repositoryStateHash: string;
  indexStateHash: string;
  headTreeHash: string;
}

/** The persisted version 3 baseline written by `verify diff --record`, `index --record` and `verify hook pre-commit`. */
export interface VerificationStateV3 extends VerificationGitState {
  version: 3;
  verdict: "PASS" | "WARN" | "BLOCK";
  recordedAt: string;
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Shape-validate a persisted baseline. Legacy versions, malformed and authored shapes are `null`, never partially trusted. */
export function parseVerificationStateV3(value: unknown): VerificationStateV3 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const state = value as Partial<VerificationStateV3>;
  const valid = state.version === 3
    && typeof state.headCommit === "string"
    && /^[0-9a-f]{40,64}$/.test(state.headCommit)
    && typeof state.analyzedSourceHash === "string"
    && SHA256_DIGEST.test(state.analyzedSourceHash)
    && typeof state.workingStateHash === "string"
    && SHA256_DIGEST.test(state.workingStateHash)
    && typeof state.contentStateHash === "string"
    && SHA256_DIGEST.test(state.contentStateHash)
    && typeof state.repositoryStateHash === "string"
    && SHA256_DIGEST.test(state.repositoryStateHash)
    && typeof state.indexStateHash === "string"
    && SHA256_DIGEST.test(state.indexStateHash)
    && typeof state.headTreeHash === "string"
    && SHA256_DIGEST.test(state.headTreeHash)
    && (state.verdict === "PASS" || state.verdict === "WARN" || state.verdict === "BLOCK")
    && typeof state.recordedAt === "string"
    && Number.isFinite(Date.parse(state.recordedAt));
  return valid ? (state as VerificationStateV3) : null;
}

interface VerificationGitSnapshot {
  state: VerificationGitState;
  untrackedPaths: string[];
  hiddenTrackedPaths: string[];
}

function git(root: string, args: string[], stdin?: Uint8Array): Uint8Array {
  const process = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    ...(stdin === undefined ? {} : { stdin }),
  });
  if (process.exitCode !== 0) {
    throw new SemctxError("GIT_ERROR", "cannot capture verification source state", {
      command: ["git", ...args],
      stderr: new TextDecoder().decode(process.stderr),
    });
  }
  return process.stdout;
}

interface IndexEntry {
  mode: string;
  objectId: string;
  skipWorktree: boolean;
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function sortedPaths(paths: Iterable<string>): string[] {
  return [...paths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function trackedIndexEntries(root: string): Map<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>();
  const skipWorktree = new Set(
    new TextDecoder().decode(git(root, ["ls-files", "-v", "-z", "--", "."]))
      .split("\0")
      .filter((record) => record.startsWith("S "))
      .map((record) => normalizedPath(record.slice(2))),
  );
  const records = new TextDecoder().decode(git(root, ["ls-files", "--stage", "-z", "--", "."]));
  for (const record of records.split("\0")) {
    if (record.length === 0) continue;
    const match = /^([0-9]{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/.exec(record);
    if (match === null || match[4] === undefined || match[1] === undefined || match[2] === undefined) {
      throw new SemctxError("GIT_ERROR", "cannot capture verification source state: invalid index entry");
    }
    if (match[3] !== "0") {
      throw new SemctxError("GIT_ERROR", "cannot capture verification source state: unmerged index entry", {
        path: match[4],
        stage: match[3],
      });
    }
    const path = normalizedPath(match[4]);
    entries.set(path, { mode: match[1], objectId: match[2], skipWorktree: skipWorktree.has(path) });
  }
  return entries;
}

function objectPayload(root: string, objectId: string): Uint8Array {
  return git(root, ["cat-file", "blob", objectId]);
}

function hashObject(root: string, path: string, payload: Uint8Array): string {
  const objectId = new TextDecoder().decode(
    git(root, ["hash-object", `--path=${path}`, "--stdin"], payload),
  ).trim();
  if (!/^[0-9a-f]{40,64}$/.test(objectId)) {
    throw new SemctxError("GIT_ERROR", "cannot capture verification source state: invalid object id", {
      path,
      objectId,
    });
  }
  return objectId;
}

type GitObjectFormat = "sha1" | "sha256";

function gitObjectFormat(headCommit: string): GitObjectFormat {
  if (headCommit.length === 64) return "sha256";
  if (headCommit.length === 40) return "sha1";
  throw new SemctxError("GIT_ERROR", "cannot determine verification object hash algorithm", { headCommit });
}

/** Compute the Git blob object id locally for payloads whose clean conversion is provably the
 *  identity, avoiding a `git hash-object` subprocess per materialized file. */
function localBlobObjectId(objectFormat: GitObjectFormat, payload: Uint8Array): string {
  const hash = createHash(objectFormat);
  hash.update(`blob ${payload.byteLength}\0`, "utf8");
  hash.update(payload);
  return hash.digest("hex");
}

const VERIFICATION_ATTRIBUTES = ["filter", "ident", "working-tree-encoding"] as const;

interface AttributeSnapshot {
  filter: string;
  ident: string;
  workingTreeEncoding: string;
  explicitTransformer: boolean;
}

function attributeSnapshotIsSafe(snapshot: AttributeSnapshot): boolean {
  return !snapshot.explicitTransformer && snapshot.filter === "unspecified"
    && snapshot.ident === "unspecified" && snapshot.workingTreeEncoding === "unspecified";
}

/** Batch-resolve `filter`/`ident`/`working-tree-encoding` for candidate paths in one `git
 *  check-attr --stdin` call. Every requested path must yield a complete triple; anything else
 *  (malformed output, duplicates, missing records) refuses rather than admitting raw hashing. */
function checkAttrBatch(root: string, paths: readonly string[]): Map<string, AttributeSnapshot> {
  if (paths.length === 0) return new Map();
  const stdin = new TextEncoder().encode(paths.map((path) => `${path}\0`).join(""));
  const raw = new TextDecoder().decode(
    git(root, ["check-attr", "--stdin", "-z", ...VERIFICATION_ATTRIBUTES], stdin),
  );
  if (!raw.endsWith("\0")) {
    throw new SemctxError("GIT_ERROR", "cannot capture verification source state: unterminated check-attr output");
  }
  const expectedPaths = new Set(paths);
  const fields = raw.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  if (fields.length % 3 !== 0) {
    throw new SemctxError("GIT_ERROR", "cannot capture verification source state: malformed check-attr output");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < fields.length; index += 3) {
    const path = fields[index];
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    if (path === undefined || attribute === undefined || value === undefined) {
      throw new SemctxError("GIT_ERROR", "cannot capture verification source state: malformed check-attr output");
    }
    if (!expectedPaths.has(path) || !(VERIFICATION_ATTRIBUTES as readonly string[]).includes(attribute)
      || value.length === 0) {
      throw new SemctxError("GIT_ERROR", "cannot capture verification source state: unexpected check-attr record");
    }
    const key = `${attribute}\0${path}`;
    if (values.has(key)) {
      throw new SemctxError(
        "GIT_ERROR",
        "cannot capture verification source state: duplicate check-attr record",
        { path, attribute },
      );
    }
    values.set(key, value);
  }
  const result = new Map<string, AttributeSnapshot>();
  // Named check-attr output conflates sentinel states with literal values such as filter=unset.
  // --all omits truly unspecified attributes, so explicit transformer values stay on Git's path.
  const allRaw = new TextDecoder().decode(git(root, ["check-attr", "--stdin", "-z", "--all"], stdin));
  if (allRaw.length > 0 && !allRaw.endsWith("\0")) {
    throw new SemctxError("GIT_ERROR", "cannot capture verification source state: unterminated check-attr output");
  }
  const allFields = allRaw.length === 0 ? [] : allRaw.slice(0, -1).split("\0");
  if (allFields.length % 3 !== 0) {
    throw new SemctxError("GIT_ERROR", "cannot capture verification source state: malformed check-attr output");
  }
  const explicitTransformers = new Set<string>();
  const allKeys = new Set<string>();
  for (let index = 0; index < allFields.length; index += 3) {
    const path = allFields[index]!;
    const attribute = allFields[index + 1]!;
    const value = allFields[index + 2]!;
    const key = `${attribute}\0${path}`;
    if (!expectedPaths.has(path) || attribute.length === 0 || value.length === 0 || allKeys.has(key)) {
      throw new SemctxError("GIT_ERROR", "cannot capture verification source state: invalid all-attributes record");
    }
    allKeys.add(key);
    if ((VERIFICATION_ATTRIBUTES as readonly string[]).includes(attribute)) {
      if (values.get(key) !== value) {
        throw new SemctxError("GIT_ERROR", "cannot capture verification source state: attribute metadata changed during capture", { path });
      }
      explicitTransformers.add(path);
    }
  }
  for (const path of paths) {
    const filter = values.get(`filter\0${path}`);
    const ident = values.get(`ident\0${path}`);
    const workingTreeEncoding = values.get(`working-tree-encoding\0${path}`);
    if (filter === undefined || ident === undefined || workingTreeEncoding === undefined) {
      throw new SemctxError(
        "GIT_ERROR",
        "cannot capture verification source state: incomplete check-attr metadata",
        { path },
      );
    }
    result.set(path, { filter, ident, workingTreeEncoding, explicitTransformer: explicitTransformers.has(path) });
  }
  return result;
}

type VerificationAttributeBarrier = () => void;
let verificationAttributeBarrierForTesting: VerificationAttributeBarrier | undefined;

/** One-shot test seam invoked immediately before the reobservation `check-attr` call, so a test
 *  can mutate `.gitattributes` between the two observations without a real concurrent process. */
export function __setVerificationAttributeBarrierForTesting(
  barrier: VerificationAttributeBarrier | undefined,
): void {
  verificationAttributeBarrierForTesting = barrier;
}

function unstagedPaths(root: string): Set<string> {
  const records = new TextDecoder().decode(
    git(root, ["diff", "--name-only", "-z", "--relative", "--no-ext-diff", "--no-textconv", "--", "."]),
  );
  return new Set(records.split("\0").filter((path) => path.length > 0).map(normalizedPath));
}

function captureRepositoryStateHash(
  entries: Iterable<{ path: string; mode: string; objectId: string }>,
): string {
  const ordered = [...entries].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const hash = createHash("sha256");
  frame(hash, "domain", "semctx:verification-repository-state:v1");
  for (const entry of ordered) {
    frame(hash, "path", entry.path);
    frame(hash, "mode", entry.mode);
    frame(hash, "object", entry.objectId);
  }
  return `sha256:${hash.digest("hex")}`;
}

function captureIndexStateHash(tracked: ReadonlyMap<string, IndexEntry>): string {
  return captureRepositoryStateHash([...tracked].map(([path, entry]) => ({ path, ...entry })));
}

function initializedGitlinkHead(root: string, path: string): string | undefined {
  const absolute = resolve(root, path);
  const materialized = lstatIfPresent(absolute);
  if (materialized === undefined) return undefined;
  if (materialized.isSymbolicLink()) {
    throw new SemctxError("GIT_ERROR", "symlinked gitlink verification input is unsupported", { path });
  }
  const gitMarkerPresent = lstatIfPresent(resolve(absolute, ".git")) !== undefined;
  const topLevel = Bun.spawnSync(["git", "-C", path, "rev-parse", "--show-toplevel"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (topLevel.exitCode !== 0) {
    if (gitMarkerPresent) {
      throw new SemctxError("GIT_ERROR", "cannot resolve initialized gitlink repository", { path });
    }
    return undefined;
  }
  if (realpathSync.native(new TextDecoder().decode(topLevel.stdout).trim()) !== realpathSync.native(absolute)) {
    return undefined;
  }
  const process = Bun.spawnSync(["git", "-C", path, "rev-parse", "--verify", "HEAD"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (process.exitCode !== 0) {
    throw new SemctxError("GIT_ERROR", "cannot resolve initialized gitlink HEAD", { path });
  }
  const head = new TextDecoder().decode(process.stdout).trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) {
    throw new SemctxError("GIT_ERROR", "invalid initialized gitlink HEAD", { path, head });
  }
  return head;
}

function captureTreeHash(root: string, revision: string): string {
  const records = new TextDecoder().decode(git(root, ["ls-tree", "-r", "-z", "--full-tree", revision]));
  const entries: Array<{ path: string; mode: string; objectId: string }> = [];
  for (const record of records.split("\0")) {
    if (record.length === 0) continue;
    const match = /^([0-9]{6}) (?:blob|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record);
    if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
      throw new SemctxError("GIT_ERROR", "cannot capture verification source state: invalid tree entry", { revision });
    }
    entries.push({ path: normalizedPath(match[3]), mode: match[1], objectId: match[2] });
  }
  return captureRepositoryStateHash(entries);
}

function captureHeadTreeHash(root: string): string {
  return captureTreeHash(root, "HEAD");
}

/** Canonical repository-state hash of one commit's tree, comparable with a recorded `repositoryStateHash`. */
export function captureCommitTreeHash(root: string, objectId: string): string {
  if (!/^[0-9a-f]{40,64}$/.test(objectId)) {
    throw new SemctxError("GIT_ERROR", "cannot capture a commit tree: invalid object id", { objectId });
  }
  return captureTreeHash(root, objectId);
}

/** Resolve a revision to the full object id Git would record for it. */
export function resolveRevisionObjectId(root: string, revision: string): string {
  const objectId = new TextDecoder().decode(git(root, ["rev-parse", "--verify", revision])).trim();
  if (!/^[0-9a-f]{40,64}$/.test(objectId)) {
    throw new SemctxError("GIT_ERROR", "cannot resolve revision to an object id", { revision, objectId });
  }
  return objectId;
}

function captureContentState(
  root: string,
  objectFormat: GitObjectFormat,
  tracked: ReadonlyMap<string, IndexEntry>,
  untracked: readonly string[],
  changedOutsideIndex: ReadonlySet<string>,
): Pick<VerificationGitState, "contentStateHash" | "repositoryStateHash"> & { hiddenTrackedPaths: string[] } {
  const contentHash = createHash("sha256");
  const repositoryHash = createHash("sha256");
  frame(contentHash, "domain", "semctx:verification-content-state:v1");
  frame(repositoryHash, "domain", "semctx:verification-repository-state:v1");
  const hiddenTrackedPaths: string[] = [];

  const paths = sortedPaths(new Set([...tracked.keys(), ...untracked.map(normalizedPath)]));
  const initialSnapshots = checkAttrBatch(root, paths);
  const fastResolvedPaths: string[] = [];
  for (const path of paths) {
    const indexEntry = tracked.get(path);
    if (indexEntry?.mode === "160000") {
      const materializedHead = initializedGitlinkHead(root, path);
      if (changedOutsideIndex.has(path) || (materializedHead !== undefined && materializedHead !== indexEntry.objectId)) {
        throw new SemctxError("GIT_ERROR", "changed gitlink verification input is unsupported", { path });
      }
      frame(contentHash, "path", path);
      frame(contentHash, "mode", indexEntry.mode);
      frame(contentHash, "gitlink", indexEntry.objectId);
      frame(repositoryHash, "path", path);
      frame(repositoryHash, "mode", indexEntry.mode);
      frame(repositoryHash, "object", indexEntry.objectId);
      continue;
    }

    const absolute = resolve(root, path);
    const stat = lstatIfPresent(absolute);
    if (stat === undefined && !indexEntry?.skipWorktree) {
      if (indexEntry !== undefined && !changedOutsideIndex.has(path)) hiddenTrackedPaths.push(path);
      continue;
    }
    let mode: string;
    let kind: string;
    let payload: Uint8Array;
    if (stat === undefined && indexEntry !== undefined) {
      mode = indexEntry.mode;
      kind = mode === "120000" ? "symlink" : "file";
      payload = objectPayload(root, indexEntry.objectId);
    } else if (indexEntry?.mode === "120000") {
      mode = "120000";
      kind = "symlink";
      payload = stat!.isSymbolicLink()
        ? new TextEncoder().encode(readlinkSync(absolute))
        : readFileSync(absolute);
    } else if (stat!.isSymbolicLink()) {
      mode = "120000";
      kind = "symlink";
      payload = new TextEncoder().encode(readlinkSync(absolute));
    } else if (stat!.isFile()) {
      mode = process.platform === "win32"
        ? indexEntry?.mode === "100755" ? "100755" : "100644"
        : (stat!.mode & 0o111) === 0 ? "100644" : "100755";
      kind = "file";
      payload = readFileSync(absolute);
    } else {
      throw new SemctxError("GIT_ERROR", "unsupported verification input", { path });
    }

    frame(contentHash, "path", path);
    frame(contentHash, "mode", mode);
    frame(contentHash, "kind", kind);
    frame(contentHash, "content", payload);
    let objectId: string;
    if (stat === undefined && indexEntry !== undefined && indexEntry.mode === mode
      && !changedOutsideIndex.has(path)) {
      objectId = indexEntry.objectId;
    } else if (stat?.isFile() && mode !== "120000" && !payload.includes(0x0d)
      && attributeSnapshotIsSafe(initialSnapshots.get(path)!)) {
      objectId = localBlobObjectId(objectFormat, payload);
      fastResolvedPaths.push(path);
    } else {
      objectId = hashObject(root, path, payload);
    }
    if (
      stat !== undefined
      && indexEntry !== undefined
      && (mode !== indexEntry.mode || objectId !== indexEntry.objectId)
      && !changedOutsideIndex.has(path)
    ) {
      hiddenTrackedPaths.push(path);
    }
    frame(repositoryHash, "path", path);
    frame(repositoryHash, "mode", mode);
    frame(repositoryHash, "object", objectId);
  }

  if (fastResolvedPaths.length > 0) {
    const barrier = verificationAttributeBarrierForTesting;
    verificationAttributeBarrierForTesting = undefined;
    barrier?.();
    const reobserved = checkAttrBatch(root, fastResolvedPaths);
    for (const path of fastResolvedPaths) {
      const before = initialSnapshots.get(path)!;
      const after = reobserved.get(path)!;
      if (before.filter !== after.filter || before.ident !== after.ident
        || before.workingTreeEncoding !== after.workingTreeEncoding
        || before.explicitTransformer !== after.explicitTransformer) {
        throw new SemctxError(
          "GIT_ERROR",
          "cannot capture verification source state: attribute metadata changed during capture",
          { path },
        );
      }
    }
  }

  return {
    contentStateHash: `sha256:${contentHash.digest("hex")}`,
    repositoryStateHash: `sha256:${repositoryHash.digest("hex")}`,
    hiddenTrackedPaths,
  };
}

function frame(hash: Hash, label: string, payload: string | Uint8Array): void {
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  hash.update(`${label}\0${bytes.byteLength}\0`, "utf8").update(bytes);
}

/** Bind a verification verdict to the exact resolved HEAD and diff bytes consumed by analysis. */
export function fingerprintVerificationSource(headCommit: string, diff: string | Uint8Array): string {
  const hash = createHash("sha256");
  frame(hash, "domain", "semctx:verification-analyzed-source:v1");
  frame(hash, "head", headCommit);
  frame(hash, "diff", diff);
  return `sha256:${hash.digest("hex")}`;
}

function captureVerificationGitSnapshot(root: string): VerificationGitSnapshot {
  const headCommit = new TextDecoder().decode(git(root, ["rev-parse", "--verify", "HEAD"])).trim();
  if (!/^[0-9a-f]{40,64}$/.test(headCommit)) {
    throw new SemctxError("GIT_ERROR", "cannot capture verification source state: invalid HEAD", { headCommit });
  }

  const diff = git(root, [
    "diff", "HEAD", "--relative", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--", ".",
  ]);
  const analyzedDiff = git(root, [
    "diff", "--relative", "--unified=0", "--no-color", "--no-ext-diff", "--no-textconv", headCommit, "--",
  ]);
  const untracked = new TextDecoder().decode(
    git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]),
  ).split("\0").filter((path) => path.length > 0).map(normalizedPath).sort();
  const hash = createHash("sha256");
  frame(hash, "domain", "semctx:verification-working-state:v1");
  frame(hash, "tracked-diff", diff);
  for (const path of untracked) {
    const absolute = resolve(root, path);
    const stat = lstatSync(absolute);
    frame(hash, "untracked-path", path.replace(/\\/g, "/"));
    if (stat.isSymbolicLink()) {
      frame(hash, "untracked-kind", "symlink");
      frame(hash, "untracked-target", readlinkSync(absolute));
    } else if (stat.isFile()) {
      frame(hash, "untracked-kind", (stat.mode & 0o111) === 0 ? "file:100644" : "file:100755");
      frame(hash, "untracked-content", readFileSync(absolute));
    } else {
      throw new SemctxError("GIT_ERROR", "unsupported untracked verification input", { path });
    }
  }
  const tracked = trackedIndexEntries(root);
  const { hiddenTrackedPaths, ...contentState } = captureContentState(
    root,
    gitObjectFormat(headCommit),
    tracked,
    untracked,
    unstagedPaths(root),
  );
  return {
    state: {
      headCommit,
      analyzedSourceHash: fingerprintVerificationSource(headCommit, new TextDecoder().decode(analyzedDiff)),
      workingStateHash: `sha256:${hash.digest("hex")}`,
      ...contentState,
      indexStateHash: captureIndexStateHash(tracked),
      headTreeHash: captureHeadTreeHash(root),
    },
    untrackedPaths: untracked,
    hiddenTrackedPaths,
  };
}

/** Capture the exact commit plus tracked and non-ignored untracked working bytes verified by the guard. */
export function captureVerificationGitState(root: string): VerificationGitState {
  return captureVerificationGitSnapshot(root).state;
}

/** Capture a state that working-tree verification can authorize without omitting untracked inputs. */
export function captureRecordableVerificationGitState(root: string): VerificationGitState {
  const snapshot = captureVerificationGitSnapshot(root);
  if (snapshot.untrackedPaths.length > 0) {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      "--record refuses non-ignored untracked files because working-tree verification cannot analyze them; add, remove, or ignore them first",
      { untrackedPaths: snapshot.untrackedPaths },
    );
  }
  if (snapshot.hiddenTrackedPaths.length > 0) {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      "--record refuses tracked bytes hidden from the analyzed Git diff; clear assume-unchanged/skip-worktree or restore the indexed content first",
      { hiddenTrackedPaths: snapshot.hiddenTrackedPaths },
    );
  }
  return snapshot.state;
}
