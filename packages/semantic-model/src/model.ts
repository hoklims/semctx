/** Pure, deterministic helpers over a `SemanticModel`. No I/O. */

import { compareIds } from "@semantic-context/core";
import type { SemanticModel, SemanticNode, ChangeContract, SemanticNodeKind } from "./types";

export function emptyModel(): SemanticModel {
  return { nodes: [], changes: [], refinementRelations: [] };
}

/** In-memory lookups over a model, with deterministic ordering preserved by the caller. */
export class SemanticIndex {
  private readonly nodeById = new Map<string, SemanticNode>();
  private readonly changeById = new Map<string, ChangeContract>();

  constructor(model: SemanticModel) {
    for (const node of model.nodes) this.nodeById.set(node.id, node);
    for (const change of model.changes) this.changeById.set(change.id, change);
  }

  node(id: string): SemanticNode | undefined {
    return this.nodeById.get(id);
  }

  change(id: string): ChangeContract | undefined {
    return this.changeById.get(id);
  }

  /** Any authored entity (truth node or change contract) by id. */
  has(id: string): boolean {
    return this.nodeById.has(id) || this.changeById.has(id);
  }

  nodesOfKind(kind: SemanticNodeKind): SemanticNode[] {
    return [...this.nodeById.values()].filter((n) => n.kind === kind).sort((a, b) => compareIds(a.id, b.id));
  }

  allNodes(): SemanticNode[] {
    return [...this.nodeById.values()].sort((a, b) => compareIds(a.id, b.id));
  }

  allChanges(): ChangeContract[] {
    return [...this.changeById.values()].sort((a, b) => compareIds(a.id, b.id));
  }
}

/**
 * Merge models deterministically. Later models win on id collision (used to overlay a working
 * change over the versioned set). Output is sorted by id for byte-stable serialisation.
 */
export function mergeModels(...models: SemanticModel[]): SemanticModel {
  const nodeById = new Map<string, SemanticNode>();
  const changeById = new Map<string, ChangeContract>();
  const relationById = new Map<string, NonNullable<SemanticModel["refinementRelations"]>[number]>();
  for (const model of models) {
    for (const node of model.nodes) nodeById.set(node.id, node);
    for (const change of model.changes) changeById.set(change.id, change);
    for (const relation of model.refinementRelations ?? []) relationById.set(relation.id, relation);
  }
  return {
    nodes: [...nodeById.values()].sort((a, b) => compareIds(a.id, b.id)),
    changes: [...changeById.values()].sort((a, b) => compareIds(a.id, b.id)),
    refinementRelations: [...relationById.values()].sort((a, b) => compareIds(a.id, b.id)),
  };
}

/** Every authored id in the model (truth nodes + change contracts). */
export function allSemanticIds(model: SemanticModel): Set<string> {
  const ids = new Set<string>();
  for (const node of model.nodes) ids.add(node.id);
  for (const change of model.changes) ids.add(change.id);
  return ids;
}
