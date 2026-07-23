/**
 * File store for the semantic layer. `.semctx/semantic/**.sem` is the Git-versioned source of
 * truth; this module reads and writes it deterministically via the DSL. SQLite is not used for
 * Plane B in v1.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { compareIds, SemctxError } from "@semantic-context/core";
import { parseSemanticSource, formatModel } from "@semantic-context/semantic-dsl";
import type { Diagnostic } from "@semantic-context/semantic-dsl";
import { mergeModels, emptyModel } from "@semantic-context/semantic-model";
import type { SemanticModel, SemanticNode, ChangeContract, SemanticNodeKind } from "@semantic-context/semantic-model";
import { semanticDir, workingDir, changesDir, kindFilePath, changeFilePath, activeChangePath, KIND_FILE } from "./paths";
import { ensureSemanticGitignore } from "./gitignore";

export interface LoadResult {
  model: SemanticModel;
  diagnostics: Diagnostic[];
  /** Ids seen in more than one file — a duplicate-declaration smell. */
  duplicateIds: string[];
}

function listSemFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareIds(a.name, b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSemFiles(full));
    else if (entry.isSymbolicLink() && entry.name.endsWith(".sem")) {
      throw new SemctxError("CONFIG_INVALID", "semantic model symlinks are unsupported", { file: full });
    } else if (entry.isFile() && entry.name.endsWith(".sem")) out.push(full);
  }
  return out;
}

function relFile(root: string, full: string): string {
  return full.slice(root.length + 1).replace(/\\/g, "/");
}

