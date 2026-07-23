import {
  EPISTEMIC_STATUSES,
  EvidenceKindV1Schema,
  RefinementRelationKindV1Schema,
  RefinementRelationV1Schema,
  RelationProvenanceV1Schema,
  type EvidenceRefV1,
  type RefinementRelationV1,
  type RelationEndpointV1,
} from "@semantic-context/control-model";
import type { Diagnostic } from "./diagnostics";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ASCII = /^[\x00-\x7f]*$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const BARE_TOKEN = /^[A-Za-z0-9._:/@+-]+$/;
const FIELD_STAGE: Readonly<Record<string, number>> = {
  target: 0,
  epistemicStatus: 1,
  provenance: 2,
  evidenceRef: 3,
};

interface Token {
  value: string;
  column: number;
}

export interface ParsedRefinementBlocks {
  relations: RefinementRelationV1[];
  diagnostics: Diagnostic[];
  consumedLineIndexes: Set<number>;
}

function diagnostic(
  file: string,
  line: number,
  column: number,
  code: string,
  message: string,
): Diagnostic {
  return { file, line, column, severity: "error", code, message };
}

function tokenize(line: string): { tokens: Token[]; errorColumn?: number } {
  const tokens: Token[] = [];
  let index = 0;
  while (index < line.length) {
    while (line[index] === " ") index += 1;
    if (index >= line.length) break;
    const column = index + 1;
    if (line[index] === "\"") {
      let end = index + 1;
      let escaped = false;
      for (; end < line.length; end += 1) {
        const char = line[end];
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") break;
      }
      if (end >= line.length) return { tokens, errorColumn: column };
      const raw = line.slice(index, end + 1);
      try {
        const value = JSON.parse(raw) as unknown;
        if (typeof value !== "string" || !PRINTABLE_ASCII.test(value)) return { tokens, errorColumn: column };
        tokens.push({ value, column });
      } catch {
        return { tokens, errorColumn: column };
      }
      index = end + 1;
      if (index < line.length && line[index] !== " ") return { tokens, errorColumn: index + 1 };
      continue;
    }
    let end = index;
    while (end < line.length && line[end] !== " ") end += 1;
    const value = line.slice(index, end);
    if (!ASCII.test(value) || value.includes("\"") || value.includes("\\")) {
      return { tokens, errorColumn: column };
    }
    tokens.push({ value, column });
    index = end;
  }
  return { tokens };
}

function parseEndpoint(
  tokens: readonly Token[],
  offset: number,
  file: string,
  line: number,
  diagnostics: Diagnostic[],
): RelationEndpointV1 | undefined {
  const tag = tokens[offset];
  const value = tokens[offset + 1];
  if (tag === undefined || value === undefined || tokens.length !== offset + 2) {
    diagnostics.push(diagnostic(file, line, tag?.column ?? 1, "RELATION_INVALID_ENDPOINT", "expected a tagged semantic or observed_hunk endpoint"));
    return undefined;
  }
  if (tag.value === "semantic") {
    if (value.value === "") {
      diagnostics.push(diagnostic(file, line, value.column, "RELATION_INVALID_ENDPOINT", "semantic endpoint id must not be empty"));
      return undefined;
    }
    return { plane: "B", kind: "semantic_node", nodeId: value.value };
  }
  if (tag.value === "observed_hunk") {
    if (!SHA256.test(value.value)) {
      diagnostics.push(diagnostic(file, line, value.column, "RELATION_MALFORMED_DIGEST", "observed_hunk endpoint requires sha256:<64-lowercase-hex>"));
      return undefined;
    }
    return { plane: "A", kind: "observed_diff_hunk", coordinateDigest: value.value as `sha256:${string}` };
  }
  diagnostics.push(diagnostic(file, line, tag.column, "RELATION_INVALID_ENDPOINT", `unknown endpoint tag "${tag.value}"`));
  return undefined;
}

