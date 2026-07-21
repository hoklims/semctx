import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  compareIds,
  SemctxError,
  type EvidenceRef,
  type RepositoryGraph,
  type SemctxConfig,
} from "@semantic-context/core";
import {
  serializeControlReport,
  type ControlFreshnessSeal,
  type Sha256Hash,
} from "@semantic-context/control-model";
import type { ChangeContract, SemanticModel, SemanticNode } from "@semantic-context/semantic-model";
import type { DiscoveredFile } from "@semantic-context/ts-analyzer";
import packageJson from "../package.json";

export const CONTROL_INDEX_SNAPSHOT_META_KEY = "control_index_snapshot_v1";
export const CONTROL_FRESHNESS_TOOL_VERSION = `${packageJson.name}@${packageJson.version}`;

export interface GitStateCapture {
  headCommit: string | null;
  workingDiffHash: Sha256Hash | null;
}

export interface IndexedControlSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  repositoryRoot: string;
  headCommit: string | null;
  repositoryGraphHash: Sha256Hash;
  semanticModelHash: Sha256Hash;
  analysisInputHash: Sha256Hash;
  workingDiffHash: Sha256Hash | null;
  storeSchemaVersion: number;
  toolVersion: string;
}

export interface ControlFreshnessSealInput {
  repositoryRoot: string;
  headAtCapture: string | null;
  repositoryGraph: RepositoryGraph;
  semanticModel: SemanticModel;
  analysisInputHash: Sha256Hash;
  workingDiffHash: Sha256Hash | null;
  indexedSnapshot: IndexedControlSnapshot | null;
  storeSchemaVersion: number | null;
  toolVersion?: string;
}

function hash(domain: string, payload: string | Uint8Array): Sha256Hash {
  const digest = createHash("sha256")
    .update(`semctx:${domain}:v1\0`, "utf8")
    .update(payload)
    .digest("hex");
  return `sha256:${digest}`;
}

function normalizeEvidence(evidence: readonly EvidenceRef[]): EvidenceRef[] {
  return [...evidence]
    .map((item) => ({ ...item, filePath: item.filePath.replace(/\\/g, "/") }))
    .sort((a, b) => compareIds(serializeControlReport(a), serializeControlReport(b)));
}

/** Fingerprint the persisted Plane A graph, independent of SQLite row or input array order. */
export function fingerprintRepositoryGraph(graph: RepositoryGraph): Sha256Hash {
  const normalized = {
    nodes: graph.nodes
      .map((node) => ({
        ...node,
        ...(node.filePath !== undefined ? { filePath: node.filePath.replace(/\\/g, "/") } : {}),
        evidence: normalizeEvidence(node.evidence),
        tags: [...node.tags].sort(compareIds),
      }))
      .sort((a, b) => compareIds(a.id, b.id)),
    edges: graph.edges
      .map((edge) => ({ ...edge, evidence: normalizeEvidence(edge.evidence) }))
      .sort((a, b) => compareIds(a.id, b.id)),
  };
  return hash("repository-graph", serializeControlReport(normalized));
}

function normalizeSemanticNode(node: SemanticNode): SemanticNode {
  return {
    ...node,
    sourceRefs: [...node.sourceRefs]
      .map((ref) => ({ ...ref, file: ref.file.replace(/\\/g, "/") }))
      .sort((a, b) => compareIds(a.file, b.file) || a.line - b.line),
    repositoryLinks: [...node.repositoryLinks].sort(
      (a, b) => compareIds(a.kind, b.kind) || compareIds(a.ref, b.ref),
    ),
    relations: [...node.relations].sort(
      (a, b) => compareIds(a.kind, b.kind) || compareIds(a.to, b.to),
    ),
    tags: [...node.tags].sort(compareIds),
  };
}

