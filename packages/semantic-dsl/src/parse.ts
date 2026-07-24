/**
 * Tolerant, deterministic parser for the `.sem` DSL (line/indentation, ASCII-canonical).
 *
 * Never throws: it accumulates `Diagnostic`s (file/line/column) and returns the best-effort model.
 * One block per node: an unindented `<kind> <id>` header, then 2-space-indented fields. See
 * docs/architecture/semantic-layer-v1.md for the grammar.
 */

import {
  DEFAULT_STATUS_BY_KIND,
  isChangeLifecycle,
  isSemanticNodeKind,
  isSemanticProvenance,
  isSemanticStatus,
  kindOfSemanticId,
  normalizeLegacySemanticModelV1,
  repositoryLinkFromRef,
} from "@semantic-context/semantic-model/reconciliation-read";
import type {
  ChangeContract,
  ChangeTargetBindingV1,
  RepositoryLink,
  SemanticCompatibilityNoteV1,
  SemanticModel,
  SemanticNode,
  SemanticNodeKind,
  SemanticProvenance,
  SemanticRelation,
  SemanticRelationKind,
  SemanticStatus,
} from "@semantic-context/semantic-model/reconciliation-read";
import type { Diagnostic } from "./diagnostics";
import { parseRefinementBlocks } from "./refinement";

export interface ParseResult {
  model: SemanticModel;
  diagnostics: Diagnostic[];
  compatibility: SemanticCompatibilityNoteV1[];
}

/** Field key → relation kind. `requires` is a synonym of `requires_evidence`. */
const RELATION_FIELD: Record<string, SemanticRelationKind> = {
  serves: "serves",
  preserves: "preserves",
  implements: "implements",
  depends_on: "depends_on",
  justifies: "justifies",
  requires_evidence: "requires_evidence",
  requires: "requires_evidence",
  proved_by: "proved_by",
  risks: "risks",
  contradicts: "contradicts",
  supersedes: "supersedes",
};

const SCALAR_KEYS = new Set(["statement", "rule", "status", "provenance", "appliesAtLevel"]);
const SAFE_TARGET_ID = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

interface RawField {
  key: string;
  value: string;
  line: number;
  column: number;
}

interface RawBlock {
  kind: SemanticNodeKind;
  id: string;
  headerLine: number;
  fields: RawField[];
}

function countIndent(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
  return i;
}

/** Split a header `kind id ...` into its two tokens (id is the remainder, trimmed). */
function splitHeader(content: string): { kind: string; id: string } {
  const firstSpace = content.search(/\s/);
  if (firstSpace === -1) return { kind: content, id: "" };
  return { kind: content.slice(0, firstSpace), id: content.slice(firstSpace + 1).trim() };
}

