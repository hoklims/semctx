import { existsSync } from "node:fs";
import { join } from "node:path";
import { createDefaultConfig } from "@semantic-context/core";
import type { SemctxConfig } from "@semantic-context/core";
import { isInitialized, loadConfig, saveConfig, openStore, semctxDir } from "@semantic-context/repository-store";
import { analyzeAndBuildClaims } from "@semantic-context/context-engine";
import { initSemanticScaffold, loadSemanticModel, checkSemanticModel, type RepositoryFacts } from "@semantic-context/semantic-engine";
import { runPreset } from "./preset";
import type { ParsedArgs } from "../args";
import { flagBool, flagString } from "../args";
import { info, heading, success, warn, fail, json, c, nowIso } from "../output";

/** A layout-aware default config: a monorepo also indexes package sources, so `index` finds symbols. */
function smartConfig(root: string): SemctxConfig {
  const hasPackages = existsSync(join(root, "packages"));
  return {
    ...createDefaultConfig(root),
    include: hasPackages ? ["packages/*/src/**/*.ts", "src/**/*.ts"] : ["src/**/*.ts"],
  };
}

/**
 * `semctx setup` — one command that makes a repository ready: config + graph index + semantic
 * scaffold + validation. Idempotent and non-destructive (never overwrites an existing config or
 * authored `.sem` files). This is the "just works" entry point; everything else is opt-in detail.
 */
export function runSetup(root: string, args: ParsedArgs): number {
  const preset = flagString(args, "preset");
  const asJson = flagBool(args, "json");
  const already = isInitialized(root);

  // 1. config — respect an existing one; otherwise write a layout-aware default (or a full preset).
  if (preset !== undefined) {
    const code = runPreset(root, preset, args);
    if (code !== 0) return code;
  } else if (!already) {
    saveConfig(root, smartConfig(root));
  }
  const config = loadConfig(root);

  // 2. index — build the deterministic graph + claims.
  const { analysis, claims } = analyzeAndBuildClaims(config);
  const store = openStore(root);
  store.saveGraph(analysis.graph, analysis.evidence);
  store.replaceClaims(claims);
  store.setMeta("indexed_at", nowIso());
  const facts: RepositoryFacts = { graph: store.loadGraph(), claims: store.loadClaims(), evidence: store.loadEvidence() };
  store.close();

  // 3. semantic scaffold — create `.semctx/semantic/**` if absent (skips existing files).
  const scaffold = initSemanticScaffold(root, {});
  const created = scaffold.plan.filter((p) => p.action === "create").length;

  // 4. check — validate the authored model + repository links.
  const loaded = loadSemanticModel(root);
  const check = checkSemanticModel({ model: loaded.model, diagnostics: loaded.diagnostics, duplicateIds: loaded.duplicateIds, facts, graphIndexed: true });

  if (asJson) {
    json({
      configWritten: preset !== undefined || !already,
      preset: preset ?? null,
      nodes: analysis.graph.nodes.length,
      edges: analysis.graph.edges.length,
      claims: claims.length,
      semanticFilesCreated: created,
      gitignore: scaffold.gitignore.action,
      check: { ok: check.ok, nodes: check.counts.nodes, changes: check.counts.changes, errors: check.counts.errors },
    });
    return check.ok ? 0 : 1;
  }

  heading("semctx setup");
  info(`  ${c.green("ok")} config        ${already && preset === undefined ? c.dim("(existing, kept)") : c.dim("written")}  ${c.dim(semctxDir(root))}`);
  info(`  ${c.green("ok")} indexed       ${c.bold(String(analysis.graph.nodes.length))} nodes, ${c.bold(String(analysis.graph.edges.length))} edges, ${c.bold(String(claims.length))} claims`);
  info(`  ${c.green("ok")} semantic      ${created > 0 ? `${created} file(s) scaffolded` : c.dim("already present")}  ${c.dim("(.semctx/semantic/, versioned)")}`);
  const checkMark = check.ok ? c.green("ok") : c.red("!!");
  info(`  ${checkMark} check         ${check.ok ? "model consistent" : `${check.counts.errors} error(s) — run 'semctx semantic check'`}`);

  if (analysis.graph.nodes.length === 0) {
    warn("index found 0 nodes — edit .semctx/config.json 'include' globs to match your sources, then re-run 'semctx setup'.");
  }

  info("");
  if (check.ok) {
    success("ready");
    info(c.dim("Next: open a change and verify it —"));
    info(c.dim("  semctx change open change.my-change --preserves <invariant-ids>"));
    info(c.dim("  # edit code, then:"));
    info(c.dim("  semctx change verify change.my-change --base origin/main"));
  } else {
    fail("setup completed with model issues — see 'semctx semantic check'");
  }
  return check.ok ? 0 : 1;
}
