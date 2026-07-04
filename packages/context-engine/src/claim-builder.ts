import { claimId, evidenceId, compareIds } from "@semantic-context/core";
import type {
  Claim,
  ClaimKind,
  VerificationStatus,
  EvidenceRef,
  RepositoryNode,
} from "@semantic-context/core";
import { GraphIndex } from "./graph-index";
import { AUTHORITY_BY_STATUS, FRESHNESS_BY_STATUS, computeConfidence } from "./scoring";

function evIdOf(ref: EvidenceRef): string {
  return evidenceId(ref.sourceKind, ref.filePath, ref.startLine, ref.endLine);
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

function collectEvidence(index: GraphIndex, nodeIds: readonly string[]): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  for (const id of nodeIds) {
    const node = index.node(id);
    if (node !== undefined) refs.push(...node.evidence);
  }
  return refs;
}

function makeClaim(
  kind: ClaimKind,
  statement: string,
  subjectNodeIds: string[],
  evidenceRefs: EvidenceRef[],
  status: VerificationStatus,
  tags: string[],
): Claim {
  const authority = AUTHORITY_BY_STATUS[status];
  const freshness = FRESHNESS_BY_STATUS[status];
  const distinct = new Set(evidenceRefs.map((r) => r.sourceKind)).size;
  return {
    id: claimId(kind, statement, subjectNodeIds),
    kind,
    statement,
    subjectNodeIds: uniq(subjectNodeIds),
    evidenceIds: uniq(evidenceRefs.map(evIdOf)),
    authority,
    freshness,
    confidence: computeConfidence(authority, freshness, distinct),
    verificationStatus: status,
    tags,
  };
}

function isTested(index: GraphIndex, symbolId: string): boolean {
  return index.outEdges(symbolId, ["tested_by"]).length > 0;
}

/**
 * Derive verifiable claims from the repository graph. Verification status is computed
 * from evidence, never asserted: an exported type is statically_verified; an invariant
 * whose constrained symbol has a test is tested; a deprecated doc yields a deprecation
 * claim; a contradicts edge yields a contradicted assumption.
 */
export function buildClaims(index: GraphIndex): Claim[] {
  const claims: Claim[] = [];

  // Invariants: strongest domain claims.
  for (const inv of index.nodesOfKind("invariant")) {
    const constrained = index.inEdges(inv.id, ["constrained_by"]).map((e) => e.from);
    const subject = [inv.id, ...constrained];
    const status: VerificationStatus = constrained.some((s) => isTested(index, s))
      ? "tested"
      : inv.tags.includes("from-doc")
        ? "documented"
        : "inferred";
    const statement =
      typeof inv.metadata["statement"] === "string" ? (inv.metadata["statement"] as string) : `Invariant: ${inv.name}`;
    const evidence = collectEvidence(index, subject);
    claims.push(makeClaim("invariant", statement, subject, evidence, status, ["invariant", ...inv.tags]));
  }

  // Capabilities: which symbols implement a business capability.
  for (const cap of index.nodesOfKind("capability")) {
    const implementers = index.inEdges(cap.id, ["implements_capability"]).map((e) => e.from);
    if (implementers.length === 0 && !cap.tags.includes("from-doc")) continue;
    const subject = [cap.id, ...implementers];
    const status: VerificationStatus = implementers.some((s) => isTested(index, s))
      ? "tested"
      : cap.tags.includes("from-code")
        ? "documented"
        : "inferred";
    const evidence = collectEvidence(index, subject);
    claims.push(
      makeClaim("capability", `Capability "${cap.name}" is implemented by ${implementers.length} symbol(s).`, subject, evidence, status, [
        "capability",
      ]),
    );
  }

  // Contracts: explicit @contract markers + exported interfaces/types (compiler-enforced).
  for (const contract of index.nodesOfKind("contract")) {
    const declarers = index.inEdges(contract.id, ["declares"]).map((e) => e.from);
    const subject = [contract.id, ...declarers];
    const statement =
      typeof contract.metadata["statement"] === "string"
        ? (contract.metadata["statement"] as string)
        : `Contract: ${contract.name}`;
    const evidence = collectEvidence(index, subject);
    claims.push(makeClaim("contract", statement, subject, evidence, "statically_verified", ["contract"]));
  }
  for (const node of [...index.nodesOfKind("interface"), ...index.nodesOfKind("type")]) {
    if (node.exported !== true) continue;
    claims.push(
      makeClaim(
        "contract",
        `Exported ${node.kind} "${node.name}" is a public, compiler-enforced contract.`,
        [node.id],
        node.evidence,
        "statically_verified",
        ["contract", "exported"],
      ),
    );
  }

  // Behaviours proven by tests.
  for (const test of index.nodesOfKind("test")) {
    const covered = index.outEdges(test.id, ["covers"]).map((e) => e.to);
    if (covered.length === 0) continue;
    const evidence = collectEvidence(index, [test.id, ...covered]);
    claims.push(
      makeClaim("behavior", `Behaviour covered by test ${test.name}.`, [test.id, ...covered], evidence, "tested", ["behavior"]),
    );
  }

  // Decisions from ADRs.
  for (const decision of index.nodesOfKind("decision")) {
    const statement =
      typeof decision.metadata["statement"] === "string" ? (decision.metadata["statement"] as string) : decision.name;
    claims.push(makeClaim("decision", statement, [decision.id], decision.evidence, "documented", ["decision"]));
  }

  // Risks (explicit @risk markers).
  for (const risk of index.nodesOfKind("risk")) {
    const related = index.inEdges(risk.id, ["related_to"]).map((e) => e.from);
    const statement = typeof risk.metadata["statement"] === "string" ? (risk.metadata["statement"] as string) : `Risk: ${risk.name}`;
    const subject = [risk.id, ...related];
    claims.push(makeClaim("risk", statement, subject, collectEvidence(index, subject), "inferred", ["risk"]));
  }

  claims.push(...buildDocumentationClaims(index));

  return claims.sort((a, b) => compareIds(a.id, b.id));
}

/** Deprecated / contradicting documents become non-normative claims, never authoritative. */
function buildDocumentationClaims(index: GraphIndex): Claim[] {
  const claims: Claim[] = [];
  for (const doc of index.nodesOfKind("document")) {
    const deprecated = doc.metadata["deprecated"] === true || doc.tags.includes("deprecated");
    const contradicts = index.outEdges(doc.id, ["contradicts"]);
    if (deprecated) {
      claims.push(
        makeClaim(
          "deprecation",
          `Deprecated documentation "${doc.name}" — its assertions are no longer authoritative.`,
          [doc.id],
          doc.evidence,
          "deprecated",
          ["deprecation", "documentation"],
        ),
      );
    }
    for (const edge of contradicts) {
      const target = index.node(edge.to);
      const targetName = target?.name ?? edge.to;
      claims.push(
        makeClaim(
          "assumption",
          `Documentation "${doc.name}" contradicts "${targetName}".`,
          [doc.id, edge.to],
          [...doc.evidence, ...edge.evidence],
          "contradicted",
          ["contradiction", "documentation"],
        ),
      );
    }
  }
  return claims;
}

/** Nodes referenced as claim subjects, for pack node selection. */
export function subjectNodes(index: GraphIndex, claim: Claim): RepositoryNode[] {
  const nodes: RepositoryNode[] = [];
  for (const id of claim.subjectNodeIds) {
    const node = index.node(id);
    if (node !== undefined) nodes.push(node);
  }
  return nodes;
}