function normalizeChange(change: ChangeContract): ChangeContract {
  return {
    ...change,
    sourceRefs: [...change.sourceRefs]
      .map((ref) => ({ ...ref, file: ref.file.replace(/\\/g, "/") }))
      .sort((a, b) => compareIds(a.file, b.file) || a.line - b.line),
    serves: [...change.serves].sort(compareIds),
    preserves: [...change.preserves].sort(compareIds),
    requiresEvidence: [...change.requiresEvidence].sort(compareIds),
    openUnknowns: [...change.openUnknowns].sort(compareIds),
    repositoryLinks: [...change.repositoryLinks].sort(
      (a, b) => compareIds(a.kind, b.kind) || compareIds(a.ref, b.ref),
    ),
    tags: [...change.tags].sort(compareIds),
  };
}

/** Fingerprint the full authored Plane B model, including source file/line provenance. */
export function fingerprintSemanticModel(model: SemanticModel): Sha256Hash {
  const normalized = {
    nodes: model.nodes.map(normalizeSemanticNode).sort((a, b) => compareIds(a.id, b.id)),
    changes: model.changes.map(normalizeChange).sort((a, b) => compareIds(a.id, b.id)),
  };
  return hash("semantic-model", serializeControlReport(normalized));
}

/** Fingerprint the exact discovered Plane A contents plus the parsed analyzer configuration. */
export function fingerprintAnalysisInputs(config: SemctxConfig, files: readonly DiscoveredFile[]): Sha256Hash {
  const manifest = {
    config,
    files: files
      .map((file) => ({
        path: file.relPath.replace(/\\/g, "/"),
        role: file.role,
        contentHash: hash("analysis-input-content", file.content),
      }))
      .sort((a, b) => compareIds(a.path, b.path)),
  };
  return hash("analysis-input-manifest", serializeControlReport(manifest));
}

export function canonicalRepositoryRoot(root: string): string {
  return realpathSync.native(resolve(root)).replace(/\\/g, "/");
}

function git(root: string, args: string[]): { code: number; stdout: Uint8Array; stderr: string } {
  const process = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return {
    code: process.exitCode ?? 1,
    stdout: process.stdout,
    stderr: new TextDecoder().decode(process.stderr).trim(),
  };
}