export function parseSemanticSource(text: string, file: string): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const blocks: RawBlock[] = [];
  let current: RawBlock | undefined;
  let listKey: RawField | undefined;

  const lines = text.split(/\r?\n/);
  const refinement = parseRefinementBlocks(lines, file);
  diagnostics.push(...refinement.diagnostics);
  for (let index = 0; index < lines.length; index += 1) {
    if (refinement.consumedLineIndexes.has(index)) continue;
    const raw = lines[index] ?? "";
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      listKey = undefined;
      continue;
    }
    const indent = countIndent(raw);
    if (raw.includes("\t")) {
      diagnostics.push({ file, line, column: 1, severity: "warning", message: "tabs are not recommended for indentation; use spaces" });
    }
    const content = raw.slice(indent);

    if (indent === 0) {
      const { kind, id } = splitHeader(content);
      listKey = undefined;
      if (!isSemanticNodeKind(kind)) {
        diagnostics.push({ file, line, column: 1, severity: "error", message: `unknown block kind "${kind}" (expected one of goal, invariant, decision, assumption, unknown, change, evidence)` });
        current = undefined;
        continue;
      }
      if (id === "") {
        diagnostics.push({ file, line, column: kind.length + 2, severity: "error", message: `${kind} block is missing an id` });
        current = undefined;
        continue;
      }
      const inferred = kindOfSemanticId(id);
      if (inferred !== undefined && inferred !== kind) {
        diagnostics.push({ file, line, column: kind.length + 2, severity: "warning", message: `id "${id}" has a "${inferred}" prefix but the block is "${kind}"` });
      }
      current = { kind, id, headerLine: line, fields: [] };
      blocks.push(current);
      continue;
    }

    // Indented content: a field or a list item.
    if (current === undefined) {
      diagnostics.push({ file, line, column: indent + 1, severity: "error", message: "field outside of any block" });
      continue;
    }

    if (content.startsWith("-")) {
      const item = content.replace(/^-\s*/, "").trim();
      if (listKey === undefined) {
        diagnostics.push({ file, line, column: indent + 1, severity: "error", message: "list item has no preceding key" });
        continue;
      }
      if (item !== "") current.fields.push({ key: listKey.key, value: item, line, column: indent + 1 });
      continue;
    }

    if (
      current.kind === "change"
      && (content === "target" || content.startsWith("target ") || content.startsWith("target:"))
    ) {
      if (!content.startsWith("target ")) {
        diagnostics.push({ file, line, column: indent + 1, severity: "error", code: "CHANGE_TARGET_INVALID", message: 'target binding must use "target <safe-id> <positive revision> <sha256:...>"' });
      } else {
        current.fields.push({ key: "target", value: content.slice("target ".length).trim(), line, column: indent + 1 });
      }
      listKey = undefined;
      continue;
    }

    const colon = content.indexOf(":");
    if (colon === -1) {
      diagnostics.push({ file, line, column: indent + 1, severity: "error", message: `expected "key: value", got "${content}"` });
      listKey = undefined;
      continue;
    }
    const key = content.slice(0, colon).trim();
    const value = content.slice(colon + 1).trim();
    if (value === "") {
      if (SCALAR_KEYS.has(key)) {
        diagnostics.push({ file, line, column: indent + 1, severity: "error", message: `"${key}" needs a value` });
        listKey = undefined;
      } else {
        // Bare key begins a block list; items follow as `- item` lines.
        listKey = { key, value: "", line, column: indent + 1 };
      }
      continue;
    }
    listKey = undefined;
    // Inline-list `[a, b]` is a multi-value form only for list/relation keys. A scalar key
    // (statement/rule/status/provenance) keeps its literal text — never split it, or a bracketed
    // statement would silently lose data.
    const inlineList = value.startsWith("[") && value.endsWith("]") && !SCALAR_KEYS.has(key);
    if (inlineList) {
      const inner = value.slice(1, -1);
      for (const part of inner.split(",")) {
        const item = part.trim();
        if (item !== "") current.fields.push({ key, value: item, line, column: indent + 1 });
      }
    } else {
      current.fields.push({ key, value, line, column: indent + 1 });
    }
  }

  const nodes: SemanticNode[] = [];
  const changes: ChangeContract[] = [];
  for (const block of blocks) {
    if (block.kind === "change") changes.push(finalizeChange(block, file, diagnostics));
    else nodes.push(finalizeNode(block, file, diagnostics));
  }

  const model = { nodes, changes, refinementRelations: refinement.relations };
  const compatibility = normalizeLegacySemanticModelV1(model).compatibility;
  return {
    model,
    diagnostics,
    compatibility,
  };
}

function pushUnique<T>(list: T[], value: T, key: (v: T) => string): void {
  if (!list.some((v) => key(v) === key(value))) list.push(value);
}

