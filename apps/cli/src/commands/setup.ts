import { existsSync } from "node:fs";
import { join } from "node:path";
import { SemctxError, createDefaultConfig, createGlobSelectionConfig } from "@semantic-context/core";
import type { SemctxConfig } from "@semantic-context/core";
import { isInitialized, loadConfig, saveConfig, semctxDir } from "@semantic-context/repository-store";
import { indexRepository, openReadyRepository } from "@semantic-context/app-services";
import { countTypeScriptFiles, discoverRepository } from "@semantic-context/ts-analyzer";
import { initSemanticScaffold, loadSemanticModel, checkSemanticModel, type RepositoryFacts } from "@semantic-context/semantic-engine";
import { runPreset } from "./preset";
import type { ParsedArgs } from "../args";
import { flagBool, flagString } from "../args";
import { info, heading, success, warn, fail, json, c, nowIso } from "../output";

/** A layout-aware default config: a monorepo also indexes package sources, so `index` finds symbols. */
function smartConfig(root: string, polyglot: boolean): SemctxConfig {
  if (polyglot) return createGlobSelectionConfig(root);
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
  const polyglot = flagBool(args, "polyglot");
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
    saveConfig(root, smartConfig(root, polyglot));
  }
  const config = loadConfig(root);
  if (already && polyglot && config.version !== 2) {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      "--polyglot does not overwrite an existing v1 config; migrate .semctx/config.json explicitly",
      { configVersion: config.version },
    );
  }
  line(`  ${c.green("ok")} config    ${already && preset === undefined ? c.dim("existing, kept") : c.dim("written to " + semctxDir(root))}`);

  // 2. semantic scaffold — establish Plane B before the index captures its sealed snapshot.
  const scaffold = initSemanticScaffold(root, {});
  const created = scaffold.plan.filter((p) => p.action === "create").length;
  line(`  ${c.green("ok")} semantic  ${created > 0 ? `${created} file(s) scaffolded ${c.dim("(.semctx/semantic/, versioned)")}` : c.dim("already present")}`);

  // 3. index — announce the exact selected scope before the blocking analysis.
  const discovery = discoverRepository(config);
  const fileCount = countTypeScriptFiles(config);
  const selectedCount = discovery.files.length;
  const selectedByLanguage = Object.fromEntries(
    ["typescript", "python", "markdown", "sql"].map((language) => [
      language,
      discovery.files.filter((file) =>
        (file.language ?? (/\.(?:ts|tsx|mts|cts)$/.test(file.relPath) ? "typescript"
          : /\.mdx?$/.test(file.relPath) ? "markdown"
            : /\.sql$/.test(file.relPath) ? "sql"
              : "unknown")) === language
      ).length,
    ]),
  );
  if (selectedCount === 0) {
    line(`  ${c.yellow("!!")} index     ${c.yellow("no analyzable files selected")} under ${root}`);
  } else {
    line(
      `  ${c.dim("··")} index     analyzing ${c.bold(String(selectedCount))} selected file(s) `
      + `${c.dim(`(${Object.entries(selectedByLanguage).filter(([, count]) => count > 0).map(([language, count]) => `${language}:${count}`).join(", ")})`)}…`
      + `${selectedCount > 1500 ? c.dim("  (large repo — add generated/vendor dirs to config 'exclude')") : ""}`,
    );
  }
  const t0 = Date.now();
  const { analysis, claims, freshnessSeal } = indexRepository(root, nowIso());
  const reader = openReadyRepository(root);
  let facts: RepositoryFacts;
  try {
    facts = { graph: reader.loadGraph(), claims: reader.loadClaims(), evidence: reader.loadEvidence() };
  } finally {
    reader.close();
  }
  line(`  ${c.green("ok")} index     ${c.bold(String(analysis.graph.nodes.length))} nodes, ${c.bold(String(analysis.graph.edges.length))} edges, ${c.bold(String(claims.length))} claims  ${c.dim(`(${elapsed(t0)})`)}`);

  // 4. check — validate the authored model + repository links.
  const loaded = loadSemanticModel(root);
  const check = checkSemanticModel({ model: loaded.model, diagnostics: loaded.diagnostics, duplicateIds: loaded.duplicateIds, facts, graphIndexed: true });
  line(`  ${check.ok ? c.green("ok") : c.red("!!")} check     ${check.ok ? "model consistent" : `${check.counts.errors} error(s)`}`);

  if (asJson) {
    json({
      configWritten: preset !== undefined || !already,
      preset: preset ?? null,
      sourceFiles: fileCount,
      selectedFiles: selectedCount,
      selection: {
        configVersion: config.version,
        mode: config.version === 2 ? config.selectionMode : "legacy-v1",
        selectedByLanguage,
        excluded: discovery.candidates.filter((candidate) => candidate.selectionDecision === "excluded").length,
        disabled: discovery.candidates.filter((candidate) => candidate.analysisOutcome === "disabled").length,
        unsupported: discovery.candidates.filter((candidate) => candidate.analysisOutcome === "unsupported").length,
        failed: discovery.candidates.filter((candidate) => candidate.analysisOutcome === "failed").length,
      },
      nodes: analysis.graph.nodes.length,
      edges: analysis.graph.edges.length,
      claims: claims.length,
      freshnessSeal,
      semanticFilesCreated: created,
      gitignore: scaffold.gitignore.action,
      check: { ok: check.ok, nodes: check.counts.nodes, changes: check.counts.changes, errors: check.counts.errors },
    });
    return check.ok ? 0 : 1;
  }

  info("");
  if (analysis.graph.nodes.length === 0) {
    warn(
      config.version === 1
        ? "index found 0 nodes — config v1 keeps legacy discovery and does not apply include; use 'semctx setup --polyglot' in a new workspace or migrate explicitly to config v2."
        : "index found 0 nodes — review v2 include/exclude globs and language modes, then re-run 'semctx setup'.",
    );
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
