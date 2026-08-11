import { indexRepository } from "@semantic-context/app-services";
import type { RepositoryNode, Claim } from "@semantic-context/core";
import type { ParsedArgs } from "../args";
import { flagBool } from "../args";
import { info, success, warn, heading, json, c, nowIso } from "../output";

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
  const { analysis, claims, freshnessSeal } = indexRepository(root, nowIso());

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
      unresolvedReferences: analysis.unresolvedReferences,
      freshnessSeal,
    });
    return 0;
  }

  success(
    `indexed ${c.bold(String(analysis.graph.nodes.length))} nodes, ${c.bold(String(analysis.graph.edges.length))} edges, ${c.bold(String(claims.length))} claims`,
  );
  info(c.dim(`seal ${freshnessSeal.sealHash}`));
  heading("Nodes by kind");
  for (const [kind, count] of Object.entries(nodeKinds).sort()) info(`  ${kind.padEnd(18)} ${count}`);
  heading("Claims by kind");
  for (const [kind, count] of Object.entries(claimKinds).sort()) info(`  ${kind.padEnd(18)} ${count}`);
  // An authored reference to an absent target is a real gap in the model: name it rather than
  // letting the edge disappear from the graph without a trace.
  if (analysis.unresolvedReferences.length > 0) {
    heading("Unresolved authored references");
    warn(`  ${analysis.unresolvedReferences.length} declared reference(s) name a target this repository does not contain`);
    for (const reference of analysis.unresolvedReferences) {
      info(c.dim(`  ${reference.from} —${reference.kind}→ ${reference.missing}`));
    }
  }
  info("");
  info(c.dim("Next: semctx task create --from-file <task.md>"));
  return 0;
}
