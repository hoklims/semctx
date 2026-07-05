/** Inspect a single semantic id: its declaration, who references it, and how its links resolve. */

import { compareIds } from "@semantic-context/core";
import type { SemanticModel, SemanticNode, ChangeContract } from "@semantic-context/semantic-model";
import type { RepositoryFacts, LinkResolution } from "./links";
import { resolveRepositoryLinks } from "./links";

export interface IncomingReference {
  from: string;
  field: string;
}

export interface SemanticInspection {
  id: string;
  found: boolean;
  node?: SemanticNode;
  change?: ChangeContract;
  incoming: IncomingReference[];
  linkResolutions: LinkResolution[];
}

function incomingReferences(model: SemanticModel, id: string): IncomingReference[] {
  const out: IncomingReference[] = [];
  for (const node of model.nodes) for (const rel of node.relations) if (rel.to === id) out.push({ from: node.id, field: rel.kind });
  for (const change of model.changes) {
    for (const to of change.serves) if (to === id) out.push({ from: change.id, field: "serves" });
    for (const to of change.preserves) if (to === id) out.push({ from: change.id, field: "preserves" });
    for (const to of change.requiresEvidence) if (to === id) out.push({ from: change.id, field: "requires_evidence" });
    for (const to of change.openUnknowns) if (to === id) out.push({ from: change.id, field: "unknown" });
  }
  return out.sort((a, b) => compareIds(a.from, b.from) || compareIds(a.field, b.field));
}

export function inspectSemantic(model: SemanticModel, id: string, facts?: RepositoryFacts): SemanticInspection {
  const node = model.nodes.find((n) => n.id === id);
  const change = model.changes.find((c) => c.id === id);
  const owner = node ?? change;
  let linkResolutions: LinkResolution[] = [];
  if (owner !== undefined && facts !== undefined) {
    linkResolutions = resolveRepositoryLinks({ nodes: node !== undefined ? [node] : [], changes: change !== undefined ? [change] : [] }, facts).resolutions;
  }
  return {
    id,
    found: owner !== undefined,
    ...(node !== undefined ? { node } : {}),
    ...(change !== undefined ? { change } : {}),
    incoming: incomingReferences(model, id),
    linkResolutions,
  };
}
