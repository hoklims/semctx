import { evidenceId, compareIds } from "@semantic-context/core";
import type {
  RepositoryGraph,
  RepositoryNode,
  Claim,
  EvidenceRecord,
  EvidenceRef,
  EdgeKind,
  NodeKind,
} from "@semantic-context/core";
import { GraphIndex } from "./graph-index";

export type InspectKind = "symbol" | "capability" | "invariant" | "contract" | "test" | "document" | "any";

export interface InspectRelation {
  from: string;
  fromName: string;
  kind: EdgeKind;
  to: string;
  toName: string;
}

export interface InspectionResult {
  query: string;
  kind: InspectKind;
  matchedNodes: RepositoryNode[];
  relatedClaims: Claim[];
  relations: InspectRelation[];
  contradictions: Claim[];
  evidence: EvidenceRecord[];
  filesToRead: string[];
}

const KIND_MAP: Record<Exclude<InspectKind, "any">, NodeKind[]> = {
  symbol: ["function", "class", "interface", "type", "enum"],
  capability: ["capability"],
  invariant: ["invariant"],
  contract: ["contract"],
  test: ["test"],
  document: ["document"],
};

function evIdOf(ref: EvidenceRef): string {
  return evidenceId(ref.sourceKind, ref.filePath, ref.startLine, ref.endLine);
}

/** Inspect the graph around a query. Reused by the CLI and the MCP `semctx_inspect`. */
export function inspectGraph(args: {
  graph: RepositoryGraph;
  claims: Claim[];
  evidence: EvidenceRecord[];
  query: string;
  kind?: InspectKind;
}): InspectionResult {
  const kind: InspectKind = args.kind ?? "any";
  const index = new GraphIndex(args.graph);
  const needle = args.query.toLowerCase();
  const allowedKinds = kind === "any" ? undefined : new Set<NodeKind>(KIND_MAP[kind]);

  const matchedNodes = args.graph.nodes
    .filter((n) => (allowedKinds === undefined || allowedKinds.has(n.kind)))
    .filter((n) => n.name.toLowerCase().includes(needle) || n.id.toLowerCase().includes(needle))
    .sort((a, b) => compareIds(a.id, b.id));
  const matchedIds = new Set(matchedNodes.map((n) => n.id));

  const relatedClaims = args.claims
    .filter((c) => c.subjectNodeIds.some((id) => matchedIds.has(id)))
    .sort((a, b) => b.authority - a.authority || compareIds(a.id, b.id));

  const relations: InspectRelation[] = [];
  for (const edge of args.graph.edges) {
    if (!matchedIds.has(edge.from) && !matchedIds.has(edge.to)) continue;
    relations.push({
      from: edge.from,
      fromName: index.node(edge.from)?.name ?? edge.from,
      kind: edge.kind,
      to: edge.to,
      toName: index.node(edge.to)?.name ?? edge.to,
    });
  }

  const contradictions = relatedClaims.filter(
    (c) => c.verificationStatus === "deprecated" || c.verificationStatus === "contradicted",
  );

  const referenced = new Set<string>();
  for (const c of relatedClaims) for (const id of c.evidenceIds) referenced.add(id);
  for (const n of matchedNodes) for (const ref of n.evidence) referenced.add(evIdOf(ref));
  const evidence = args.evidence.filter((e) => referenced.has(e.id)).sort((a, b) => compareIds(a.id, b.id));

  const filesToRead = [...new Set(matchedNodes.map((n) => n.filePath).filter((p): p is string => p !== undefined))].sort();

  return { query: args.query, kind, matchedNodes, relatedClaims, relations, contradictions, evidence, filesToRead };
}