/** Load and merge every versioned `.sem` file under `.semctx/semantic/`. */
export function loadSemanticModel(root: string): LoadResult {
  const files = listSemFiles(semanticDir(root));
  const diagnostics: Diagnostic[] = [];
  const seen = new Map<string, number>();
  const models: SemanticModel[] = [];
  for (const file of files) {
    const parsed = parseSemanticSource(readFileSync(file, "utf8"), relFile(root, file));
    diagnostics.push(...parsed.diagnostics);
    for (const id of [...parsed.model.nodes.map((n) => n.id), ...parsed.model.changes.map((c) => c.id)]) {
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    models.push(parsed.model);
  }
  const duplicateIds = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort(compareIds);
  return { model: models.length > 0 ? mergeModels(...models) : emptyModel(), diagnostics, duplicateIds };
}

/** The working active change contract, if one is open (`.semctx/working/active-change.sem`). */
export function loadActiveChange(root: string): ChangeContract | undefined {
  const path = activeChangePath(root);
  if (!existsSync(path)) return undefined;
  const parsed = parseSemanticSource(readFileSync(path, "utf8"), "working/active-change.sem");
  return parsed.model.changes[0];
}

/** The versioned model overlaid with the working active change (later wins). */
export function loadModelWithWorking(root: string): LoadResult {
  const base = loadSemanticModel(root);
  const active = loadActiveChange(root);
  if (active === undefined) return base;
  return { ...base, model: mergeModels(base.model, { nodes: [], changes: [active] }) };
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/** Rewrite the per-kind file for `kind` with exactly `nodes` (canonical formatting). */
export function writeKindFile(root: string, kind: Exclude<SemanticNodeKind, "change">, nodes: SemanticNode[]): void {
  writeAtomic(kindFilePath(root, kind), formatModel({ nodes, changes: [] }));
}

/** Write a change contract to its versioned file `.semctx/semantic/changes/<id>.sem`. */
export function writeChangeFile(root: string, change: ChangeContract): void {
  writeAtomic(changeFilePath(root, change.id), formatModel({ nodes: [], changes: [change] }));
}

export function removeChangeFile(root: string, changeId: string): void {
  const path = changeFilePath(root, changeId);
  if (existsSync(path)) rmSync(path);
}

/** Persist the working active change (local, git-ignored). */
export function writeActiveChange(root: string, change: ChangeContract): void {
  writeAtomic(activeChangePath(root), formatModel({ nodes: [], changes: [change] }));
}

export function clearActiveChange(root: string): void {
  const path = activeChangePath(root);
  if (existsSync(path)) rmSync(path);
}

export interface FormatOutcome {
  file: string;
  changed: boolean;
  /** True when the file parsed to an empty model (comments/blank only) and was left untouched. */
  skipped: boolean;
}

/**
 * Canonicalise every versioned `.sem` file. Dry by default (reports what differs); pass `write` to
 * apply. Canonical form omits comments, so comment-only files (empty model) are skipped to avoid
 * blanking scaffold guidance; comments inside content files are dropped on write (canonical form).
 */
export function formatSemanticFiles(root: string, write: boolean): FormatOutcome[] {
  const out: FormatOutcome[] = [];
  for (const file of listSemFiles(semanticDir(root))) {
    const before = readFileSync(file, "utf8");
    const parsed = parseSemanticSource(before, relFile(root, file));
    if (parsed.model.nodes.length === 0 && parsed.model.changes.length === 0) {
      out.push({ file: relFile(root, file), changed: false, skipped: true });
      continue;
    }
    const after = formatModel(parsed.model);
    const changed = after !== before;
    if (changed && write) writeAtomic(file, after);
    out.push({ file: relFile(root, file), changed, skipped: false });
  }
  return out;
}

export interface ScaffoldPlan {
  file: string;
  action: "create" | "skip-exists" | "overwrite";
}

const EXAMPLE_FILES: Record<string, string> = {
  [KIND_FILE.goal]: `# Goals — what the system must achieve. Versioned in Git; edit freely.

goal goal.example.reliable-writes
  statement: Every write is applied at most once.
  status: declared
`,
  [KIND_FILE.invariant]: `# Invariants — business rules a change must preserve. Link to code once indexed:
#   link: inv:<invariant-slug>                    (a repo invariant id from @invariant markers)
#   link: sym:function:src/path/to/file.ts:name:12
# Run 'semctx semantic check' to validate links against the indexed graph.

invariant invariant.example.idempotent-write
  statement: retrying a write is equivalent to applying it once
  status: declared
  serves: goal.example.reliable-writes
  tag: critical
`,
  [KIND_FILE.decision]: `# Decisions — recorded choices (why the system is shaped as it is).

decision decision.example.single-writer
  statement: A single writer path guards the idempotency invariant.
  status: declared
  justifies: invariant.example.idempotent-write
`,
  [KIND_FILE.assumption]: `# Assumptions — believed-but-unproven premises. Kept distinct from established facts.
`,
  [KIND_FILE.unknown]: `# Unknowns — open questions that must survive while the system is changed.

unknown unknown.example.concurrency-race
  statement: Concurrent writers may both pass a read-then-write guard.
  status: declared
`,
  [KIND_FILE.evidence]: `# Evidence — proofs (tests, static checks, runtime observations) that back a claim.
`,
};

/**
 * Create `.semctx/semantic/` with a clean, minimal example and `.semctx/working/`. Never overwrites
 * without `force`. Also refines `.gitignore` so `.semctx/semantic/` is tracked.
 */
export function initSemanticScaffold(root: string, opts: { force?: boolean; dryRun?: boolean } = {}): {
  plan: ScaffoldPlan[];
  gitignore: ReturnType<typeof ensureSemanticGitignore>;
} {
  const force = opts.force === true;
  const dryRun = opts.dryRun === true;
  if (!dryRun) {
    mkdirSync(semanticDir(root), { recursive: true });
    mkdirSync(changesDir(root), { recursive: true });
    mkdirSync(workingDir(root), { recursive: true });
  }
  const plan: ScaffoldPlan[] = [];
  for (const [name, content] of Object.entries(EXAMPLE_FILES)) {
    const abs = join(semanticDir(root), name);
    const exists = existsSync(abs);
    const action: ScaffoldPlan["action"] = !exists ? "create" : force ? "overwrite" : "skip-exists";
    if (!dryRun && action !== "skip-exists") writeAtomic(abs, content);
    plan.push({ file: `.semctx/semantic/${name}`, action });
  }
  const gitignore = ensureSemanticGitignore(root, dryRun);
  return { plan, gitignore };
}
