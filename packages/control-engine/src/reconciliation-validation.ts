import {
  computeRefinementRelationDigest,
  createObservedDiffHunkV1,
  type CoordinateGraphReportV2,
  type ObservedDiffHunkV1,
  type RefinementRelationV1,
  type Sha256Hash,
} from "@semantic-context/control-model/reconciliation";

const HASH = /^sha256:[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]{64}$/;
const QUALIFIED = /^(repo|semantic):.+$/;
const ASCII = /^[\x20-\x7e]*$/;
const LEVELS = new Set([0, 1, 2, 3, 4, 5, 6]);
const CATEGORIES = new Set([
  "syntax", "code_entity", "module", "bounded_context", "capability",
  "invariant", "policy", "goal", "decision", "system", "strategy",
]);
const EPISTEMIC = new Set([
  "human_declared", "statically_observed", "dynamically_observed",
  "test_observed", "historically_observed", "llm_inferred", "hypothetical",
]);
const RELATION_KINDS = new Set([
  "decomposes_to", "realizes", "implements", "constrained_by", "proved_by",
]);
const PROVENANCE = new Set(["author", "agent", "derived"]);
const EVIDENCE_KINDS = new Set([
  "semantic_node", "observed_diff_hunk", "document_span", "test_result", "commit",
]);

export function parseSha256Hash(value: unknown, label: string): Sha256Hash {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new Error(`${label} must be sha256:<64 lowercase hex>`);
  }
  return value as Sha256Hash;
}

export function parseObservedDiffHunk(value: unknown): ObservedDiffHunkV1 {
  const hunk = requireRecord(value, "observed hunk");
  requireExactKeys(hunk, [
    "schemaVersion", "repositoryIdentity", "normalizedPath", "oldRange", "newRange",
    "oldBlobId", "newBlobId", "rawHunkBytes", "identity",
  ], "observed hunk");
  if (hunk.schemaVersion !== 1) throw new Error("observed hunk schemaVersion must be 1");
  if (!isNonEmpty(hunk.repositoryIdentity)) throw new Error("observed hunk repositoryIdentity is required");
  if (typeof hunk.normalizedPath !== "string") throw new Error("observed hunk path is required");
  parseRange(hunk.oldRange, "oldRange");
  parseRange(hunk.newRange, "newRange");
  for (const field of ["oldBlobId", "newBlobId"] as const) {
    const blob = hunk[field];
    if (blob !== null && (typeof blob !== "string" || !ASCII.test(blob))) {
      throw new Error(`${field} must be printable ASCII or null`);
    }
  }
  if (!(hunk.rawHunkBytes instanceof Uint8Array)) throw new Error("rawHunkBytes must be Uint8Array");
  parseSha256Hash(hunk.identity, "observed hunk identity");
  const typed = hunk as unknown as ObservedDiffHunkV1;
  const canonical = createObservedDiffHunkV1(typed);
  if (
    canonical.identity !== typed.identity
    || canonical.normalizedPath !== typed.normalizedPath
  ) throw new Error("observed hunk identity or path is not canonical");
  return typed;
}

export function isObservedDiffHunk(value: unknown): value is ObservedDiffHunkV1 {
  try {
    parseObservedDiffHunk(value);
    return true;
  } catch {
    return false;
  }
}

