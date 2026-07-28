import { lstat, readFile, readdir } from "node:fs/promises";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, isAbsolute, parse, resolve, sep } from "node:path";

export type WorkspaceEvidenceValue = string | readonly string[];

export interface WorkspaceManifestEvidence {
  readonly manifestPath: string;
  readonly field: string;
  readonly value: WorkspaceEvidenceValue;
}

export interface WorkspaceCandidate {
  readonly root: string;
  readonly identity: string;
  readonly parentRoot?: string;
  readonly evidence: readonly WorkspaceManifestEvidence[];
}

export interface WorkspaceArtifact {
  readonly id: string;
  readonly kind: "module" | "test" | "document" | "migration";
  readonly filePath: string;
}

export interface WorkspaceNode {
  readonly id: string;
  readonly kind: "package";
  readonly root: string;
  readonly identity: string;
  readonly evidence: readonly WorkspaceManifestEvidence[];
}

export interface WorkspaceEdge {
  readonly id: string;
  readonly kind: "contained_in_workspace" | "workspace_member_of";
  readonly from: string;
  readonly to: string;
  readonly evidence: readonly WorkspaceManifestEvidence[];
}

export interface WorkspaceDiagnostic {
  readonly code: "AMBIGUOUS_LAYOUT";
  readonly message: string;
  readonly roots: readonly string[];
  readonly evidence: readonly WorkspaceManifestEvidence[];
}

export interface WorkspaceLayoutCandidate {
  readonly root: string;
  readonly reason: "conventional-directory";
}

export interface WorkspaceProjection {
  readonly schemaVersion: 1;
  readonly repositoryId: string;
  readonly nodes: readonly WorkspaceNode[];
  readonly edges: readonly WorkspaceEdge[];
  readonly candidates: readonly WorkspaceLayoutCandidate[];
  readonly diagnostics: readonly WorkspaceDiagnostic[];
}

export interface AnalyzeWorkspaceInput {
  readonly repositoryRoot: string;
  readonly repositoryId?: string;
  readonly artifacts?: readonly WorkspaceArtifact[];
}

export interface ProjectWorkspaceCandidatesInput {
  readonly repositoryId?: string;
  readonly candidates: readonly WorkspaceCandidate[];
  readonly artifacts?: readonly WorkspaceArtifact[];
  readonly layoutCandidates?: readonly WorkspaceLayoutCandidate[];
  readonly diagnostics?: readonly WorkspaceDiagnostic[];
}

interface DirectoryRecord {
  readonly root: string;
  readonly safe: boolean;
}

interface ManifestRecord {
  readonly root: string;
  readonly path: string;
  readonly kind: "package-json" | "pyproject";
  readonly identity?: string;
  readonly members: readonly string[];
  readonly memberField: string;
}

const ROOT = ".";
const PACKAGE_MANIFEST = "package.json";
const PYTHON_MANIFEST = "pyproject.toml";

