import type {
  RepositoryGraph,
  RepositoryNode,
  RepositoryEdge,
  EdgeKind,
  NodeKind,
  GraphPath,
} from "@semantic-context/core";

export type Direction = "out" | "in" | "both";

/** In-memory adjacency over a RepositoryGraph. Pure reads; deterministic ordering. */
export class GraphIndex {
  private readonly byId = new Map<string, RepositoryNode>();
  private readonly outEdgesByFrom = new Map<string, RepositoryEdge[]>();
  private readonly inEdgesByTo = new Map<string, RepositoryEdge[]>();
  private readonly byKind = new Map<NodeKind, RepositoryNode[]>();
  private readonly byFilePath = new Map<string, RepositoryNode[]>();

  constructor(graph: RepositoryGraph) {
    for (const node of graph.nodes) {
      this.byId.set(node.id, node);
      const list = this.byKind.get(node.kind);
      if (list === undefined) this.byKind.set(node.kind, [node]);
      else list.push(node);
      if (node.filePath !== undefined) {
        const byFile = this.byFilePath.get(node.filePath);
        if (byFile === undefined) this.byFilePath.set(node.filePath, [node]);
        else byFile.push(node);
      }
    }
    for (const edge of graph.edges) {
      const outList = this.outEdgesByFrom.get(edge.from);
      if (outList === undefined) this.outEdgesByFrom.set(edge.from, [edge]);
      else outList.push(edge);
      const inList = this.inEdgesByTo.get(edge.to);
      if (inList === undefined) this.inEdgesByTo.set(edge.to, [edge]);
      else inList.push(edge);
    }
  }

  node(id: string): RepositoryNode | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  nodesOfKind(kind: NodeKind): RepositoryNode[] {
    return this.byKind.get(kind) ?? [];
  }

  nodesByFilePath(filePath: string): RepositoryNode[] {
    return this.byFilePath.get(filePath) ?? [];
  }

  outEdges(id: string, kinds?: readonly EdgeKind[]): RepositoryEdge[] {
    const edges = this.outEdgesByFrom.get(id) ?? [];
    return kinds === undefined ? edges : edges.filter((e) => kinds.includes(e.kind));
  }

  inEdges(id: string, kinds?: readonly EdgeKind[]): RepositoryEdge[] {
    const edges = this.inEdgesByTo.get(id) ?? [];
    return kinds === undefined ? edges : edges.filter((e) => kinds.includes(e.kind));
  }

  /** Nodes on the other end of matching edges, in the given direction. */
  neighbors(id: string, kinds: readonly EdgeKind[], direction: Direction): string[] {
    const result: string[] = [];
    if (direction === "out" || direction === "both") {
      for (const edge of this.outEdges(id, kinds)) result.push(edge.to);
    }
    if (direction === "in" || direction === "both") {
      for (const edge of this.inEdges(id, kinds)) result.push(edge.from);
    }
    return result;
  }

  /** BFS hop distances from a seed set following the given edge kinds/direction. */
  distancesFrom(
    seeds: readonly string[],
    kinds: readonly EdgeKind[],
    direction: Direction,
    maxDepth = 8,
  ): Map<string, number> {
    const dist = new Map<string, number>();
    const queue: string[] = [];
    for (const seed of seeds) {
      if (this.byId.has(seed) && !dist.has(seed)) {
        dist.set(seed, 0);
        queue.push(seed);
      }
    }
    let head = 0;
    while (head < queue.length) {
      const current = queue[head];
      head += 1;
      if (current === undefined) continue;
      const depth = dist.get(current) ?? 0;
      if (depth >= maxDepth) continue;
      for (const next of this.neighbors(current, kinds, direction)) {
        if (!dist.has(next)) {
          dist.set(next, depth + 1);
          queue.push(next);
        }
      }
    }
    return dist;
  }

  /** Enumerate simple call paths from a start node following `calls` edges. */
  callPathsFrom(startId: string, maxDepth = 6): GraphPath[] {
    const paths: GraphPath[] = [];
    const walk = (nodeId: string, trail: string[], edgeTrail: EdgeKind[], seen: Set<string>): void => {
      const outgoing = this.outEdges(nodeId, ["calls"]);
      const nextEdges = outgoing.filter((e) => !seen.has(e.to));
      if (nextEdges.length === 0 || trail.length >= maxDepth) {
        if (trail.length > 1) {
          paths.push({
            nodeIds: [...trail],
            edgeKinds: [...edgeTrail],
            description: this.describePath(trail),
          });
        }
        return;
      }
      for (const edge of nextEdges) {
        seen.add(edge.to);
        walk(edge.to, [...trail, edge.to], [...edgeTrail, "calls"], seen);
        seen.delete(edge.to);
      }
    };
    walk(startId, [startId], [], new Set([startId]));
    return paths;
  }

  private describePath(nodeIds: readonly string[]): string {
    return nodeIds.map((id) => this.byId.get(id)?.name ?? id).join(" -> ");
  }
}
