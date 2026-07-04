import { loadConfig, openStore } from "@semantic-context/repository-store";
import { analyzeAndBuildClaims } from "@semantic-context/context-engine";
import type { RepositoryNode, Claim } from "@semantic-context/core";
import type { ParsedArgs } from "../args";
import { flagBool } from "../args";
import { info, success, heading, json, c, nowIso } from "../output";

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** `semctx index` — analyse the repo, (re)build the graph + claims, persist them. */
export function runIndex(root: string, args: ParsedArgs): number {
  const config = loadConfig(root);
  const { analysis, claims } = analyzeAndBuildClaims(config);

  const store = openStore(root);
  store.saveGraph(analysis.graph, analysis.evidence);
  store.replaceClaims(claims);
  store.setMeta("indexed_at", nowIso());
  store.close();

  const nodeKinds = countBy<RepositoryNode>(analysis.graph.nodes, (n) => n.kind);
  const claimKinds = countBy<Claim>(claims, (c2) => c2.kind);

  if (flagBool(args, "json")) {
    json({
      indexed: true,
      nodes: analysis.graph.nodes.length,
      edges: analysis.graph.edges.length,
      evidence: analysis.evidence.length,
      claims: claims.length,
      nodeKinds,
      claimKinds,
    });
    return 0;
  }

  success(
    `indexed ${c.bold(String(analysis.graph.nodes.length))} nodes, ${c.bold(String(analysis.graph.edges.length))} edges, ${c.bold(String(claims.length))} claims`,
  );
  heading("Nodes by kind");
  for (const [kind, count] of Object.entries(nodeKinds).sort()) info(`  ${kind.padEnd(18)} ${count}`);
  heading("Claims by kind");
  for (const [kind, count] of Object.entries(claimKinds).sort()) info(`  ${kind.padEnd(18)} ${count}`);
  info("");
  info(c.dim("Next: semctx task create --from-file <task.md>"));
  return 0;
}