function evidenceKey(value: EvidenceRefV1): string {
  return `${value.kind}\u0000${value.locator}\u0000${value.digest.value}`;
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function parseBlock(
  blockLines: readonly string[],
  startLine: number,
  file: string,
): { relation?: RefinementRelationV1; diagnostics: Diagnostic[]; id?: string } {
  const diagnostics: Diagnostic[] = [];
  for (let offset = 0; offset < blockLines.length; offset += 1) {
    const raw = blockLines[offset] ?? "";
    if (!ASCII.test(raw)) {
      const index = [...raw].findIndex((char) => (char.codePointAt(0) ?? 0) > 0x7f);
      diagnostics.push(diagnostic(file, startLine + offset, index + 1, "RELATION_NON_ASCII", "relation DSL v2 accepts ASCII source only"));
    }
  }
  if (diagnostics.length > 0) return { diagnostics };

  const header = tokenize(blockLines[0] ?? "");
  if (header.errorColumn !== undefined) {
    diagnostics.push(diagnostic(file, startLine, header.errorColumn, "RELATION_MALFORMED_TOKEN", "malformed escaped ASCII token"));
    return { diagnostics };
  }
  const headerTokens = header.tokens;
  const id = headerTokens[1]?.value;
  if (headerTokens[0]?.value !== "relation" || id === undefined || headerTokens[2] === undefined || headerTokens[3]?.value !== "source") {
    diagnostics.push(diagnostic(file, startLine, 1, "RELATION_MALFORMED_HEADER", "expected relation <id> <kind> source <endpoint>"));
    return { diagnostics, id };
  }
  const kindResult = RefinementRelationKindV1Schema.safeParse(headerTokens[2].value);
  if (!kindResult.success) {
    diagnostics.push(diagnostic(file, startLine, headerTokens[2].column, "RELATION_UNKNOWN_KIND", `unknown refinement relation kind "${headerTokens[2].value}"`));
  }
  const source = parseEndpoint(headerTokens, 4, file, startLine, diagnostics);

  let target: RelationEndpointV1 | undefined;
  let epistemicStatus: RefinementRelationV1["epistemicStatus"] | undefined;
  let provenance: RefinementRelationV1["provenance"] | undefined;
  const evidenceRefs: EvidenceRefV1[] = [];
  const seenEvidence = new Set<string>();
  let previousEvidenceKey: string | undefined;
  let stage = 0;
  let sawEnd = false;

  for (let offset = 1; offset < blockLines.length; offset += 1) {
    const lineNumber = startLine + offset;
    const raw = blockLines[offset] ?? "";
    const tokenized = tokenize(raw);
    if (tokenized.errorColumn !== undefined) {
      diagnostics.push(diagnostic(file, lineNumber, tokenized.errorColumn, "RELATION_MALFORMED_TOKEN", "malformed escaped ASCII token"));
      continue;
    }
    const tokens = tokenized.tokens;
    const field = tokens[0];
    if (field === undefined) continue;

    if (field.value === "end") {
      if (tokens.length !== 1) diagnostics.push(diagnostic(file, lineNumber, field.column, "RELATION_UNKNOWN_FIELD", "end must be the only token on its line"));
      sawEnd = true;
      if (offset !== blockLines.length - 1) diagnostics.push(diagnostic(file, lineNumber, field.column, "RELATION_UNKNOWN_FIELD", "content after relation end"));
      break;
    }

    const expectedMinimumStage = FIELD_STAGE[field.value] ?? -1;
    if (expectedMinimumStage === -1) {
      diagnostics.push(diagnostic(file, lineNumber, field.column, "RELATION_UNKNOWN_FIELD", `unknown relation field "${field.value}"`));
      continue;
    }
    if (expectedMinimumStage !== stage && !(expectedMinimumStage === 3 && stage === 3)) {
      diagnostics.push(diagnostic(file, lineNumber, field.column, "RELATION_FIELD_OUT_OF_ORDER", `relation field "${field.value}" is out of canonical order`));
    }

    if (field.value === "target") {
      if (target !== undefined) diagnostics.push(diagnostic(file, lineNumber, field.column, "RELATION_DUPLICATE_FIELD", "duplicate target field"));
      target = parseEndpoint(tokens, 1, file, lineNumber, diagnostics);
      stage = Math.max(stage, 1);
      continue;
    }
    if (field.value === "epistemicStatus") {
      const value = tokens[1];
      if (tokens.length !== 2 || value === undefined || !EPISTEMIC_STATUSES.includes(value.value as never)) {
        diagnostics.push(diagnostic(file, lineNumber, value?.column ?? field.column, "RELATION_UNKNOWN_EPISTEMIC_STATUS", `unknown epistemic status "${value?.value ?? ""}"`));
      } else {
        epistemicStatus = value.value as RefinementRelationV1["epistemicStatus"];
      }
      stage = Math.max(stage, 2);
      continue;
    }
    if (field.value === "provenance") {
      const value = tokens[1];
      const result = RelationProvenanceV1Schema.safeParse(value?.value);
      if (tokens.length !== 2 || !result.success) {
        diagnostics.push(diagnostic(file, lineNumber, value?.column ?? field.column, "RELATION_UNKNOWN_PROVENANCE", `unknown relation provenance "${value?.value ?? ""}"`));
      } else {
        provenance = result.data;
      }
      stage = Math.max(stage, 3);
      continue;
    }

    const kind = tokens[1];
    const locator = tokens[2];
    const digest = tokens[3];
    if (tokens.length !== 4 || kind === undefined || locator === undefined || digest === undefined) {
      diagnostics.push(diagnostic(file, lineNumber, field.column, "RELATION_MALFORMED_EVIDENCE", "expected evidenceRef <kind> <locator> sha256:<64-lowercase-hex>"));
      stage = 3;
      continue;
    }
    const kindResult = EvidenceKindV1Schema.safeParse(kind.value);
    if (!kindResult.success) {
      diagnostics.push(diagnostic(file, lineNumber, kind.column, "RELATION_UNKNOWN_EVIDENCE_KIND", `unknown evidence kind "${kind.value}"`));
      stage = 3;
      continue;
    }
    if (!SHA256.test(digest.value)) {
      diagnostics.push(diagnostic(file, lineNumber, digest.column, "RELATION_MALFORMED_DIGEST", "evidence digest requires sha256:<64-lowercase-hex>"));
      stage = 3;
      continue;
    }
    const evidence: EvidenceRefV1 = {
      schemaVersion: 1,
      kind: kindResult.data,
      locator: locator.value,
      digest: { algorithm: "sha256", value: digest.value.slice("sha256:".length) },
    };
    const key = evidenceKey(evidence);
    if (seenEvidence.has(key)) {
      diagnostics.push(diagnostic(file, lineNumber, field.column, "RELATION_DUPLICATE_EVIDENCE", "duplicate evidenceRef"));
    } else if (previousEvidenceKey !== undefined && compareAscii(previousEvidenceKey, key) > 0) {
      diagnostics.push(diagnostic(file, lineNumber, field.column, "RELATION_EVIDENCE_OUT_OF_ORDER", "evidenceRef entries must be in canonical ASCII order"));
    }
    seenEvidence.add(key);
    previousEvidenceKey = key;
    evidenceRefs.push(evidence);
    stage = 3;
  }

  if (!sawEnd) diagnostics.push(diagnostic(file, startLine + blockLines.length - 1, 1, "RELATION_MISSING_END", "relation block is missing end"));
  if (evidenceRefs.length === 0) diagnostics.push(diagnostic(file, startLine, 1, "RELATION_MISSING_EVIDENCE", "relation requires at least one evidenceRef"));
  if (target === undefined && !diagnostics.some((item) => item.code === "RELATION_INVALID_ENDPOINT")) {
    diagnostics.push(diagnostic(file, startLine, 1, "RELATION_MISSING_FIELD", "relation is missing target"));
  }
  if (epistemicStatus === undefined && !diagnostics.some((item) => item.code === "RELATION_UNKNOWN_EPISTEMIC_STATUS")) {
    diagnostics.push(diagnostic(file, startLine, 1, "RELATION_MISSING_FIELD", "relation is missing epistemicStatus"));
  }
  if (provenance === undefined && !diagnostics.some((item) => item.code === "RELATION_UNKNOWN_PROVENANCE")) {
    diagnostics.push(diagnostic(file, startLine, 1, "RELATION_MISSING_FIELD", "relation is missing provenance"));
  }

  if (diagnostics.length > 0 || id === undefined || !kindResult.success || source === undefined || target === undefined || epistemicStatus === undefined || provenance === undefined) {
    return { diagnostics, id };
  }
  const candidate: RefinementRelationV1 = {
    schemaVersion: 1,
    id,
    kind: kindResult.data,
    source,
    target,
    epistemicStatus,
    provenance,
    evidenceRefs,
  };
  const schemaResult = RefinementRelationV1Schema.safeParse(candidate);
  if (!schemaResult.success) {
    diagnostics.push(diagnostic(file, startLine, 1, "RELATION_SCHEMA_INVALID", schemaResult.error.issues[0]?.message ?? "invalid refinement relation"));
    return { diagnostics, id };
  }
  if (formatRefinementRelation(candidate) !== blockLines.join("\n")) {
    diagnostics.push(diagnostic(
      file,
      startLine,
      1,
      "RELATION_NON_CANONICAL_ENCODING",
      "relation block must use the canonical ASCII token spelling and whitespace",
    ));
    return { diagnostics, id };
  }
  return { relation: candidate, diagnostics, id };
}

export function parseRefinementBlocks(lines: readonly string[], file: string): ParsedRefinementBlocks {
  const relations: RefinementRelationV1[] = [];
  const diagnostics: Diagnostic[] = [];
  const consumedLineIndexes = new Set<number>();
  const relationIndexById = new Map<string, number>();
  const duplicateIds = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    if (!raw.startsWith("relation ")) continue;
    const blockLines: string[] = [];
    let endIndex = index;
    for (; endIndex < lines.length; endIndex += 1) {
      const candidate = lines[endIndex] ?? "";
      if (
        endIndex > index
        && /^(?:relation|goal|invariant|decision|assumption|unknown|change|evidence)\s+/.test(candidate)
      ) break;
      blockLines.push(candidate);
      consumedLineIndexes.add(endIndex);
      if (candidate === "end") {
        endIndex += 1;
        break;
      }
    }
    const parsed = parseBlock(blockLines, index + 1, file);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.relation !== undefined) {
      const existing = relationIndexById.get(parsed.relation.id);
      if (existing !== undefined) {
        duplicateIds.add(parsed.relation.id);
        diagnostics.push(diagnostic(file, index + 1, 10, "RELATION_DUPLICATE_ID", `duplicate relation id "${parsed.relation.id}"`));
      } else {
        relationIndexById.set(parsed.relation.id, relations.length);
        relations.push(parsed.relation);
      }
    }
    index = Math.max(index, endIndex - 1);
  }

  return {
    relations: relations
      .filter((relation) => !duplicateIds.has(relation.id))
      .sort((left, right) => compareAscii(left.id, right.id)),
    diagnostics,
    consumedLineIndexes,
  };
}