export async function analyzeWorkspace(input: AnalyzeWorkspaceInput): Promise<WorkspaceProjection> {
  const repositoryId = input.repositoryId ?? "repository";
  const repositoryRoot = resolve(input.repositoryRoot);
  const diagnostics: WorkspaceDiagnostic[] = [];

  if (!(await isSafeWorkspaceRoot(repositoryRoot, ROOT))) {
    return emptyProjection(repositoryId, [{
      code: "AMBIGUOUS_LAYOUT",
      message: "The repository root is symlinked or resolves through a reparse point.",
      roots: [ROOT],
      evidence: [],
    }]);
  }

  const { directories, layoutCandidates, manifests, malformedRoots } =
    await inspectRepository(repositoryRoot, diagnostics);
  const candidates: WorkspaceCandidate[] = [];
  const identitiesByRoot = new Map<string, string[]>();

  for (const manifest of manifests) {
    if (manifest.identity !== undefined) {
      candidates.push(intrinsicManifestCandidate(manifest));
      const identities = identitiesByRoot.get(manifest.root) ?? [];
      identities.push(manifest.identity);
      identitiesByRoot.set(manifest.root, identities);
    }
  }

  for (const manifest of manifests) {
    for (const [index, pattern] of manifest.members.entries()) {
      const evidence = workspaceDeclarationEvidence(manifest, index, pattern);
      const matched = matchDeclaredRoots(pattern, manifest.root, directories);
      if (matched.error !== undefined) {
        diagnostics.push({
          code: "AMBIGUOUS_LAYOUT",
          message: matched.error,
          roots: [pattern],
          evidence: [evidence],
        });
        continue;
      }
      for (const directory of matched.roots) {
        if (!directory.safe || !(await isSafeWorkspaceRoot(repositoryRoot, directory.root))) {
          diagnostics.push({
            code: "AMBIGUOUS_LAYOUT",
            message: `Declared workspace root '${directory.root}' is symlinked or reparse-backed.`,
            roots: [directory.root],
            evidence: [evidence],
          });
          malformedRoots.add(directory.root);
          continue;
        }
        candidates.push(declaredWorkspaceCandidate(
          manifest,
          directory.root,
          identitiesByRoot,
          evidence,
        ));
      }
    }
  }

  const filteredCandidates = candidates.filter((candidate) => !malformedRoots.has(candidate.root));
  return projectWorkspaceCandidates({
    repositoryId,
    candidates: filteredCandidates,
    artifacts: input.artifacts ?? [],
    layoutCandidates,
    diagnostics,
  });
}

export function analyzeWorkspaceSync(input: AnalyzeWorkspaceInput): WorkspaceProjection {
  const repositoryId = input.repositoryId ?? "repository";
  const repositoryRoot = resolve(input.repositoryRoot);
  const diagnostics: WorkspaceDiagnostic[] = [];

  if (!isSafeWorkspaceRootSync(repositoryRoot, ROOT)) {
    return emptyProjection(repositoryId, [{
      code: "AMBIGUOUS_LAYOUT",
      message: "The repository root is symlinked or resolves through a reparse point.",
      roots: [ROOT],
      evidence: [],
    }]);
  }

  const { directories, layoutCandidates, manifests, malformedRoots } =
    inspectRepositorySync(repositoryRoot, diagnostics);
  const candidates: WorkspaceCandidate[] = [];
  const identitiesByRoot = new Map<string, string[]>();

  for (const manifest of manifests) {
    if (manifest.identity !== undefined) {
      candidates.push(intrinsicManifestCandidate(manifest));
      const identities = identitiesByRoot.get(manifest.root) ?? [];
      identities.push(manifest.identity);
      identitiesByRoot.set(manifest.root, identities);
    }
  }

  for (const manifest of manifests) {
    for (const [index, pattern] of manifest.members.entries()) {
      const evidence = workspaceDeclarationEvidence(manifest, index, pattern);
      const matched = matchDeclaredRoots(pattern, manifest.root, directories);
      if (matched.error !== undefined) {
        diagnostics.push({
          code: "AMBIGUOUS_LAYOUT",
          message: matched.error,
          roots: [pattern],
          evidence: [evidence],
        });
        continue;
      }
      for (const directory of matched.roots) {
        if (!directory.safe || !isSafeWorkspaceRootSync(repositoryRoot, directory.root)) {
          diagnostics.push({
            code: "AMBIGUOUS_LAYOUT",
            message: `Declared workspace root '${directory.root}' is symlinked or reparse-backed.`,
            roots: [directory.root],
            evidence: [evidence],
          });
          malformedRoots.add(directory.root);
          continue;
        }
        candidates.push(declaredWorkspaceCandidate(
          manifest,
          directory.root,
          identitiesByRoot,
          evidence,
        ));
      }
    }
  }

  return projectWorkspaceCandidates({
    repositoryId,
    candidates: candidates.filter((candidate) => !malformedRoots.has(candidate.root)),
    artifacts: input.artifacts ?? [],
    layoutCandidates,
    diagnostics,
  });
}