function findGitWorktreeRoot(root: string): string | null {
  let current = realpathSync.native(resolve(root));
  while (true) {
    if (existsSync(resolve(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

interface ResolvedStatusPath {
  absolute: string;
  repositoryRelative: string;
}

function withinRoot(root: string, absolute: string): ResolvedStatusPath | null {
  const repositoryRelative = relative(root, absolute).replace(/\\/g, "/");
  if (repositoryRelative === ".." || repositoryRelative.startsWith("../")) return null;
  return { absolute, repositoryRelative };
}

function resolveStatusPath(root: string, gitRoot: string, path: string): ResolvedStatusPath {
  const gitRelative = withinRoot(root, resolve(gitRoot, path));
  if (gitRelative !== null) return gitRelative;
  const cwdRelative = withinRoot(root, resolve(root, path));
  if (cwdRelative !== null) return cwdRelative;
  throw new SemctxError("GIT_ERROR", "working path escapes the repository root", { path });
}

function isSemctxRuntimeArtifact(path: string): boolean {
  return path === ".semctx/semctx.db"
    || path === ".semctx/semctx.db-shm"
    || path === ".semctx/semctx.db-wal"
    || path === ".semctx/semctx.db-journal";
}

function workingFileState(path: ResolvedStatusPath, untracked: boolean): Record<string, string> {
  const { absolute, repositoryRelative } = path;
  if (!existsSync(absolute)) return { path: repositoryRelative, kind: "missing" };
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    if (untracked) {
      throw new SemctxError("GIT_ERROR", "untracked symlinks are unsupported by the freshness seal", { path });
    }
    return { path: repositoryRelative, kind: "symlink", target: readlinkSync(absolute) };
  }
  if (!stat.isFile()) {
    throw new SemctxError("GIT_ERROR", "non-file working entries are unsupported by the freshness seal", { path });
  }
  return {
    path: repositoryRelative,
    kind: "file",
    mode: (stat.mode & 0o111) === 0 ? "100644" : "100755",
    contentHash: hash("working-file-content", readFileSync(absolute)),
  };
}

interface ParsedStatusEntry {
  record: string;
  path: string;
  originalPath?: string;
  worktreeChanged: boolean;
  untracked: boolean;
}

function parseStatusEntry(parts: string[], index: number): { entry: ParsedStatusEntry; consumed: number } {
  const record = parts[index]!;
  if (record.startsWith("? ")) {
    return { entry: { record, path: record.slice(2), worktreeChanged: true, untracked: true }, consumed: 1 };
  }
  const ordinary = /^1 ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) (.*)$/.exec(record);
  const renamed = /^2 ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) (.*)$/.exec(record);
  const unmerged = /^u ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) (.*)$/.exec(record);
  const match = ordinary ?? renamed ?? unmerged;
  if (match === null) throw new SemctxError("GIT_ERROR", "unsupported Git porcelain status record", { record });
  const xy = match[1]!;
  const submodule = match[2]!;
  if (submodule.startsWith("S")) {
    throw new SemctxError("GIT_ERROR", "Git submodules are unsupported by the control freshness seal", { record });
  }
  const path = match.at(-1)!;
  const consumed = renamed === null ? 1 : 2;
  const originalPath = renamed === null ? undefined : parts[index + 1];
  if (renamed !== null && originalPath === undefined) {
    throw new SemctxError("GIT_ERROR", "rename record is missing its original path", { record });
  }
  return {
    entry: {
      record,
      path,
      ...(originalPath === undefined ? {} : { originalPath }),
      worktreeChanged: xy[1] !== ".",
      untracked: false,
    },
    consumed,
  };
}

/**
 * Capture HEAD plus the complete local delta: tracked index/worktree changes and non-ignored
 * untracked file paths, modes and bytes. Non-Git repositories are represented explicitly by nulls;
 * failures inside a Git repository fail closed instead of hashing an empty diff.
 */
export function captureGitState(root: string): GitStateCapture {
  const repositoryRoot = canonicalRepositoryRoot(root);
  const gitRoot = findGitWorktreeRoot(repositoryRoot);
  const args = ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignore-submodules=none", "--", "."];
  const status = git(root, args);
  if (status.code !== 0) {
    if (gitRoot === null && /not a git repository/i.test(status.stderr)) {
      return { headCommit: null, workingDiffHash: null };
    }
    throw new SemctxError("GIT_ERROR", "cannot capture control freshness: read Git status", {
      command: ["git", ...args],
      stderr: status.stderr,
    });
  }
  if (gitRoot === null) {
    throw new SemctxError("GIT_ERROR", "cannot locate the Git worktree root for freshness capture");
  }
  if (existsSync(resolve(root, ".gitmodules"))) {
    throw new SemctxError("GIT_ERROR", "Git submodules are unsupported by the control freshness seal");
  }

  const parts = new TextDecoder().decode(status.stdout).split("\0").filter((part) => part.length > 0);
  const headLine = parts.find((part) => part.startsWith("# branch.oid "));
  if (headLine === undefined) {
    throw new SemctxError("GIT_ERROR", "Git status did not report branch.oid");
  }
  const oid = headLine.slice("# branch.oid ".length);
  const headCommit = oid === "(initial)" ? null : oid;
  if (headCommit !== null && !/^[0-9a-f]+$/.test(headCommit)) {
    throw new SemctxError("GIT_ERROR", "Git status reported an invalid HEAD object id", { oid });
  }

  const entries: Array<{ record: string; workingFile: Record<string, string> | null }> = [];
  for (let index = 0; index < parts.length;) {
    const part = parts[index]!;
    if (part.startsWith("# ")) {
      index += 1;
      continue;
    }
    const parsed = parseStatusEntry(parts, index);
    const currentPath = resolveStatusPath(repositoryRoot, gitRoot, parsed.entry.path);
    const originalPath = parsed.entry.originalPath === undefined
      ? undefined
      : resolveStatusPath(repositoryRoot, gitRoot, parsed.entry.originalPath);
    if (
      isSemctxRuntimeArtifact(currentPath.repositoryRelative)
      && (originalPath === undefined || isSemctxRuntimeArtifact(originalPath.repositoryRelative))
    ) {
      index += parsed.consumed;
      continue;
    }
    const recordPrefix = parsed.entry.record.slice(0, -parsed.entry.path.length);
    entries.push({
      record: `${recordPrefix}${currentPath.repositoryRelative}${originalPath === undefined ? "" : `\0${originalPath.repositoryRelative}`}`,
      workingFile: parsed.entry.worktreeChanged
        ? workingFileState(currentPath, parsed.entry.untracked)
        : null,
    });
    index += parsed.consumed;
  }
  entries.sort((a, b) => compareIds(a.record, b.record));
  return {
    headCommit,
    workingDiffHash: hash("working-diff", serializeControlReport({ entries })),
  };
}

export function parseIndexedControlSnapshot(value: string | undefined): IndexedControlSnapshot | null {
  if (value === undefined || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value) as Partial<IndexedControlSnapshot>;
    const isHash = (candidate: unknown): candidate is Sha256Hash =>
      typeof candidate === "string" && /^sha256:[0-9a-f]{64}$/.test(candidate);
    if (
      parsed.schemaVersion !== 1
      || typeof parsed.capturedAt !== "string"
      || !Number.isFinite(Date.parse(parsed.capturedAt))
      || typeof parsed.repositoryRoot !== "string"
      || parsed.repositoryRoot.length === 0
      || (parsed.headCommit !== null && typeof parsed.headCommit !== "string")
      || !isHash(parsed.repositoryGraphHash)
      || !isHash(parsed.semanticModelHash)
      || !isHash(parsed.analysisInputHash)
      || (parsed.workingDiffHash !== null && !isHash(parsed.workingDiffHash))
      || !Number.isSafeInteger(parsed.storeSchemaVersion)
      || (parsed.storeSchemaVersion ?? -1) < 0
      || typeof parsed.toolVersion !== "string"
      || parsed.toolVersion.length === 0
    ) {
      throw new Error("invalid control index snapshot");
    }
    return parsed as IndexedControlSnapshot;
  } catch (error) {
    throw new SemctxError("STORE_ERROR", "invalid persisted control index snapshot", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Build a local, deterministic attestation. This does not assign a freshness verdict. */
export function buildControlFreshnessSeal(input: ControlFreshnessSealInput): ControlFreshnessSeal {
  const indexed = input.indexedSnapshot;
  const payload = {
    sealSchemaVersion: 1 as const,
    kind: "control_freshness_seal" as const,
    algorithm: "sha256-v1" as const,
    repositoryRoot: input.repositoryRoot,
    indexedRepositoryRoot: indexed?.repositoryRoot ?? null,
    headAtCapture: input.headAtCapture,
    indexedHeadCommit: indexed?.headCommit ?? null,
    repositoryGraphHash: fingerprintRepositoryGraph(input.repositoryGraph),
    indexedRepositoryGraphHash: indexed?.repositoryGraphHash ?? null,
    semanticModelHash: fingerprintSemanticModel(input.semanticModel),
    indexedSemanticModelHash: indexed?.semanticModelHash ?? null,
    analysisInputHash: input.analysisInputHash,
    indexedAnalysisInputHash: indexed?.analysisInputHash ?? null,
    workingDiffHash: input.workingDiffHash,
    indexedWorkingDiffHash: indexed?.workingDiffHash ?? null,
    indexedAt: indexed?.capturedAt ?? null,
    storeSchemaVersion: input.storeSchemaVersion,
    indexedStoreSchemaVersion: indexed?.storeSchemaVersion ?? null,
    toolVersion: input.toolVersion ?? CONTROL_FRESHNESS_TOOL_VERSION,
    indexedToolVersion: indexed?.toolVersion ?? null,
  };
  return { ...payload, sealHash: hash("control-freshness-seal", serializeControlReport(payload)) };
}