export function parseCoordinateGraphV2(value: unknown): CoordinateGraphReportV2 {
  const graph = requireRecord(value, "coordinate graph");
  requireExactKeys(graph, [
    "schemaVersion", "nodes", "structuralEdges", "refinementRelations",
    "verifiedEvidenceDigests", "mapping", "coverage", "unsupported", "unmapped",
    "staleLinks", "danglingReferences", "compatibilityNormalization",
  ], "coordinate graph");
  if (graph.schemaVersion !== 2) throw new Error("coordinate graph schemaVersion must be 2");
  const nodes = requireArray(graph.nodes, "nodes");
  const structuralEdges = requireArray(graph.structuralEdges, "structuralEdges");
  const refinementRelations = requireArray(graph.refinementRelations, "refinementRelations");
  const verifiedEvidenceDigests = requireArray(
    graph.verifiedEvidenceDigests,
    "verifiedEvidenceDigests",
  );
  const mapping = requireArray(graph.mapping, "mapping");
  const coverage = requireArray(graph.coverage, "coverage");
  const unsupported = requireArray(graph.unsupported, "unsupported");
  const unmapped = requireArray(graph.unmapped, "unmapped");
  const staleLinks = requireArray(graph.staleLinks, "staleLinks");
  const danglingReferences = requireArray(graph.danglingReferences, "danglingReferences");
  const compatibilityNormalization = requireArray(
    graph.compatibilityNormalization,
    "compatibilityNormalization",
  );

  const nodeIds = nodes.map((node, index) => parseNode(node, index));
  requireSortedUnique(nodeIds, "coordinate nodes");
  structuralEdges.forEach((edge, index) => parseEdge(edge, index));
  const relationIds = refinementRelations.map((relation, index) =>
    parseRelation(relation, index)
  );
  requireSortedUnique(relationIds, "refinement relations");
  const verified = verifiedEvidenceDigests.map((digest, index) =>
    parseSha256Hash(digest, `verifiedEvidenceDigests[${index}]`)
  );
  requireSortedUnique(verified, "verified evidence");
  mapping.forEach((item, index) => parseMapping(item, index));
  coverage.forEach((item, index) => parseCoverage(item, index));
  unsupported.forEach((item, index) => parseSourceIssue(item, index, "unsupported"));
  unmapped.forEach((item, index) => parseSourceIssue(item, index, "unmapped"));
  staleLinks.forEach((item, index) => {
    const record = requireRecord(item, `staleLinks[${index}]`);
    requireExactKeys(record, ["ownerId", "link", "resolved", "reason"], `staleLinks[${index}]`);
    const link = requireRecord(record.link, `staleLinks[${index}].link`);
    requireExactKeys(link, ["kind", "ref"], `staleLinks[${index}].link`);
    if (!isNonEmpty(record.ownerId) || !isNonEmpty(link.kind) || !isNonEmpty(link.ref)
      || record.resolved !== false || !isNonEmpty(record.reason)) {
      throw new Error(`staleLinks[${index}] is invalid`);
    }
  });
  danglingReferences.forEach((item, index) => {
    const record = requireRecord(item, `danglingReferences[${index}]`);
    requireExactKeys(record, ["ownerId", "field", "ref"], `danglingReferences[${index}]`);
    if (![record.ownerId, record.field, record.ref].every(isNonEmpty)) {
      throw new Error(`danglingReferences[${index}] is invalid`);
    }
  });
  compatibilityNormalization.forEach((item, index) => {
    const record = requireRecord(item, `compatibilityNormalization[${index}]`);
    requireExactKeys(record, ["schemaVersion", "sourceSchemaVersion", "targetSchemaVersion", "notes"],
      `compatibilityNormalization[${index}]`);
    if (record.schemaVersion !== 1 || record.sourceSchemaVersion !== 1
      || record.targetSchemaVersion !== 2 || !Array.isArray(record.notes)
      || record.notes.length === 0 || !record.notes.every(isNonEmpty)) {
      throw new Error(`compatibilityNormalization[${index}] is invalid`);
    }
  });
  return graph as unknown as CoordinateGraphReportV2;
}

export function parseRefinementRelationV1(value: unknown): RefinementRelationV1 {
  parseRelation(value, 0);
  return value as RefinementRelationV1;
}

