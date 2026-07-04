import { SemctxError } from "@semantic-context/core";
import { openStore } from "@semantic-context/repository-store";
import { inspectGraph, type InspectKind } from "@semantic-context/context-engine";
import type { ParsedArgs } from "../args";
import { flagBool } from "../args";
import { info, heading, json, c, warn } from "../output";

const KINDS: readonly InspectKind[] = ["symbol", "capability", "invariant", "contract", "test", "document", "any"];

/** `semctx inspect <kind> <query>` — inspect the graph around a symbol/capability/etc. */
export function runInspect(root: string, args: ParsedArgs): number {
  const kindArg = args.positionals[1];
  const query = args.positionals[2];
  if (query === undefined) {
    throw new SemctxError("UNSUPPORTED", "usage: semctx inspect <symbol|capability|invariant|contract|test|document> <query>");
  }
  const kind: InspectKind = KINDS.includes(kindArg as InspectKind) ? (kindArg as InspectKind) : "any";
  if (kindArg !== undefined && !KINDS.includes(kindArg as InspectKind)) {
    warn(`unknown inspect kind "${kindArg}", searching all kinds`);
  }

  const store = openStore(root);
  if (!store.isIndexed()) {
    store.close();
    throw new SemctxError("REPO_NOT_INDEXED", "repository is not indexed; run 'semctx index' first");
  }
  const result = inspectGraph({
    graph: store.loadGraph(),
    claims: store.loadClaims(),
    evidence: store.loadEvidence(),
    query,
    kind,
  });
  store.close();

  if (flagBool(args, "json")) {
    json(result);
    return 0;
  }

  heading(`Inspect "${query}" (kind=${kind})`);
  heading("Matched nodes");
  if (result.matchedNodes.length === 0) info(c.dim("  no matches"));
  for (const node of result.matchedNodes) info(`  ${c.cyan(node.kind)} ${node.name} ${c.dim(node.filePath ?? node.id)}`);

  heading("Related claims (by authority)");
  for (const claim of result.relatedClaims) info(`  (${claim.kind}/${claim.verificationStatus}) ${claim.statement}`);
  if (result.relatedClaims.length === 0) info(c.dim("  none"));

  heading("Relations");
  for (const rel of result.relations.slice(0, 40)) info(`  ${rel.fromName} ${c.dim(`--${rel.kind}-->`)} ${rel.toName}`);
  if (result.relations.length > 40) info(c.dim(`  ... and ${result.relations.length - 40} more`));

  if (result.contradictions.length > 0) {
    heading("Contradictory / deprecated sources (non-normative)");
    for (const con of result.contradictions) info(`  ${c.yellow("~")} ${con.statement}`);
  }

  heading("Files to read");
  for (const file of result.filesToRead) info(`  ${c.green(file)}`);
  if (result.filesToRead.length === 0) info(c.dim("  none"));
  return 0;
}