function collectCommon(
  block: RawBlock,
  file: string,
  diagnostics: Diagnostic[],
): { statement: string; provenance: SemanticProvenance; statusRaw: string | undefined; statusLine: number; statusColumn: number; appliesAtLevel: SemanticNode["appliesAtLevel"]; links: RepositoryLink[]; tags: string[]; metadata: Record<string, string> } {
  let statement = "";
  let provenance: SemanticProvenance = "author";
  let statusRaw: string | undefined;
  let statusLine = block.headerLine;
  let statusColumn = 1;
  const links: RepositoryLink[] = [];
  const tags: string[] = [];
  const metadata: Record<string, string> = {};
  let appliesAtLevel: SemanticNode["appliesAtLevel"];
  let levelSeen = false;

  for (const field of block.fields) {
    switch (field.key) {
      case "statement":
      case "rule":
        statement = field.value;
        break;
      case "status":
        statusRaw = field.value;
        statusLine = field.line;
        statusColumn = field.column;
        break;
      case "provenance":
        if (isSemanticProvenance(field.value)) provenance = field.value;
        else diagnostics.push({ file, line: field.line, column: field.column, severity: "warning", message: `unknown provenance "${field.value}" (using "author")` });
        break;
      case "appliesAtLevel": {
        if (levelSeen) diagnostics.push({ file, line: field.line, column: field.column, severity: "error", code: "SEMANTIC_LEVEL_DUPLICATE", message: "duplicate appliesAtLevel field" });
        levelSeen = true;
        if (/^[1-6]$/.test(field.value)) appliesAtLevel = Number(field.value) as SemanticNode["appliesAtLevel"];
        else diagnostics.push({ file, line: field.line, column: field.column, severity: "error", code: "SEMANTIC_LEVEL_INVALID", message: `invalid appliesAtLevel "${field.value}" (expected authored level 1..6; L0 is observed_hunk only)` });
        break;
      }
      case "link":
        pushUnique(links, repositoryLinkFromRef(field.value), (l) => `${l.kind}:${l.ref}`);
        break;
      case "file":
        pushUnique(links, repositoryLinkFromRef(`file:${field.value}`), (l) => `${l.kind}:${l.ref}`);
        break;
      case "tag":
        if (!tags.includes(field.value)) tags.push(field.value);
        break;
      case "meta": {
        const eq = field.value.indexOf("=");
        if (eq === -1) diagnostics.push({ file, line: field.line, column: field.column, severity: "warning", message: `meta expects "key=value", got "${field.value}"` });
        else metadata[field.value.slice(0, eq).trim()] = field.value.slice(eq + 1).trim();
        break;
      }
      default:
        // Relation / unknown keys are handled by the caller; a key that is neither a known scalar/
        // link/tag/meta nor a relation/unknown key is a typo — surface it instead of dropping it.
        if (RELATION_FIELD[field.key] === undefined && field.key !== "unknown" && field.key !== "target") {
          diagnostics.push({ file, line: field.line, column: field.column, severity: "warning", message: `unknown field "${field.key}" (ignored)` });
        }
        break;
    }
  }
  if (statement === "") {
    diagnostics.push({ file, line: block.headerLine, column: 1, severity: "warning", message: `${block.kind} "${block.id}" has no statement` });
  }
  return { statement, provenance, statusRaw, statusLine, statusColumn, appliesAtLevel, links, tags, metadata };
}

function finalizeNode(block: RawBlock, file: string, diagnostics: Diagnostic[]): SemanticNode {
  const common = collectCommon(block, file, diagnostics);
  const kind = block.kind as Exclude<SemanticNodeKind, "change">;
  let status: SemanticStatus = DEFAULT_STATUS_BY_KIND[kind] ?? "declared";
  if (common.statusRaw !== undefined) {
    if (isSemanticStatus(common.statusRaw)) status = common.statusRaw;
    else diagnostics.push({ file, line: common.statusLine, column: common.statusColumn, severity: "error", message: `unknown status "${common.statusRaw}" for ${block.kind}` });
  }

  const relations: SemanticRelation[] = [];
  for (const field of block.fields) {
    if (field.key === "unknown") {
      diagnostics.push({ file, line: field.line, column: field.column, severity: "warning", message: `"unknown:" is only meaningful on a change block (ignored on ${block.kind})` });
      continue;
    }
    const relKind = RELATION_FIELD[field.key];
    if (relKind !== undefined) pushUnique(relations, { kind: relKind, to: field.value }, (r) => `${r.kind}:${r.to}`);
  }

  const node: SemanticNode = {
    id: block.id,
    kind: block.kind,
    statement: common.statement,
    status,
    provenance: common.provenance,
    sourceRefs: [{ file, line: block.headerLine }],
    repositoryLinks: common.links,
    relations,
    tags: common.tags,
  };
  if (common.appliesAtLevel !== undefined) node.appliesAtLevel = common.appliesAtLevel;
  if (Object.keys(common.metadata).length > 0) node.metadata = common.metadata;
  return node;
}