export function formatAsciiToken(value: string): string {
  if (!PRINTABLE_ASCII.test(value)) throw new Error("relation DSL v2 tokens must be printable ASCII");
  return BARE_TOKEN.test(value) ? value : JSON.stringify(value);
}

function formatEndpoint(endpoint: RelationEndpointV1): string {
  return endpoint.plane === "B"
    ? `semantic ${formatAsciiToken(endpoint.nodeId)}`
    : `observed_hunk ${endpoint.coordinateDigest}`;
}

export function formatRefinementRelation(relation: RefinementRelationV1): string {
  if (relation.relationDigest !== undefined) {
    throw new Error("relationDigest is aggregate metadata and has no relation DSL v2 field");
  }
  const evidence = [...relation.evidenceRefs].sort((left, right) => compareAscii(evidenceKey(left), evidenceKey(right)));
  const parsed = RefinementRelationV1Schema.parse({ ...relation, evidenceRefs: evidence }) as RefinementRelationV1;
  return [
    `relation ${formatAsciiToken(parsed.id)} ${parsed.kind} source ${formatEndpoint(parsed.source)}`,
    `target ${formatEndpoint(parsed.target)}`,
    `epistemicStatus ${parsed.epistemicStatus}`,
    `provenance ${parsed.provenance}`,
    ...evidence.map((item) => `evidenceRef ${item.kind} ${formatAsciiToken(item.locator)} sha256:${item.digest.value}`),
    "end",
  ].join("\n");
}