export function projectWorkspaceCandidates(
  input: ProjectWorkspaceCandidatesInput,
): WorkspaceProjection {
  const repositoryId = input.repositoryId ?? "repository";
  const diagnostics = [...(input.diagnostics ?? [])];
  const normalized: WorkspaceCandidate[] = [];
  for (const candidate of input.candidates) {
    const root = normalizeRelativePath(candidate.root);
    const parentRoot = candidate.parentRoot === undefined
      ? undefined
      : normalizeRelativePath(candidate.parentRoot);
    if (
      root === undefined
      || (candidate.parentRoot !== undefined && parentRoot === undefined)
      || candidate.identity.trim().length === 0
    ) {
      diagnostics.push(ambiguous(
        [candidate.root, ...(candidate.parentRoot === undefined ? [] : [candidate.parentRoot])],
        `Workspace candidate '${candidate.root}' has an escaping root, parent, or empty identity.`,
        candidate.evidence,
      ));
      continue;
    }
    normalized.push({
      root,
      identity: candidate.identity.trim(),
      ...(parentRoot === undefined ? {} : { parentRoot }),
      evidence: sortEvidence(candidate.evidence),
    });
  }
  normalized.sort(compareCandidates);
  const invalidRoots = new Set<string>();
  const groups = groupBy(normalized, (candidate) => candidate.root);
  const merged = new Map<string, WorkspaceCandidate>();
  const normalizedRoots = unique(normalized.map((candidate) => candidate.root));
  const noParent = "\u0000no-parent";

  for (const [root, candidates] of [...groups.entries()].sort(([left], [right]) => compareText(left, right))) {
    const identities = unique(candidates.map((candidate) => candidate.identity));
    const effectiveParents = unique(candidates.map((candidate) =>
      candidate.parentRoot
      ?? nearestAncestor(root, normalizedRoots)
      ?? noParent));
    if (identities.length !== 1 || effectiveParents.length > 1) {
      invalidRoots.add(root);
      diagnostics.push(ambiguous(
        [root],
        `Workspace evidence at '${root}' disagrees on identity or parent.`,
        candidates.flatMap((candidate) => candidate.evidence),
      ));
      continue;
    }
    merged.set(root, {
      root,
      identity: identities[0]!,
      ...(effectiveParents[0] === noParent ? {} : { parentRoot: effectiveParents[0] }),
      evidence: sortEvidence(candidates.flatMap((candidate) => candidate.evidence)),
    });
  }

  const identityRoots = groupBy([...merged.values()], (candidate) => candidate.identity);
  for (const candidates of identityRoots.values()) {
    const roots = unique(candidates.map((candidate) => candidate.root));
    if (roots.length <= 1) continue;
    roots.forEach((root) => invalidRoots.add(root));
    diagnostics.push(ambiguous(
      roots,
      `Workspace identity '${candidates[0]!.identity}' is claimed at multiple roots.`,
      candidates.flatMap((candidate) => candidate.evidence),
    ));
  }

  for (const root of invalidRoots) merged.delete(root);

  const resolvedParents = new Map<string, string | undefined>();
  for (const candidate of merged.values()) {
    const parent = candidate.parentRoot ?? nearestAncestor(candidate.root, merged.keys());
    if (parent !== undefined && !merged.has(parent)) {
      invalidRoots.add(candidate.root);
      diagnostics.push(ambiguous(
        [candidate.root, parent],
        `Workspace '${candidate.root}' names an unadmitted parent '${parent}'.`,
        candidate.evidence,
      ));
      continue;
    }
    resolvedParents.set(candidate.root, parent);
  }
  for (const root of invalidRoots) {
    merged.delete(root);
    resolvedParents.delete(root);
  }

  const cyclicRoots = findCyclicRoots(resolvedParents);
  if (cyclicRoots.length > 0) {
    diagnostics.push(ambiguous(
      cyclicRoots,
      "Workspace parent links form a cycle.",
      cyclicRoots.flatMap((root) => merged.get(root)?.evidence ?? []),
    ));
    for (const root of cyclicRoots) {
      merged.delete(root);
      resolvedParents.delete(root);
    }
  }
  pruneOrphanedCandidates(merged, resolvedParents, diagnostics);

  const nodes = [...merged.values()]
    .map<WorkspaceNode>((candidate) => ({
      id: workspaceId(candidate.root),
      kind: "package",
      root: candidate.root,
      identity: candidate.identity,
      evidence: candidate.evidence,
    }))
    .sort((left, right) => compareText(left.root, right.root));

  const edges: WorkspaceEdge[] = [];
  for (const node of nodes) {
    const parent = resolvedParents.get(node.root);
    edges.push({
      id: edgeId("workspace_member_of", node.id, parent === undefined ? repositoryId : workspaceId(parent)),
      kind: "workspace_member_of",
      from: node.id,
      to: parent === undefined ? repositoryId : workspaceId(parent),
      evidence: node.evidence,
    });
  }

  for (const artifact of [...(input.artifacts ?? [])].sort((left, right) => compareText(left.id, right.id))) {
    const artifactPath = normalizeRelativePath(artifact.filePath);
    if (artifactPath === undefined) {
      diagnostics.push(ambiguous(
        [artifact.filePath],
        `Artifact path '${artifact.filePath}' is external or escapes the repository.`,
        [],
      ));
      continue;
    }
    const owner = mostSpecificOwner(artifactPath, nodes);
    if (owner === undefined) continue;
    edges.push({
      id: edgeId("contained_in_workspace", artifact.id, owner.id),
      kind: "contained_in_workspace",
      from: artifact.id,
      to: owner.id,
      evidence: owner.evidence,
    });
  }

  edges.sort(compareEdges);
  diagnostics.sort(compareDiagnostics);

  return {
    schemaVersion: 1,
    repositoryId,
    nodes,
    edges,
    candidates: [...(input.layoutCandidates ?? [])].sort((left, right) => compareText(left.root, right.root)),
    diagnostics,
  };
}