function finalizeChange(block: RawBlock, file: string, diagnostics: Diagnostic[]): ChangeContract {
  const common = collectCommon(block, file, diagnostics);
  let lifecycle: ChangeContract["lifecycle"] = "draft";
  if (common.statusRaw !== undefined) {
    if (isChangeLifecycle(common.statusRaw)) lifecycle = common.statusRaw;
    else diagnostics.push({ file, line: common.statusLine, column: common.statusColumn, severity: "error", message: `unknown change lifecycle "${common.statusRaw}" (expected draft|active|verified|partial|blocked|stale|superseded)` });
  }

  const serves: string[] = [];
  const preserves: string[] = [];
  const requiresEvidence: string[] = [];
  const openUnknowns: string[] = [];
  let targetBinding: ChangeTargetBindingV1 | undefined;
  let targetSeen = false;
  for (const field of block.fields) {
    if (field.key === "target") {
      if (targetSeen) {
        diagnostics.push({ file, line: field.line, column: field.column, severity: "error", code: "CHANGE_TARGET_DUPLICATE", message: "duplicate target binding" });
        continue;
      }
      targetSeen = true;
      targetBinding = parseTargetBinding(field, file, diagnostics);
      continue;
    }
    if (field.key === "unknown") {
      if (!openUnknowns.includes(field.value)) openUnknowns.push(field.value);
      continue;
    }
    const relKind = RELATION_FIELD[field.key];
    if (relKind === undefined) continue;
    if (relKind === "serves") pushString(serves, field.value);
    else if (relKind === "preserves") pushString(preserves, field.value);
    else if (relKind === "requires_evidence") pushString(requiresEvidence, field.value);
    else diagnostics.push({ file, line: field.line, column: field.column, severity: "warning", message: `relation "${field.key}" is not tracked on a change contract (use serves/preserves/requires/unknown); ignored` });
  }

  const change: ChangeContract = {
    id: block.id,
    statement: common.statement,
    lifecycle,
    provenance: common.provenance,
    sourceRefs: [{ file, line: block.headerLine }],
    serves,
    preserves,
    requiresEvidence,
    openUnknowns,
    repositoryLinks: common.links,
    tags: common.tags,
  };
  if (common.appliesAtLevel !== undefined) change.appliesAtLevel = common.appliesAtLevel;
  if (targetBinding !== undefined) change.targetBinding = targetBinding;
  if (Object.keys(common.metadata).length > 0) change.metadata = common.metadata;
  return change;
}

function parseTargetBinding(
  field: RawField,
  file: string,
  diagnostics: Diagnostic[],
): ChangeTargetBindingV1 | undefined {
  const parts = field.value.split(/\s+/);
  if (parts.length !== 3) {
    diagnostics.push({ file, line: field.line, column: field.column, severity: "error", code: "CHANGE_TARGET_INVALID", message: 'target binding must use "target <safe-id> <positive revision> <sha256:...>"' });
    return undefined;
  }
  const [targetId, revisionText, artifactHash] = parts as [string, string, string];
  if (!SAFE_TARGET_ID.test(targetId)) {
    diagnostics.push({ file, line: field.line, column: field.column, severity: "error", code: "CHANGE_TARGET_ID_INVALID", message: `invalid target id "${targetId}" (expected a safe lowercase id)` });
    return undefined;
  }
  if (!/^[1-9][0-9]*$/.test(revisionText) || !Number.isSafeInteger(Number(revisionText))) {
    diagnostics.push({ file, line: field.line, column: field.column, severity: "error", code: "CHANGE_TARGET_REVISION_INVALID", message: `invalid target revision "${revisionText}" (expected a positive decimal integer)` });
    return undefined;
  }
  if (!SHA256.test(artifactHash)) {
    diagnostics.push({ file, line: field.line, column: field.column, severity: "error", code: "CHANGE_TARGET_HASH_INVALID", message: `invalid target artifact hash "${artifactHash}" (expected sha256:<64 lowercase hex>)` });
    return undefined;
  }
  return {
    schemaVersion: 1,
    targetId,
    revision: Number(revisionText),
    artifactHash: artifactHash as ChangeTargetBindingV1["artifactHash"],
  };
}

function pushString(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}
