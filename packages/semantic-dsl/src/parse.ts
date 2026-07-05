/**
 * Tolerant, deterministic parser for the `.sem` DSL (line/indentation, ASCII-canonical).
 *
 * Never throws: it accumulates `Diagnostic`s (file/line/column) and returns the best-effort model.
 * One block per node: an unindented `<kind> <id>` header, then 2-space-indented fields. See
 * docs/architecture/semantic-layer-v1.md for the grammar.
 */

import {
  isSemanticNodeKind,
  isSemanticStatus,
  isSemanticProvenance,
  isChangeLifecycle,
  kindOfSemanticId,
  repositoryLinkFromRef,
  DEFAULT_STATUS_BY_KIND,
} from "@semantic-context/semantic-model";
import type {
  SemanticModel,
  SemanticNode,
  ChangeContract,
  SemanticNodeKind,
  SemanticStatus,
  SemanticProvenance,
  SemanticRelationKind,
  SemanticRelation,
  RepositoryLink,
} from "@semantic-context/semantic-model";
import type { Diagnostic } from "./diagnostics";

export interface ParseResult {
  model: SemanticModel;
  diagnostics: Diagnostic[];
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

const SCALAR_KEYS = new Set(["statement", "rule", "status", "provenance"]);

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
  for (let index = 0; index < lines.length; index += 1) {
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
    const inlineList = value.startsWith("[") && value.endsWith("]");
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

  return { model: { nodes, changes }, diagnostics };
}

function pushUnique<T>(list: T[], value: T, key: (v: T) => string): void {
  if (!list.some((v) => key(v) === key(value))) list.push(value);
}

function collectCommon(
  block: RawBlock,
  file: string,
  diagnostics: Diagnostic[],
): { statement: string; provenance: SemanticProvenance; statusRaw: string | undefined; links: RepositoryLink[]; tags: string[]; metadata: Record<string, string> } {
  let statement = "";
  let provenance: SemanticProvenance = "author";
  let statusRaw: string | undefined;
  const links: RepositoryLink[] = [];
  const tags: string[] = [];
  const metadata: Record<string, string> = {};

  for (const field of block.fields) {
    switch (field.key) {
      case "statement":
      case "rule":
        statement = field.value;
        break;
      case "status":
        statusRaw = field.value;
        break;
      case "provenance":
        if (isSemanticProvenance(field.value)) provenance = field.value;
        else diagnostics.push({ file, line: field.line, column: field.column, severity: "warning", message: `unknown provenance "${field.value}" (using "author")` });
        break;
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
        break; // relation / unknown keys handled by the caller
    }
  }
  if (statement === "") {
    diagnostics.push({ file, line: block.headerLine, column: 1, severity: "warning", message: `${block.kind} "${block.id}" has no statement` });
  }
  return { statement, provenance, statusRaw, links, tags, metadata };
}

function finalizeNode(block: RawBlock, file: string, diagnostics: Diagnostic[]): SemanticNode {
  const common = collectCommon(block, file, diagnostics);
  const kind = block.kind as Exclude<SemanticNodeKind, "change">;
  let status: SemanticStatus = DEFAULT_STATUS_BY_KIND[kind] ?? "declared";
  if (common.statusRaw !== undefined) {
    if (isSemanticStatus(common.statusRaw)) status = common.statusRaw;
    else diagnostics.push({ file, line: block.headerLine, column: 1, severity: "error", message: `unknown status "${common.statusRaw}" for ${block.kind}` });
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
  if (Object.keys(common.metadata).length > 0) node.metadata = common.metadata;
  return node;
}

function finalizeChange(block: RawBlock, file: string, diagnostics: Diagnostic[]): ChangeContract {
  const common = collectCommon(block, file, diagnostics);
  let lifecycle: ChangeContract["lifecycle"] = "draft";
  if (common.statusRaw !== undefined) {
    if (isChangeLifecycle(common.statusRaw)) lifecycle = common.statusRaw;
    else diagnostics.push({ file, line: block.headerLine, column: 1, severity: "error", message: `unknown change lifecycle "${common.statusRaw}" (expected draft|active|verified|partial|blocked|stale|superseded)` });
  }

  const serves: string[] = [];
  const preserves: string[] = [];
  const requiresEvidence: string[] = [];
  const openUnknowns: string[] = [];
  for (const field of block.fields) {
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
  if (Object.keys(common.metadata).length > 0) change.metadata = common.metadata;
  return change;
}

function pushString(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}