async function inspectRepository(
  repositoryRoot: string,
  diagnostics: WorkspaceDiagnostic[],
): Promise<{
  directories: readonly DirectoryRecord[];
  layoutCandidates: readonly WorkspaceLayoutCandidate[];
  manifests: readonly ManifestRecord[];
  malformedRoots: Set<string>;
}> {
  const directories: DirectoryRecord[] = [{ root: ROOT, safe: true }];
  const layoutCandidates: WorkspaceLayoutCandidate[] = [];
  const manifests: ManifestRecord[] = [];
  const malformedRoots = new Set<string>();
  const pending = [ROOT];

  while (pending.length > 0) {
    const current = pending.shift()!;
    const absolute = current === ROOT ? repositoryRoot : resolve(repositoryRoot, ...current.split("/"));
    const entries = (await readdir(absolute, { withFileTypes: true }))
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const child = current === ROOT ? entry.name : `${current}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        directories.push({ root: child, safe: false });
        continue;
      }
      if (entry.isDirectory()) {
        directories.push({ root: child, safe: true });
        pending.push(child);
        if (isConventionalCandidate(child)) {
          layoutCandidates.push({ root: child, reason: "conventional-directory" });
        }
      }
    }
  }

  for (const directory of directories.filter((item) => item.safe)) {
    const absolute = directory.root === ROOT
      ? repositoryRoot
      : resolve(repositoryRoot, ...directory.root.split("/"));
    for (const manifestName of [PACKAGE_MANIFEST, PYTHON_MANIFEST] as const) {
      const manifestPath = directory.root === ROOT ? manifestName : `${directory.root}/${manifestName}`;
      const manifestAbsolute = resolve(absolute, manifestName);
      let source: string;
      try {
        const stat = await lstat(manifestAbsolute);
        if (
          stat.isSymbolicLink()
          || !stat.isFile()
          || !(await isSafeAbsolutePath(manifestAbsolute))
        ) {
          malformedRoots.add(directory.root);
          diagnostics.push({
            code: "AMBIGUOUS_LAYOUT",
            message: `Workspace manifest '${manifestPath}' is not a contained regular file.`,
            roots: [directory.root],
            evidence: [{ manifestPath, field: "$path", value: "unsafe-file-identity" }],
          });
          continue;
        }
        source = await readFile(manifestAbsolute, "utf8");
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      try {
        manifests.push(manifestName === PACKAGE_MANIFEST
          ? parsePackageManifest(directory.root, manifestPath, source)
          : parsePyproject(directory.root, manifestPath, source));
      } catch {
        malformedRoots.add(directory.root);
        diagnostics.push({
          code: "AMBIGUOUS_LAYOUT",
          message: `Malformed workspace manifest '${manifestPath}'.`,
          roots: [directory.root],
          evidence: [{ manifestPath, field: "$", value: source }],
        });
      }
    }
  }

  return { directories, layoutCandidates, manifests, malformedRoots };
}

function inspectRepositorySync(
  repositoryRoot: string,
  diagnostics: WorkspaceDiagnostic[],
): {
  directories: readonly DirectoryRecord[];
  layoutCandidates: readonly WorkspaceLayoutCandidate[];
  manifests: readonly ManifestRecord[];
  malformedRoots: Set<string>;
} {
  const directories: DirectoryRecord[] = [{ root: ROOT, safe: true }];
  const layoutCandidates: WorkspaceLayoutCandidate[] = [];
  const manifests: ManifestRecord[] = [];
  const malformedRoots = new Set<string>();
  const pending = [ROOT];

  while (pending.length > 0) {
    const current = pending.shift()!;
    const absolute = current === ROOT ? repositoryRoot : resolve(repositoryRoot, ...current.split("/"));
    const entries = readdirSync(absolute, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const child = current === ROOT ? entry.name : `${current}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        directories.push({ root: child, safe: false });
        continue;
      }
      if (entry.isDirectory()) {
        directories.push({ root: child, safe: true });
        pending.push(child);
        if (isConventionalCandidate(child)) {
          layoutCandidates.push({ root: child, reason: "conventional-directory" });
        }
      }
    }
  }

  for (const directory of directories.filter((item) => item.safe)) {
    const absolute = directory.root === ROOT
      ? repositoryRoot
      : resolve(repositoryRoot, ...directory.root.split("/"));
    for (const manifestName of [PACKAGE_MANIFEST, PYTHON_MANIFEST] as const) {
      const manifestPath = directory.root === ROOT ? manifestName : `${directory.root}/${manifestName}`;
      const manifestAbsolute = resolve(absolute, manifestName);
      let source: string;
      try {
        const stat = lstatSync(manifestAbsolute);
        if (
          stat.isSymbolicLink()
          || !stat.isFile()
          || !isSafeAbsolutePathSync(manifestAbsolute)
        ) {
          malformedRoots.add(directory.root);
          diagnostics.push({
            code: "AMBIGUOUS_LAYOUT",
            message: `Workspace manifest '${manifestPath}' is not a contained regular file.`,
            roots: [directory.root],
            evidence: [{ manifestPath, field: "$path", value: "unsafe-file-identity" }],
          });
          continue;
        }
        source = readFileSync(manifestAbsolute, "utf8");
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      try {
        manifests.push(manifestName === PACKAGE_MANIFEST
          ? parsePackageManifest(directory.root, manifestPath, source)
          : parsePyproject(directory.root, manifestPath, source));
      } catch {
        malformedRoots.add(directory.root);
        diagnostics.push({
          code: "AMBIGUOUS_LAYOUT",
          message: `Malformed workspace manifest '${manifestPath}'.`,
          roots: [directory.root],
          evidence: [{ manifestPath, field: "$", value: source }],
        });
      }
    }
  }

  return { directories, layoutCandidates, manifests, malformedRoots };
}