function parseNode(value: unknown, index: number): string {
  const node = requireRecord(value, `nodes[${index}]`);
  requireExactKeys(node, [
    "id", "plane", "sourceId", "sourceKind", "appliesAtLevel", "category",
    "label", "epistemicStatus", "references",
  ], `nodes[${index}]`, ["metadata"]);
  if (!isNonEmpty(node.id) || !["repo", "semantic", "observed"].includes(String(node.plane))) {
    throw new Error(`nodes[${index}] identity is invalid`);
  }
  if (
    (node.plane === "observed" && !HASH.test(String(node.id)))
    || (node.plane !== "observed" && !String(node.id).startsWith(`${node.plane}:`))
  ) throw new Error(`nodes[${index}] id does not match plane`);
  if (!isNonEmpty(node.sourceId) || !isNonEmpty(node.sourceKind)
    || typeof node.label !== "string"
    || typeof node.epistemicStatus !== "string"
    || !EPISTEMIC.has(node.epistemicStatus)) {
    throw new Error(`nodes[${index}] content is invalid`);
  }
  const hasLevel = node.appliesAtLevel !== null;
  if (hasLevel !== (node.category !== null)
    || (hasLevel && (
      typeof node.appliesAtLevel !== "number"
      || !LEVELS.has(node.appliesAtLevel)
      || typeof node.category !== "string"
      || !CATEGORIES.has(node.category)
    ))) {
    throw new Error(`nodes[${index}] level/category is invalid`);
  }
  if (!Array.isArray(node.references) || !node.references.every((item) => typeof item === "string")) {
    throw new Error(`nodes[${index}] references are invalid`);
  }
  if (node.metadata !== undefined) {
    const metadata = requireRecord(node.metadata, `nodes[${index}].metadata`);
    if (!Object.values(metadata).every((item) => typeof item === "string")) {
      throw new Error(`nodes[${index}] metadata is invalid`);
    }
  }
  return String(node.id);
}

function parseEdge(value: unknown, index: number): void {
  const edge = requireRecord(value, `structuralEdges[${index}]`);
  requireExactKeys(edge, ["from", "to", "relation", "evidenceRefs"], `structuralEdges[${index}]`,
    ["sourceRelation"]);
  if (!QUALIFIED.test(String(edge.from)) || !QUALIFIED.test(String(edge.to))
    || !isNonEmpty(edge.relation) || !Array.isArray(edge.evidenceRefs)
    || !edge.evidenceRefs.every((item) => typeof item === "string")
    || (edge.sourceRelation !== undefined && typeof edge.sourceRelation !== "string")) {
    throw new Error(`structuralEdges[${index}] is invalid`);
  }
}

function parseRelation(value: unknown, index: number): string {
  const relation = requireRecord(value, `refinementRelations[${index}]`);
  requireExactKeys(relation, [
    "schemaVersion", "id", "kind", "source", "target", "epistemicStatus",
    "provenance", "evidenceRefs",
  ], `refinementRelations[${index}]`, ["relationDigest"]);
  if (relation.schemaVersion !== 1 || !isNonEmpty(relation.id)
    || typeof relation.kind !== "string" || !RELATION_KINDS.has(relation.kind)
    || typeof relation.epistemicStatus !== "string"
    || !EPISTEMIC.has(relation.epistemicStatus)
    || typeof relation.provenance !== "string" || !PROVENANCE.has(relation.provenance)
    || !Array.isArray(relation.evidenceRefs)
    || relation.evidenceRefs.length === 0) {
    throw new Error(`refinementRelations[${index}] is invalid`);
  }
  parseEndpoint(relation.source, `refinementRelations[${index}].source`);
  parseEndpoint(relation.target, `refinementRelations[${index}].target`);
  const evidenceKeys = relation.evidenceRefs.map((item, evidenceIndex) =>
    parseEvidence(item, `refinementRelations[${index}].evidenceRefs[${evidenceIndex}]`)
  );
  requireSortedUnique(evidenceKeys, `refinementRelations[${index}] evidence`);
  if (relation.relationDigest !== undefined) {
    parseSha256Hash(relation.relationDigest, `refinementRelations[${index}].relationDigest`);
    if (computeRefinementRelationDigest(relation as unknown as RefinementRelationV1)
      !== relation.relationDigest) {
      throw new Error(`refinementRelations[${index}] digest mismatch`);
    }
  }
  return String(relation.id);
}

function parseEndpoint(value: unknown, label: string): void {
  const endpoint = requireRecord(value, label);
  if (endpoint.plane === "B") {
    requireExactKeys(endpoint, ["plane", "kind", "nodeId"], label);
    if (endpoint.kind !== "semantic_node" || !isNonEmpty(endpoint.nodeId)) {
      throw new Error(`${label} is invalid`);
    }
    return;
  }
  requireExactKeys(endpoint, ["plane", "kind", "coordinateDigest"], label);
  if (endpoint.plane !== "A" || endpoint.kind !== "observed_diff_hunk") {
    throw new Error(`${label} is invalid`);
  }
  parseSha256Hash(endpoint.coordinateDigest, `${label}.coordinateDigest`);
}

