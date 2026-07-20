import { existsSync } from "node:fs";
import { join } from "node:path";
import { createDefaultConfig } from "@semantic-context/core";
import type { SemctxConfig } from "@semantic-context/core";
import { isInitialized, loadConfig, saveConfig, openStore, semctxDir } from "@semantic-context/repository-store";
import { analyzeAndBuildClaims } from "@semantic-context/app-services";
import { countTypeScriptFiles } from "@semantic-context/ts-analyzer";
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

/** Milliseconds since a start marker, as a short human string. Human output only (never persisted). */
function elapsed(startMs: number): string {
  const ms = Date.now() - startMs;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * `semctx setup` — one command that makes a repository ready: config + graph index + semantic
 * scaffold + validation. Idempotent and non-destructive (never overwrites an existing config or
 * authored `.sem` files). Emits live, phase-by-phase progress so the (potentially slow) index step
 * is never a silent black box.
 */
export function runSetup(root: string, args: ParsedArgs): number {
  const preset = flagString(args, "preset");
  const asJson = flagBool(args, "json");
  const line = (msg: string): void => {
    if (!asJson) info(msg);
  };

  if (!asJson) heading(`semctx setup  ${c.dim("·")}  ${root}`);
  const already = isInitialized(root);

  // 1. config — respect an existing one; otherwise write a layout-aware default (or a full preset).
  if (preset !== undefined) {
    if (!asJson) info(c.dim(`  applying preset "${preset}"…`));
    const code = runPreset(root, preset, args);
    if (code !== 0) return code;
  } else if (!already) {
    saveConfig(root, smartConfig(root));
  }
  const config = loadConfig(root);
  line(`  ${c.green("ok")} config    ${already && preset === undefined ? c.dim("existing, kept") : c.dim("written to " + semctxDir(root))}`);

  // 2. index — announce the scale BEFORE the (blocking, possibly slow) TypeScript analysis.
  // Discovery walks the whole repo (honouring ignored dirs + config.exclude), not config.include.
  const fileCount = countTypeScriptFiles(config);
  if (fileCount === 0) {
    line(`  ${c.yellow("!!")} index     ${c.yellow("no TypeScript files found")} under ${root} (are you in the project root?)`);
  } else {
    line(`  ${c.dim("··")} index     analyzing ${c.bold(String(fileCount))} TypeScript file(s)…${fileCount > 1500 ? c.dim("  (large repo — add big/generated dirs to config 'exclude' to speed this up)") : ""}`);
  }
  const t0 = Date.now();
  const { analysis, claims } = analyzeAndBuildClaims(config);
  const store = openStore(root);
  store.saveGraph(analysis.graph, analysis.evidence);
  store.replaceClaims(claims);
  store.setMeta("indexed_at", nowIso());
  const facts: RepositoryFacts = { graph: store.loadGraph(), claims: store.loadClaims(), evidence: store.loadEvidence() };
  store.close();
  line(`  ${c.green("ok")} index     ${c.bold(String(analysis.graph.nodes.length))} nodes, ${c.bold(String(analysis.graph.edges.length))} edges, ${c.bold(String(claims.length))} claims  ${c.dim(`(${elapsed(t0)})`)}`);

  // 3. semantic scaffold — create `.semctx/semantic/**` if absent (skips existing files).
  const scaffold = initSemanticScaffold(root, {});
  const created = scaffold.plan.filter((p) => p.action === "create").length;
  line(`  ${c.green("ok")} semantic  ${created > 0 ? `${created} file(s) scaffolded ${c.dim("(.semctx/semantic/, versioned)")}` : c.dim("already present")}`);

  // 4. check — validate the authored model + repository links.
  const loaded = loadSemanticModel(root);
  const check = checkSemanticModel({ model: loaded.model, diagnostics: loaded.diagnostics, duplicateIds: loaded.duplicateIds, facts, graphIndexed: true });
  line(`  ${check.ok ? c.green("ok") : c.red("!!")} check     ${check.ok ? "model consistent" : `${check.counts.errors} error(s)`}`);

  if (asJson) {
    json({
      configWritten: preset !== undefined || !already,
      preset: preset ?? null,
      sourceFiles: fileCount,
      nodes: analysis.graph.nodes.length,
      edges: analysis.graph.edges.length,
      claims: claims.length,
      semanticFilesCreated: created,
      gitignore: scaffold.gitignore.action,
      check: { ok: check.ok, nodes: check.counts.nodes, changes: check.counts.changes, errors: check.counts.errors },
    });
    return check.ok ? 0 : 1;
  }

  info("");
  if (analysis.graph.nodes.length === 0) {
    warn("index found 0 nodes — edit .semctx/config.json 'include' globs to match your sources, then re-run 'semctx setup'.");
  }
  if (check.ok) {
    success("ready");
    info(c.dim("Next: open a change and verify it —"));
    info(c.dim("  semctx change open change.my-change --preserves <invariant-ids>"));
    info(c.dim("  # edit code, then:  semctx change verify change.my-change --base origin/main"));
  } else {
    fail("setup completed with model issues — run 'semctx semantic check' for details");
  }
  return check.ok ? 0 : 1;
}