function intrinsicManifestCandidate(manifest: ManifestRecord): WorkspaceCandidate {
  if (manifest.identity === undefined) {
    throw new Error("Cannot create an intrinsic candidate without a manifest identity.");
  }
  return {
    root: manifest.root,
    identity: manifest.identity,
    evidence: [{
      manifestPath: manifest.path,
      field: manifest.kind === "pyproject" ? "project.name" : "name",
      value: manifest.identity,
    }],
  };
}

function workspaceDeclarationEvidence(
  manifest: ManifestRecord,
  index: number,
  pattern: string,
): WorkspaceManifestEvidence {
  return {
    manifestPath: manifest.path,
    field: `${manifest.memberField}[${index}]`,
    value: pattern,
  };
}

function declaredWorkspaceCandidate(
  manifest: ManifestRecord,
  root: string,
  identitiesByRoot: ReadonlyMap<string, readonly string[]>,
  evidence: WorkspaceManifestEvidence,
): WorkspaceCandidate {
  const declaredIdentities = unique(identitiesByRoot.get(root) ?? []);
  return {
    root,
    identity: declaredIdentities.length === 1
      ? declaredIdentities[0]!
      : workspaceBasename(root),
    parentRoot: manifest.identity === undefined ? undefined : manifest.root,
    evidence: [evidence],
  };
}