function parseEvidence(value: unknown, label: string): string {
  const evidence = requireRecord(value, label);
  requireExactKeys(evidence, ["schemaVersion", "kind", "locator", "digest"], label);
  const digest = requireRecord(evidence.digest, `${label}.digest`);
  requireExactKeys(digest, ["algorithm", "value"], `${label}.digest`);
  if (evidence.schemaVersion !== 1
    || typeof evidence.kind !== "string" || !EVIDENCE_KINDS.has(evidence.kind)
    || !isNonEmpty(evidence.locator) || digest.algorithm !== "sha256"
    || typeof digest.value !== "string" || !HEX.test(digest.value)) {
    throw new Error(`${label} is invalid`);
  }
  return `${evidence.kind}\0${evidence.locator}\0${digest.value}`;
}

function parseMapping(value: unknown, index: number): void {
  const mapping = requireRecord(value, `mapping[${index}]`);
  requireExactKeys(mapping, ["plane", "sourceKind", "level", "category", "supported"],
    `mapping[${index}]`, ["reason"]);
  if (!["repo", "semantic"].includes(String(mapping.plane)) || !isNonEmpty(mapping.sourceKind)
    || typeof mapping.supported !== "boolean"
    || (mapping.level !== null
      && (typeof mapping.level !== "number" || !LEVELS.has(mapping.level)))
    || (mapping.category !== null
      && (typeof mapping.category !== "string" || !CATEGORIES.has(mapping.category)))
    || ((mapping.level === null) !== (mapping.category === null))
    || (mapping.reason !== undefined && typeof mapping.reason !== "string")) {
    throw new Error(`mapping[${index}] is invalid`);
  }
}

function parseCoverage(value: unknown, index: number): void {
  const coverage = requireRecord(value, `coverage[${index}]`);
  requireExactKeys(coverage, ["level", "categories", "coordinateIds"], `coverage[${index}]`);
  if (typeof coverage.level !== "number" || !LEVELS.has(coverage.level)
    || !Array.isArray(coverage.categories)
    || !coverage.categories.every((item) => typeof item === "string" && CATEGORIES.has(item))
    || !Array.isArray(coverage.coordinateIds)
    || !coverage.coordinateIds.every((item) =>
      typeof item === "string" && (QUALIFIED.test(item) || HASH.test(item))
    )) throw new Error(`coverage[${index}] is invalid`);
  requireSortedUnique(coverage.categories.map(String), `coverage[${index}] categories`);
  requireSortedUnique(coverage.coordinateIds.map(String), `coverage[${index}] coordinates`);
}

function parseSourceIssue(value: unknown, index: number, field: string): void {
  const issue = requireRecord(value, `${field}[${index}]`);
  requireExactKeys(issue, ["plane", "sourceId", "sourceKind", "reason"], `${field}[${index}]`);
  if (!["repo", "semantic"].includes(String(issue.plane))
    || ![issue.sourceId, issue.sourceKind, issue.reason].every(isNonEmpty)) {
    throw new Error(`${field}[${index}] is invalid`);
  }
}

function parseRange(value: unknown, label: string): void {
  const range = requireRecord(value, label);
  requireExactKeys(range, ["start", "lines"], label);
  for (const field of ["start", "lines"] as const) {
    if (!Number.isInteger(range[field]) || Number(range[field]) < 0 || Number(range[field]) > 0xffff_ffff) {
      throw new Error(`${label}.${field} is outside uint32`);
    }
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  if (required.some((key) => !(key in value))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function requireSortedUnique(values: readonly string[], label: string): void {
  const canonical = [...new Set(values)].sort(compare);
  if (canonical.length !== values.length
    || canonical.some((value, index) => value !== values[index])) {
    throw new Error(`${label} must be sorted and unique`);
  }
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
