import { SemctxError } from "@semantic-context/core";
import {
  indexRepository,
  indexRepositoryAsync,
  recoverIndexEvidence,
  recoverIndexEvidenceAsync,
  type IndexRecoveryOutcome,
  type RepositoryIndex,
} from "@semantic-context/app-services";
import type { RepositoryNode, Claim } from "@semantic-context/core";
import type { ParsedArgs } from "../args";
import { flagBool } from "../args";
import { info, success, warn, fail, heading, json, c, nowIso } from "../output";

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
  if (flagBool(args, "record")) {
    return renderIndexRecovery(recoverIndexEvidence(root, nowIso()), args);
  }
  return renderIndex(indexRepository(root, nowIso()), args);
}

export async function runIndexAsync(root: string, args: ParsedArgs): Promise<number> {
  const workers = parseIndexWorkers(args);
  if (flagBool(args, "record")) {
    return renderIndexRecovery(await recoverIndexEvidenceAsync(root, nowIso(), workers), args);
  }
  return renderIndex(await indexRepositoryAsync(root, nowIso(), workers), args);
}

function indexJsonPayload({ analysis, claims, freshnessSeal, parallelism }: RepositoryIndex): Record<string, unknown> {
  return {
    indexed: true,
    nodes: analysis.graph.nodes.length,
    edges: analysis.graph.edges.length,
    evidence: analysis.evidence.length,
    claims: claims.length,
    nodeKinds: countBy<RepositoryNode>(analysis.graph.nodes, (n) => n.kind),
    claimKinds: countBy<Claim>(claims, (c2) => c2.kind),
    unresolvedReferences: analysis.unresolvedReferences,
    freshnessSeal,
    parallelism,
  };
}

function printIndexSummary({ analysis, claims, freshnessSeal, parallelism }: RepositoryIndex): void {
  const nodeKinds = countBy<RepositoryNode>(analysis.graph.nodes, (n) => n.kind);
  const claimKinds = countBy<Claim>(claims, (c2) => c2.kind);
  success(
    `indexed ${c.bold(String(analysis.graph.nodes.length))} nodes, ${c.bold(String(analysis.graph.edges.length))} edges, ${c.bold(String(claims.length))} claims`,
  );
  info(c.dim(`seal ${freshnessSeal.sealHash}`));
  if (parallelism !== undefined) {
    info(c.dim(`TypeScript analysis: ${parallelism.used} worker(s), ${parallelism.mode}`));
  }
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
}

function renderIndex(index: RepositoryIndex, args: ParsedArgs): number {
  if (index.staleEvidenceBaseline) {
    warn("The stale verification baseline was preserved. Run semctx index --record to rebuild, verify and record current evidence.");
  }
  if (flagBool(args, "json")) {
    json(indexJsonPayload(index));
    return 0;
  }
  printIndexSummary(index);
  info("");
  info(c.dim("Next: semctx verify diff --base origin/main"));
  return 0;
}

/** `semctx index --record` — rebuild, verify the working tree, and atomically record evidence. */
function renderIndexRecovery({ index, verification, recordedPath }: IndexRecoveryOutcome, args: ParsedArgs): number {
  const { report } = verification;
  const exit = report.verdict === "BLOCK" ? 3 : 0;

  if (flagBool(args, "json")) {
    json({ ...indexJsonPayload(index), verification: { recorded: true, report } });
    return exit;
  }

  printIndexSummary(index);
  heading("Recovery verification");
  const label =
    report.verdict === "PASS" ? c.green("PASS") : report.verdict === "WARN" ? c.yellow("WARN") : c.red("BLOCK");
  info(`  verdict: ${label}`);
  if (report.unknowns.length > 0) {
    heading("Unknowns");
    for (const unknown of report.unknowns) info(`  ${c.dim("?")} ${unknown}`);
  }
  info("");
  info(c.dim(`recorded verification state -> ${recordedPath}`));
  if (report.verdict === "PASS") success("evidence recorded — no blocking violations");
  else if (report.verdict === "WARN") warn("evidence recorded — non-blocking warnings present");
  else fail("evidence recorded — blocking violations present");
  return exit;
}

export function parseIndexWorkers(args: ParsedArgs): "auto" | number {
  const value = args.flags.get("workers");
  if (value === undefined) return 1;
  if (typeof value !== "string") {
    throw new SemctxError("INVALID_TASK_INPUT", "--workers requires auto or an integer from 1 through 8");
  }
  if (value === "auto") return "auto";
  if (!/^[1-8]$/.test(value)) {
    throw new SemctxError("INVALID_TASK_INPUT", "--workers must be auto or an integer from 1 through 8", {
      workers: value,
    });
  }
  return Number(value);
}