function parsePackageManifest(root: string, path: string, source: string): ManifestRecord {
  const parsed = JSON.parse(source) as unknown;
  if (!isRecord(parsed)) throw new Error("package.json must contain an object");
  const identity = readOptionalIdentity(parsed.name);
  const rawWorkspaces = parsed.workspaces;
  let members: readonly string[] = [];
  if (rawWorkspaces !== undefined) {
    const value = Array.isArray(rawWorkspaces)
      ? rawWorkspaces
      : isRecord(rawWorkspaces) ? rawWorkspaces.packages : undefined;
    if (!Array.isArray(value) || !value.every((member) => typeof member === "string")) {
      throw new Error("workspaces must contain strings");
    }
    members = value;
  }
  return {
    root,
    path,
    kind: "package-json",
    identity,
    members,
    memberField: isRecord(rawWorkspaces) ? "workspaces.packages" : "workspaces",
  };
}

function parsePyproject(root: string, path: string, source: string): ManifestRecord {
  const project = tomlSection(source, "project");
  const uvWorkspace = tomlSection(source, "tool.uv.workspace");
  const nameMatch = project.match(/^\s*name\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m);
  const hasNameAssignment = /^\s*name\s*=/m.test(project);
  if (hasNameAssignment && nameMatch === null) throw new Error("invalid project.name");
  const membersAssignment = uvWorkspace.match(/^\s*members\s*=\s*(\[[\s\S]*?\])\s*(?:#.*)?$/m);
  const hasMembersAssignment = /^\s*members\s*=/m.test(uvWorkspace);
  if (hasMembersAssignment && membersAssignment === null) throw new Error("invalid uv members");
  const members = membersAssignment === null ? [] : parseTomlStringArray(membersAssignment[1]!);
  return {
    root,
    path,
    kind: "pyproject",
    ...(nameMatch?.[1] === undefined ? {} : { identity: nameMatch[1] }),
    members,
    memberField: "tool.uv.workspace.members",
  };
}

function tomlSection(source: string, name: string): string {
  const lines = source.split(/\r?\n/);
  const content: string[] = [];
  let active = false;
  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)?.[1];
    if (section !== undefined) {
      if (active) break;
      active = section === name;
      continue;
    }
    if (active) content.push(line);
  }
  return content.join("\n");
}

function parseTomlStringArray(source: string): readonly string[] {
  const withoutStrings = source.replace(/["'][^"']*["']/g, "");
  if (!/^\s*\[\s*(?:,\s*)*\]\s*$/.test(withoutStrings)) {
    throw new Error("members contains a non-string value");
  }
  return [...source.matchAll(/["']([^"']*)["']/g)].map((match) => match[1]!);
}

function matchDeclaredRoots(
  pattern: string,
  declaringRoot: string,
  directories: readonly DirectoryRecord[],
): { readonly roots: readonly DirectoryRecord[]; readonly error?: string } {
  const normalizedPattern = pattern.replaceAll("\\", "/");
  if (
    normalizedPattern.length === 0
    || isAbsolute(pattern)
    || /^[A-Za-z]:\//.test(normalizedPattern)
    || normalizedPattern.split("/").includes("..")
  ) {
    return {
      roots: [],
      error: `Workspace declaration '${pattern}' is external or escapes the repository.`,
    };
  }
  const combined = declaringRoot === ROOT ? normalizedPattern : `${declaringRoot}/${normalizedPattern}`;
  const normalized = normalizeRelativePath(combined);
  if (normalized === undefined) {
    return {
      roots: [],
      error: `Workspace declaration '${pattern}' is external or escapes the repository.`,
    };
  }
  const expression = globExpression(normalized);
  return { roots: directories.filter((directory) => expression.test(directory.root)) };
}

function globExpression(pattern: string): RegExp {
  let result = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        result += ".*";
        index += 1;
      } else {
        result += "[^/]*";
      }
    } else if (character === "?") {
      result += "[^/]";
    } else {
      result += escapeRegExp(character);
    }
  }
  return new RegExp(`${result}$`);
}

async function isSafeWorkspaceRoot(repositoryRoot: string, root: string): Promise<boolean> {
  const parts = root === ROOT ? [] : root.split("/");
  const workspaceRoot = resolve(repositoryRoot, ...parts);
  return isSafeAbsolutePath(workspaceRoot);
}

function isSafeWorkspaceRootSync(repositoryRoot: string, root: string): boolean {
  const parts = root === ROOT ? [] : root.split("/");
  const workspaceRoot = resolve(repositoryRoot, ...parts);
  return isSafeAbsolutePathSync(workspaceRoot);
}

async function isSafeAbsolutePath(path: string): Promise<boolean> {
  for (const component of absolutePathComponents(path)) {
    const stat = await lstat(component);
    if (stat.isSymbolicLink()) return false;
  }
  return true;
}

function isSafeAbsolutePathSync(path: string): boolean {
  for (const component of absolutePathComponents(path)) {
    const stat = lstatSync(component);
    if (stat.isSymbolicLink()) return false;
  }
  return true;
}

function absolutePathComponents(path: string): readonly string[] {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const components: string[] = [];
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    components.push(current);
  }
  return components;
}

function normalizeRelativePath(path: string): string | undefined {
  const slashed = path.replaceAll("\\", "/");
  if (slashed === "" || slashed === ROOT) return ROOT;
  if (isAbsolute(path) || /^[A-Za-z]:\//.test(slashed)) return undefined;
  const stack: string[] = [];
  for (const part of slashed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return undefined;
    stack.push(part);
  }
  return stack.length === 0 ? ROOT : stack.join("/");
}

function nearestAncestor(root: string, candidates: Iterable<string>): string | undefined {
  return [...candidates]
    .filter((candidate) => candidate !== root && containsPath(candidate, root))
    .sort((left, right) => pathDepth(right) - pathDepth(left) || compareText(left, right))[0];
}

function mostSpecificOwner(path: string, nodes: readonly WorkspaceNode[]): WorkspaceNode | undefined {
  return nodes
    .filter((node) => containsPath(node.root, path))
    .sort((left, right) => pathDepth(right.root) - pathDepth(left.root) || compareText(left.root, right.root))[0];
}

function containsPath(root: string, path: string): boolean {
  return root === ROOT || path === root || path.startsWith(`${root}/`);
}

function findCyclicRoots(parents: ReadonlyMap<string, string | undefined>): readonly string[] {
  const cyclic = new Set<string>();
  for (const start of parents.keys()) {
    const order: string[] = [];
    const seen = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && parents.has(current)) {
      const prior = seen.get(current);
      if (prior !== undefined) {
        for (const root of order.slice(prior)) cyclic.add(root);
        break;
      }
      seen.set(current, order.length);
      order.push(current);
      current = parents.get(current);
    }
  }
  return [...cyclic].sort(compareText);
}

function pruneOrphanedCandidates(
  candidates: Map<string, WorkspaceCandidate>,
  parents: Map<string, string | undefined>,
  diagnostics: WorkspaceDiagnostic[],
): void {
  let removed = true;
  while (removed) {
    removed = false;
    for (const [root, parent] of [...parents.entries()]) {
      if (parent === undefined || candidates.has(parent)) continue;
      const candidate = candidates.get(root);
      diagnostics.push(ambiguous(
        [root, parent],
        `Workspace '${root}' has a rejected parent '${parent}'.`,
        candidate?.evidence ?? [],
      ));
      candidates.delete(root);
      parents.delete(root);
      removed = true;
    }
  }
}

function workspaceId(root: string): string {
  return `workspace:${root}`;
}

function edgeId(kind: WorkspaceEdge["kind"], from: string, to: string): string {
  return `${kind}:${from}->${to}`;
}

function workspaceBasename(root: string): string {
  return root === ROOT ? "repository" : basename(root);
}

function isConventionalCandidate(root: string): boolean {
  const parts = root.split("/");
  return parts.length === 2 && (parts[0] === "packages" || parts[0] === "apps");
}

function readOptionalIdentity(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("workspace identity must be a non-empty string");
  }
  return value;
}

function ambiguous(
  roots: readonly string[],
  message: string,
  evidence: readonly WorkspaceManifestEvidence[],
): WorkspaceDiagnostic {
  return {
    code: "AMBIGUOUS_LAYOUT",
    message,
    roots: unique(roots).sort(compareText),
    evidence: sortEvidence(evidence),
  };
}

function sortEvidence(
  evidence: readonly WorkspaceManifestEvidence[],
): readonly WorkspaceManifestEvidence[] {
  const keyed = new Map<string, WorkspaceManifestEvidence>();
  for (const item of evidence) {
    keyed.set(`${item.manifestPath}\0${item.field}\0${JSON.stringify(item.value)}`, item);
  }
  return [...keyed.values()].sort((left, right) =>
    compareText(
      `${left.manifestPath}\0${left.field}\0${JSON.stringify(left.value)}`,
      `${right.manifestPath}\0${right.field}\0${JSON.stringify(right.value)}`,
    ));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function groupBy<T, K>(values: readonly T[], keyOf: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function compareCandidates(left: WorkspaceCandidate, right: WorkspaceCandidate): number {
  return compareText(
    `${left.root}\0${left.identity}\0${left.parentRoot ?? ""}\0${JSON.stringify(left.evidence)}`,
    `${right.root}\0${right.identity}\0${right.parentRoot ?? ""}\0${JSON.stringify(right.evidence)}`,
  );
}

function compareEdges(left: WorkspaceEdge, right: WorkspaceEdge): number {
  return compareText(
    `${left.kind}\0${left.from}\0${left.to}`,
    `${right.kind}\0${right.from}\0${right.to}`,
  );
}

function compareDiagnostics(left: WorkspaceDiagnostic, right: WorkspaceDiagnostic): number {
  return compareText(
    `${left.code}\0${left.roots.join("\0")}\0${left.message}`,
    `${right.code}\0${right.roots.join("\0")}\0${right.message}`,
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathDepth(path: string): number {
  return path === ROOT ? 0 : path.split("/").length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function emptyProjection(
  repositoryId: string,
  diagnostics: readonly WorkspaceDiagnostic[],
): WorkspaceProjection {
  return {
    schemaVersion: 1,
    repositoryId,
    nodes: [],
    edges: [],
    candidates: [],
    diagnostics,
  };
}
